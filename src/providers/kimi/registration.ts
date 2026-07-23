import { createNativeAcpProviderModule } from '../native-acp/createNativeAcpProviderModule';
import { kimiWorkspaceRegistration } from './app/KimiWorkspaceServices';
import { KIMI_PROVIDER_CAPABILITIES } from './capabilities';
import { KimiAcpSessionAdapter } from './runtime/KimiAcpSessionAdapter';
import { kimiChatUIConfig } from './ui/KimiChatUIConfig';

const nativeKimiProviderRegistration = createNativeAcpProviderModule({
  id: 'kimi',
  args: ['acp'],
  displayOrder: 40,
  capabilities: KIMI_PROVIDER_CAPABILITIES,
  displayName: 'Kimi Code',
  defaultCommand: 'kimi',
  chatUIConfig: kimiChatUIConfig,
  createSessionAdapter: plugin => new KimiAcpSessionAdapter(plugin),
  environmentKeyPatterns: [/^KIMI_/i],
});

export const kimiProviderRegistration = {
  ...nativeKimiProviderRegistration,
  workspace: kimiWorkspaceRegistration,
};
