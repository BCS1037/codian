import { encodeProviderModelSelectionId } from '@/core/providers/modelSelection';
import { kimiChatUIConfig } from '@/providers/kimi/ui/KimiChatUIConfig';

describe('kimiChatUIConfig', () => {
  const settings = {
    providerConfigs: {
      kimi: {
        discoveredModels: [
          { label: 'Kimi K2.5', rawId: 'kimi-k2.5' },
          { label: 'Kimi K2.5 Thinking', rawId: 'kimi-k2.5-thinking' },
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

  it('exposes default Off/On reasoning options when no levels are discovered', () => {
    const model = encodeProviderModelSelectionId('kimi', 'kimi-k2.5-thinking');
    expect(kimiChatUIConfig.getReasoningOptions!(model, settings as any)).toEqual([
      { label: 'Off', value: 'off' },
      { label: 'On', value: 'on' },
    ]);
    expect(kimiChatUIConfig.getDefaultReasoningValue!(model, settings as any)).toBe('off');
    expect(kimiChatUIConfig.getPermissionModeToggle!()).toMatchObject({
      activeLabel: 'Auto',
      activeValue: 'yolo',
      inactiveLabel: 'Safe',
      inactiveValue: 'normal',
      planLabel: 'Plan',
      planValue: 'plan',
    });
  });

  it('exposes dynamic reasoning options when discoveredThinkingLevels exist', () => {
    const settingsWithLevels = {
      providerConfigs: {
        kimi: {
          ...settings.providerConfigs.kimi,
          discoveredThinkingLevels: [
            { label: 'Low', value: 'low' },
            { label: 'High', value: 'high' },
            { label: 'Max', value: 'max' },
          ],
        },
      },
    };
    const model = encodeProviderModelSelectionId('kimi', 'kimi-k2.5-thinking');
    expect(kimiChatUIConfig.getReasoningOptions!(model, settingsWithLevels as any)).toEqual([
      { label: 'Low', value: 'low' },
      { label: 'High', value: 'high' },
      { label: 'Max', value: 'max' },
    ]);
    expect(kimiChatUIConfig.getDefaultReasoningValue!(model, settingsWithLevels as any)).toBe('low');
  });
});
