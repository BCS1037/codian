import type {
  ProviderWorkspaceRegistration,
  ProviderWorkspaceServices,
} from '../../../core/providers/types';
import { NativeAcpCliResolver } from '../runtime/NativeAcpCliResolver';
import { createNativeAcpSettingsTabRenderer } from '../ui/createNativeAcpSettingsTabRenderer';

export function createNativeAcpWorkspaceRegistration(options: {
  defaultCommand: string;
  displayName: string;
  providerId: string;
}): ProviderWorkspaceRegistration {
  return {
    async initialize(): Promise<ProviderWorkspaceServices> {
      const cliResolver = new NativeAcpCliResolver(options.providerId, options.defaultCommand);
      return {
        cliResolver,
        settingsTabRenderer: createNativeAcpSettingsTabRenderer({
          ...options,
          cliResolver,
        }),
        tabWarmupPolicy: { resolveMode: () => 'none' },
      };
    },
  };
}
