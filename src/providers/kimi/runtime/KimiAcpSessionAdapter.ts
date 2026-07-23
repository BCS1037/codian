import {
  decodeProviderModelSelectionId,
} from '../../../core/providers/modelSelection';
import type { ProviderHost } from '../../../core/providers/ProviderHost';
import { t } from '../../../i18n/i18n';
import type {
  AcpClientConnection,
  AcpNewSessionResponse,
  AcpSessionConfigOption,
} from '../../acp';
import {
  extractAcpSessionModelState,
  extractAcpSessionModeState,
  flattenAcpSessionConfigSelectOptions,
} from '../../acp';
import type { NativeAcpSessionAdapter } from '../../native-acp/runtime/types';
import {
  getKimiProviderSettings,
  updateKimiProviderSettings,
} from '../settings';

type SessionConfigSource = Pick<AcpNewSessionResponse, 'configOptions' | 'models' | 'modes' | 'sessionId'>;

export class KimiAcpSessionAdapter implements NativeAcpSessionAdapter {
  private configOptions: AcpSessionConfigOption[] = [];
  private currentModelId: string | null = null;
  private currentModeId: string | null = null;

  constructor(private readonly plugin: ProviderHost) {}

  async syncSessionConfig(source: SessionConfigSource): Promise<void> {
    this.configOptions = source.configOptions ?? [];
    const modelState = extractAcpSessionModelState(source);
    const modeState = extractAcpSessionModeState(source);
    this.currentModelId = modelState.currentModelId;
    this.currentModeId = modeState.currentModeId;

    const discoveredModels = modelState.availableModels.map(model => ({
      ...(model.description ? { description: model.description } : {}),
      label: model.name,
      rawId: model.id,
    }));
    const availableModes = modeState.availableModes.map(mode => ({
      ...(mode.description ? { description: mode.description } : {}),
      id: mode.id,
      label: mode.name,
    }));
    if (discoveredModels.length === 0 && availableModes.length === 0) return;

    const current = getKimiProviderSettings(this.plugin.settings);
    const visibleModels = current.discoveredModels.length === 0 && current.visibleModels.length === 0
      ? discoveredModels.map(model => model.rawId)
      : current.visibleModels.filter(modelId => discoveredModels.some(model => model.rawId === modelId));
    await this.plugin.mutateSettings((settings) => {
      updateKimiProviderSettings(settings, {
        ...(availableModes.length > 0 ? { availableModes } : {}),
        ...(discoveredModels.length > 0 ? { discoveredModels, visibleModels } : {}),
      });
    });
    this.plugin.refreshModelSelectors?.();
  }

  async applySelections(params: {
    connection: AcpClientConnection;
    model?: string;
    sessionId: string;
  }): Promise<void> {
    const selected = params.model ? decodeProviderModelSelectionId(params.model) : null;
    const selectedModelId = selected?.providerId === 'kimi' ? selected.modelId : null;
    if (selectedModelId && selectedModelId !== this.currentModelId) {
      await this.setConfigOption(params.connection, {
        configId: this.findSelectConfig('model')?.id ?? 'model',
        sessionId: params.sessionId,
        type: 'select',
        value: selectedModelId,
      });
      this.currentModelId = selectedModelId;
    }

    const thinking = this.findThinkingConfig();
    const effort = typeof this.plugin.settings.effortLevel === 'string'
      ? this.plugin.settings.effortLevel
      : '';
    if (thinking?.type === 'boolean' && (effort === 'on' || effort === 'off')) {
      await this.setConfigOption(params.connection, {
        configId: thinking.id,
        sessionId: params.sessionId,
        type: 'boolean',
        value: effort === 'on',
      });
    }

    const permissionMode = this.plugin.settings.permissionMode;
    const modeConfig = this.findSelectConfig('mode');
    if (modeConfig) {
      const modeOptions = flattenAcpSessionConfigSelectOptions(modeConfig.options);
      const planOption = modeOptions.find(option => (
          option.value.toLowerCase() === 'plan' || option.name.toLowerCase() === 'plan'
      ));
      const normalOption = modeOptions.find(option => option.value !== planOption?.value) ?? null;
      const targetMode = permissionMode === 'plan' ? planOption : normalOption;
      if (targetMode && targetMode.value !== this.currentModeId) {
        await this.setConfigOption(params.connection, {
          configId: modeConfig.id,
          sessionId: params.sessionId,
          type: 'select',
          value: targetMode.value,
        });
        this.currentModeId = targetMode.value;
      }
    }
  }

  async handleConfigOptions(configOptions: AcpSessionConfigOption[], sessionId: string): Promise<void> {
    await this.syncSessionConfig({ configOptions, sessionId });
  }

  formatStartError(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    if (/internal error|no model configured|authentication required|auth_required/i.test(message)) {
      return t('settings.kimi.sessionSetupRequired');
    }
    return message;
  }

  private findSelectConfig(category: 'model' | 'mode'): Extract<AcpSessionConfigOption, { type: 'select' }> | null {
    const option = this.configOptions.find(candidate => candidate.type === 'select' && (
      candidate.category?.toLowerCase() === category || candidate.id.toLowerCase() === category
    ));
    return option?.type === 'select' ? option : null;
  }

  private findThinkingConfig(): AcpSessionConfigOption | null {
    return this.configOptions.find(option => (
      option.category?.toLowerCase() === 'thought_level'
      || ['thinking', 'thought_level', 'effort'].includes(option.id.toLowerCase())
    )) ?? null;
  }

  private async setConfigOption(
    connection: AcpClientConnection,
    request: Parameters<AcpClientConnection['setConfigOption']>[0],
  ): Promise<void> {
    const response = await connection.setConfigOption(request);
    this.configOptions = response.configOptions;
  }
}
