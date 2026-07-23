import {
  getKimiProviderSettings,
  updateKimiProviderSettings,
} from '@/providers/kimi/settings';

describe('Kimi settings', () => {
  it('defaults newly discovered models to visible when no selection was stored', () => {
    const settings = {
      providerConfigs: {
        kimi: {
          discoveredModels: [{ label: 'Kimi K2.5', rawId: 'kimi-k2.5' }],
        },
      },
    };

    expect(getKimiProviderSettings(settings).visibleModels).toEqual(['kimi-k2.5']);
  });

  it('preserves an explicit empty visible-model selection', () => {
    const settings: Record<string, unknown> = {
      providerConfigs: {
        kimi: {
          discoveredModels: [{ label: 'Kimi K2.5', rawId: 'kimi-k2.5' }],
          visibleModels: ['kimi-k2.5'],
        },
      },
    };

    updateKimiProviderSettings(settings, { visibleModels: [] });

    expect(getKimiProviderSettings(settings).visibleModels).toEqual([]);
  });
});
