import { DEEPSEEK_PROVIDER_CAPABILITIES } from '@/providers/deepseek/capabilities';

describe('DEEPSEEK_PROVIDER_CAPABILITIES', () => {
  it('exposes the locked DeepSeek capability contract', () => {
    expect(DEEPSEEK_PROVIDER_CAPABILITIES).toEqual({
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
  });
});
