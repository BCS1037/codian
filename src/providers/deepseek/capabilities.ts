import type { ProviderCapabilities } from '../../core/providers/types';

export const DEEPSEEK_PROVIDER_CAPABILITIES: Readonly<ProviderCapabilities> = Object.freeze({
  providerId: 'deepseek',
  supportsPersistentRuntime: true,
  supportsNativeHistory: true,
  supportsPlanMode: false,
  supportsRewind: false,
  supportsFork: true,
  supportsProviderCommands: true,
  supportsImageAttachments: true,
  supportsInstructionMode: true,
  supportsMcpTools: false,
  supportsSharedAgentSkills: true,
  supportsTurnSteer: true,
  supportsConversationBranches: false,
  reasoningControl: 'effort',
});
