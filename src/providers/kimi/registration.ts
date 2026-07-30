import { getVaultPath } from '../../utils/path';
import { createNativeAcpProviderModule } from '../native-acp/createNativeAcpProviderModule';
import { kimiWorkspaceRegistration } from './app/KimiWorkspaceServices';
import { KIMI_PROVIDER_CAPABILITIES } from './capabilities';
import { KimiAcpSessionAdapter } from './runtime/KimiAcpSessionAdapter';
import { KimiDiagnosticLogger } from './runtime/KimiDiagnosticLogger';
import { getKimiProviderSettings } from './settings';
import { kimiChatUIConfig } from './ui/KimiChatUIConfig';

const nativeKimiProviderRegistration = createNativeAcpProviderModule({
  id: 'kimi',
  args: ['acp'],
  displayOrder: 40,
  capabilities: KIMI_PROVIDER_CAPABILITIES,
  displayName: 'Kimi Code',
  defaultCommand: 'kimi',
  chatUIConfig: kimiChatUIConfig,
  createSessionAdapter: plugin => {
    const vaultPath = plugin.app ? (getVaultPath(plugin.app) ?? process.cwd()) : process.cwd();
    const logger = new KimiDiagnosticLogger(vaultPath);
    const kimiSettings = getKimiProviderSettings(plugin.settings);
    logger.setEnabled(kimiSettings.diagnosticLogging);
    return new KimiAcpSessionAdapter(plugin, logger);
  },
  environmentKeyPatterns: [/^KIMI_/i],
});

export const kimiProviderRegistration = {
  ...nativeKimiProviderRegistration,
  workspace: kimiWorkspaceRegistration,
};
