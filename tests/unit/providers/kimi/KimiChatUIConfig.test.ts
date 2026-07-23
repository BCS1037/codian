import { encodeProviderModelSelectionId } from '@/core/providers/modelSelection';
import { kimiChatUIConfig } from '@/providers/kimi/ui/KimiChatUIConfig';

describe('kimiChatUIConfig', () => {
  const settings = {
    providerConfigs: {
      kimi: {
        discoveredModels: [
          { rawId: 'kimi-k2.5', label: 'Kimi K2.5' },
          { rawId: 'kimi-k2.5-thinking', label: 'Kimi K2.5 Thinking' },
        ],
        visibleModels: ['kimi-k2.5-thinking'],
      },
    },
  };

  it('exposes discovered visible Kimi models in the shared model picker', () => {
    expect(kimiChatUIConfig.getModelOptions(settings as any)).toEqual([{
      description: 'Kimi ACP model',
      label: 'Kimi K2.5 Thinking',
      value: encodeProviderModelSelectionId('kimi', 'kimi-k2.5-thinking'),
    }]);
  });

  it('exposes Thinking and Plan controls', () => {
    const model = encodeProviderModelSelectionId('kimi', 'kimi-k2.5-thinking');
    expect(kimiChatUIConfig.getReasoningOptions!(model, settings as any)).toEqual([
      { label: 'Off', value: 'off' },
      { label: 'On', value: 'on' },
    ]);
    expect(kimiChatUIConfig.getPermissionModeToggle!()).toMatchObject({
      activeValue: 'yolo',
      inactiveValue: 'normal',
      planValue: 'plan',
    });
  });
});
