import type {
  ProviderWorkspaceRegistration,
  ProviderWorkspaceServices,
} from '../../../core/providers/types';
import { NativeAcpCliResolver } from '../../native-acp/runtime/NativeAcpCliResolver';
import { createKimiSettingsTabRenderer } from '../ui/KimiSettingsTab';

export const kimiWorkspaceRegistration: ProviderWorkspaceRegistration = {
  async initialize(): Promise<ProviderWorkspaceServices> {
    const cliResolver = new NativeAcpCliResolver('kimi', 'kimi');
    return {
      cliResolver,
      settingsTabRenderer: createKimiSettingsTabRenderer(cliResolver),
      tabWarmupPolicy: { resolveMode: () => 'none' },
    };
  },
};
