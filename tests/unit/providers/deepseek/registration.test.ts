import '@/providers';

import { ProviderRegistry } from '@/core/providers/ProviderRegistry';
import { deepseekProviderRegistration } from '@/providers/deepseek/registration';

describe('DeepSeek provider registration', () => {
  it('registers deepseek with ProviderRegistry', () => {
    const registeredIds = ProviderRegistry.getRegisteredProviderIds();
    expect(registeredIds).toContain('deepseek');
    expect(ProviderRegistry.getProviderDisplayName('deepseek')).toBe('DeepSeek Harness');
  });

  it('exposes provider module capabilities and hooks', () => {
    expect(deepseekProviderRegistration.id).toBe('deepseek');
    expect(deepseekProviderRegistration.displayName).toBe('DeepSeek Harness');
    expect(deepseekProviderRegistration.displayOrder).toBe(35);
    expect(deepseekProviderRegistration.capabilities.supportsPersistentRuntime).toBe(true);
    expect(deepseekProviderRegistration.chatUIConfig).toBeDefined();
    expect(deepseekProviderRegistration.historyService).toBeDefined();
    expect(deepseekProviderRegistration.taskResultInterpreter).toBeDefined();
  });
});
