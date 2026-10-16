import type { AuxQueryConfig, AuxQueryRunner } from '../../../core/auxiliary/AuxQueryRunner';
import { getRuntimeEnvironmentText } from '../../../core/providers/providerEnvironment';
import type { ProviderHost } from '../../../core/providers/ProviderHost';
import { ProviderSettingsCoordinator } from '../../../core/providers/ProviderSettingsCoordinator';
import { getVaultPath } from '../../../utils/path';
import {
  type AcpRequestPermissionRequest,
  type AcpRequestPermissionResponse,
  type AcpSessionNotification,
  AcpSessionUpdateNormalizer,
  extractAcpSessionModelState,
} from '../../acp';
import { OpencodeHttpClient, type OpencodeHttpClientConnection } from '../http/OpencodeHttpClient';
import { OpencodeHttpSessionConnection } from '../http/OpencodeHttpSessionConnection';
import { decodeOpencodeModelId } from '../models';
import { opencodeChatUIConfig } from '../ui/OpencodeChatUIConfig';
import {
  type OpencodeManagedAgentConfig,
  prepareOpencodeLaunchArtifacts,
} from './OpencodeLaunchArtifacts';
import { buildOpencodeRuntimeEnv } from './OpencodeRuntimeEnvironment';

type OpencodeAuxAgentProfile = 'passive' | 'readonly';
type OpencodeAuxArtifactPurpose = 'inline' | 'instructions' | 'title-gen';

interface OpencodeAuxQueryRunnerOptions {
  agentProfile: OpencodeAuxAgentProfile;
  artifactPurpose: OpencodeAuxArtifactPurpose;
}

const OPENCODE_AUX_AGENT_IDS: Record<OpencodeAuxAgentProfile, string> = {
  passive: 'codian-aux-passive',
  readonly: 'codian-aux-readonly',
};

const OPENCODE_AUX_READ_PERMISSION = Object.freeze({
  '*': 'allow',
  '*.env': 'deny',
  '*.env.*': 'deny',
  '*.env.example': 'allow',
});

export class OpencodeAuxQueryRunner implements AuxQueryRunner {
  private availableModelIds = new Set<string>();
  private connection: OpencodeHttpSessionConnection | null = null;
  private client: OpencodeHttpClientConnection | null = null;
  private currentModelId: string | null = null;
  private currentLaunchKey: string | null = null;
  private readonly notificationListeners = new Set<
    (notification: AcpSessionNotification) => void | Promise<void>
  >();
  private sessionId: string | null = null;
  private readonly sessionUpdateNormalizer = new AcpSessionUpdateNormalizer();

  constructor(
    private readonly plugin: ProviderHost,
    private readonly options: OpencodeAuxQueryRunnerOptions,
  ) {}

  async query(config: AuxQueryConfig, prompt: string): Promise<string> {
    const cwd = getVaultPath(this.plugin.app) ?? process.cwd();
    await this.ensureReady(cwd, config.systemPrompt);

    if (!this.connection) {
      throw new Error('OpenCode runtime is not ready.');
    }

    if (!this.sessionId) {
      const sessionId = await this.createSession(cwd);
      if (!sessionId) {
        throw new Error('Failed to create an OpenCode session.');
      }
    }

    const sessionId = this.sessionId!;
    const selectedModel = this.resolveSelectedRawModel(config.model);
    const nextModel = this.resolveApplicableModel(selectedModel);
    if (nextModel) {
      const response = await this.connection.setConfigOption({
        configId: 'model',
        sessionId,
        type: 'select',
        value: nextModel,
      });
      this.syncSessionModelState({
        configOptions: response.configOptions,
      });
    }

    this.sessionUpdateNormalizer.reset();
    let accumulatedText = '';
    const onNotification = (notification: AcpSessionNotification): void => {
      if (notification.sessionId !== sessionId) {
        return;
      }

      const normalized = this.sessionUpdateNormalizer.normalize(notification.update);
      if (normalized.type !== 'message_chunk' || normalized.role !== 'assistant') {
        return;
      }

      for (const chunk of normalized.streamChunks) {
        if (chunk.type !== 'text') {
          continue;
        }

        accumulatedText += chunk.content;
        config.onTextChunk?.(accumulatedText);
      }
    };
    this.notificationListeners.add(onNotification);

    const abortHandler = () => {
      if (this.connection && this.sessionId) {
        this.connection.cancel({ sessionId: this.sessionId });
      }
    };
    config.abortController?.signal.addEventListener('abort', abortHandler, { once: true });

    try {
      if (config.abortController?.signal.aborted) {
        throw new Error('Cancelled');
      }

      await this.connection.prompt({
        prompt: [{ type: 'text', text: prompt }],
        sessionId,
      });

      if (config.abortController?.signal.aborted) {
        throw new Error('Cancelled');
      }

      return accumulatedText;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'OpenCode request failed';
      throw new Error(
        message,
        error instanceof Error ? { cause: error } : undefined,
      );
    } finally {
      config.abortController?.signal.removeEventListener('abort', abortHandler);
      this.notificationListeners.delete(onNotification);
    }
  }

  reset(): void {
    this.availableModelIds.clear();
    this.sessionId = null;
    this.currentModelId = null;
    this.currentLaunchKey = null;
    void this.connection?.dispose().catch(() => undefined);
    this.connection = null;
    this.client = null;
    this.notificationListeners.clear();
    this.sessionUpdateNormalizer.reset();
  }

  private async ensureReady(cwd: string, systemPrompt: string): Promise<void> {
    const resolvedCliPath = await this.plugin.getResolvedProviderCliPath('opencode') ?? 'opencode';

    const settings = this.plugin.settings as unknown as Record<string, unknown>;
    const runtimeEnv = buildOpencodeRuntimeEnv(settings, resolvedCliPath);
    const auxAgentId = OPENCODE_AUX_AGENT_IDS[this.options.agentProfile];
    const artifacts = await prepareOpencodeLaunchArtifacts({
      artifactsSubdir: `opencode/auxiliary/${this.options.artifactPurpose}`,
      defaultAgentId: auxAgentId,
      managedAgents: [buildOpencodeAuxAgentConfig(this.options.agentProfile)],
      runtimeEnv,
      systemPromptKey: systemPrompt,
      systemPromptText: systemPrompt,
      userName: typeof settings.userName === 'string' ? settings.userName : undefined,
      workspaceRoot: cwd,
    });
    const nextLaunchKey = JSON.stringify({
      artifactKey: artifacts.launchKey,
      command: resolvedCliPath,
      configPath: artifacts.configPath,
      envText: getRuntimeEnvironmentText(settings, 'opencode'),
    });

    const shouldRestart = !this.client
      || !this.client.isAlive
      || this.client.isClosed
      || !this.connection
      || this.currentLaunchKey !== nextLaunchKey;

    if (!shouldRestart) {
      return;
    }

    this.reset();
    await this.startClient({
      command: resolvedCliPath,
      configPath: artifacts.configPath,
      configContent: artifacts.configContent,
      cwd,
      runtimeEnv,
    });
    this.currentLaunchKey = nextLaunchKey;
  }

  private async createSession(cwd: string): Promise<string | null> {
    if (!this.connection) {
      return null;
    }

    try {
      const response = await this.connection.newSession({
        cwd,
        mcpServers: [],
      });
      this.syncSessionModelState({
        configOptions: response.configOptions ?? null,
        models: response.models ?? null,
      });
      await this.connection.setConfigOption({
        configId: 'mode',
        sessionId: response.sessionId,
        type: 'select',
        value: OPENCODE_AUX_AGENT_IDS[this.options.agentProfile],
      });
      this.sessionId = response.sessionId;
      return response.sessionId;
    } catch {
      return null;
    }
  }

  private async startClient(params: {
    command: string;
    configPath: string;
    configContent: string;
    cwd: string;
    runtimeEnv: NodeJS.ProcessEnv;
  }): Promise<void> {
    const processEnv: NodeJS.ProcessEnv = {
      ...process.env,
      ...params.runtimeEnv,
      OPENCODE_CONFIG: params.configPath,
      OPENCODE_CONFIG_CONTENT: params.configContent,
      PATH: params.runtimeEnv.PATH,
    };

    this.client = new OpencodeHttpClient(params.command, params.cwd, processEnv);
    this.connection = new OpencodeHttpSessionConnection(this.client, params.cwd, {
      onSessionNotification: (notification) => {
        for (const listener of this.notificationListeners) void listener(notification);
      },
        requestPermission: (request) => this.handlePermissionRequest(request),
    });
    await this.connection.initialize();
  }

  private async handlePermissionRequest(
    request: AcpRequestPermissionRequest,
  ): Promise<AcpRequestPermissionResponse> {
    return selectPermissionOption(request.options, ['reject_once', 'reject_always']);
  }

  private resolveSelectedRawModel(explicitModel?: string): string | undefined {
    const projectedSettings = ProviderSettingsCoordinator.getProviderSettingsSnapshot(
      this.plugin.settings,
      'opencode',
    );
    if (explicitModel) {
      const trimmed = explicitModel.trim();
      if (!trimmed) {
        return undefined;
      }
      return opencodeChatUIConfig.ownsModel(trimmed, projectedSettings)
        ? decodeOpencodeModelId(trimmed) ?? undefined
        : trimmed;
    }

    const selectedModel = typeof projectedSettings.model === 'string'
      ? projectedSettings.model
      : '';
    return opencodeChatUIConfig.ownsModel(selectedModel, projectedSettings)
      ? decodeOpencodeModelId(selectedModel) ?? undefined
      : undefined;
  }

  private resolveApplicableModel(selectedModel: string | undefined): string | null {
    if (!selectedModel) {
      return null;
    }
    if (selectedModel === this.currentModelId) {
      return null;
    }
    if (this.availableModelIds.size === 0) {
      return selectedModel;
    }
    return this.availableModelIds.has(selectedModel)
      ? selectedModel
      : null;
  }

  private syncSessionModelState(params: {
    configOptions?: Parameters<typeof extractAcpSessionModelState>[0]['configOptions'];
    models?: Parameters<typeof extractAcpSessionModelState>[0]['models'];
  }): void {
    const state = extractAcpSessionModelState(params);
    this.currentModelId = state.currentModelId;
    this.availableModelIds = new Set(state.availableModels.map((model) => model.id));
  }

}

function buildOpencodeAuxAgentConfig(profile: OpencodeAuxAgentProfile): OpencodeManagedAgentConfig {
  const id = OPENCODE_AUX_AGENT_IDS[profile];
  if (profile === 'readonly') {
    return {
      definition: {
        description: 'Internal Codian read-only agent for OpenCode auxiliary tasks.',
        mode: 'primary',
        permission: {
          '*': 'deny',
          codesearch: 'allow',
          external_directory: 'deny',
          glob: 'allow',
          grep: 'allow',
          lsp: 'allow',
          read: OPENCODE_AUX_READ_PERMISSION,
          webfetch: 'allow',
          websearch: 'allow',
        },
      },
      id,
    };
  }

  return {
    definition: {
      description: 'Internal Codian no-tool agent for OpenCode auxiliary tasks.',
      mode: 'primary',
      permission: {
        '*': 'deny',
        external_directory: 'deny',
      },
    },
    id,
  };
}

function selectPermissionOption(
  options: readonly {
    kind: 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always';
    optionId: string;
  }[],
  preferredKinds: readonly ('allow_once' | 'allow_always' | 'reject_once' | 'reject_always')[],
): AcpRequestPermissionResponse {
  for (const kind of preferredKinds) {
    const option = options.find((entry) => entry.kind === kind);
    if (option) {
      return {
        outcome: {
          optionId: option.optionId,
          outcome: 'selected',
        },
      };
    }
  }

  return { outcome: { outcome: 'cancelled' } };
}
