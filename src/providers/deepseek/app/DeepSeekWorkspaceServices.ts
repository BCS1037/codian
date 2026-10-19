import type { ProviderModelCatalogController } from '../../../core/providers/models/ProviderModelCatalog';
import { getRuntimeEnvironmentText } from '../../../core/providers/providerEnvironment';
import type { ProviderHost } from '../../../core/providers/ProviderHost';
import { ProviderWorkspaceRegistry } from '../../../core/providers/ProviderWorkspaceRegistry';
import type {
  ProviderEnvironmentTransition,
  ProviderModelCatalogRefreshResult,
  ProviderTabWarmupPolicy,
  ProviderWorkspaceRegistration,
  ProviderWorkspaceServices,
} from '../../../core/providers/types';
import { parseEnvironmentVariables } from '../../../utils/env';
import { getVaultPath } from '../../../utils/path';
import { DeepSeekCommandCatalog } from '../commands/DeepSeekCommandCatalog';
import { DeepSeekSessionArchiveService } from '../history/DeepSeekSessionArchiveService';
import { DeepSeekCLIResolver } from '../runtime/DeepSeekCLIResolver';
import { DeepSeekHost, type DeepSeekProcessFactory } from '../runtime/DeepSeekHost';
import { DeepSeekHostProcess } from '../runtime/DeepSeekHostProcess';
import { createDeepSeekModels } from '../runtime/DeepSeekModels';
import { parseDeepSeekPresetPlugins } from '../runtime/DeepSeekPresetPlugins';
import { getDeepSeekProviderSettings } from '../settings';
import { createDeepSeekSettingsTabRenderer } from '../ui/DeepSeekSettingsTab';
import { createDeepSeekCommandLoader } from './DeepSeekCommandLoader';

export interface DeepSeekWorkspaceServices extends ProviderWorkspaceServices {
  readonly cliResolver: DeepSeekCLIResolver;
  /** The workspace's single native Host, shared by every DeepSeek session and history read. */
  readonly deepseek: DeepSeekHost;
  readonly modelCatalog: ProviderModelCatalogController;
  refreshModelCatalog(): Promise<ProviderModelCatalogRefreshResult>;
  prepareSettings(): Promise<void>;
  beginAuxiliaryServicesEnvironmentChange(): Promise<ProviderEnvironmentTransition>;
  dispose(): Promise<void>;
}

const deepseekTabWarmupPolicy: ProviderTabWarmupPolicy = {
  resolveMode() {
    return 'commands';
  },
};

export function createDeepSeekWorkspaceServices(
  host: ProviderHost,
  start: DeepSeekProcessFactory = (options, signal) => DeepSeekHostProcess.start(options, signal),
): DeepSeekWorkspaceServices {
  const cliResolver = new DeepSeekCLIResolver();
  const deepseek = new DeepSeekHost(async () => {
    const cliPath = await host.getResolvedProviderCliPath('deepseek');
    if (!cliPath) throw new Error('DeepSeek Harness was not found. Install and configure dsh or DeepSeek Harness Desktop, or set its path in settings.');
    const environment = { ...process.env, ...parseEnvironmentVariables(getRuntimeEnvironmentText(host.settings, 'deepseek')) };
    const presetPlugins = parseDeepSeekPresetPlugins(getDeepSeekProviderSettings(host.settings).presetPlugins);
    return { cliPath, environment, cwd: getVaultPath(host.app) ?? process.cwd(), presetPlugins };
  }, start, undefined, (host as unknown as { sessionToolEndpoint?: unknown }).sessionToolEndpoint as never);
  const modelCatalog = createDeepSeekModels(host, signal => deepseek.read(client => client.call('session/modelCatalog'), signal));
  const sessionArchive = new DeepSeekSessionArchiveService(deepseek);

  return {
    cliResolver,
    deepseek,
    modelCatalog,
    commandCatalog: new DeepSeekCommandCatalog(() => getVaultPath(host.app) ?? undefined),
    runtimeCommandLoader: createDeepSeekCommandLoader(deepseek),
    settingsTabRenderer: createDeepSeekSettingsTabRenderer({ cliResolver, modelCatalog }),
    tabWarmupPolicy: deepseekTabWarmupPolicy,
    async refreshModelCatalog(): Promise<ProviderModelCatalogRefreshResult> {
      return modelCatalog.refresh({ force: true });
    },
    async prepareSettings(): Promise<void> {
      await modelCatalog.refresh();
    },
    async beginAuxiliaryServicesEnvironmentChange(): Promise<ProviderEnvironmentTransition> {
      modelCatalog.beginTransition();
      await sessionArchive.beginTransition();
      await deepseek.beginTransition();
      await modelCatalog.quiesce();
      return {
        release: async () => {
          cliResolver.reset();
          deepseek.endTransition();
          modelCatalog.endTransition();
          sessionArchive.endTransition();
        },
      };
    },
    async dispose(): Promise<void> {
      await Promise.all([modelCatalog.dispose(), sessionArchive.dispose()]);
      await deepseek.dispose();
    },
  };
}

export const deepseekWorkspaceRegistration: ProviderWorkspaceRegistration<DeepSeekWorkspaceServices> = {
  initialize: async ({ plugin }) => createDeepSeekWorkspaceServices(plugin),
};

export function getDeepSeekWorkspaceServices(): DeepSeekWorkspaceServices {
  return ProviderWorkspaceRegistry.requireServices('deepseek') as DeepSeekWorkspaceServices;
}
