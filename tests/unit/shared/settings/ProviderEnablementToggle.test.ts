import { Notice } from 'obsidian';

import { ProviderRegistry } from '@/core/providers/ProviderRegistry';
import {
  applyProviderEnablement,
  applyProviderEnablementToggle,
} from '@/shared/settings/ProviderEnablementToggle';

jest.mock('obsidian', () => ({
  Notice: jest.fn(),
}));

jest.mock('@/i18n/i18n', () => ({
  t: (key: string) => key,
}));

describe('applyProviderEnablementToggle', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    ProviderRegistry.register('claude', {
      displayOrder: 20,
      isEnabled: (settings: Record<string, unknown>) => (
        settings.providerConfigs as { claude?: { enabled?: boolean } } | undefined
      )?.claude?.enabled ?? true,
      setEnabled: (settings: Record<string, unknown>, enabled: boolean) => {
        settings.providerConfigs = {
          ...(settings.providerConfigs as Record<string, unknown> | undefined),
          claude: { enabled },
        };
      },
    } as any);
  });

  it('restores the toggle and warns when disabling the last enabled provider', async () => {
    const settings: Record<string, unknown> = {
      settingsProvider: 'claude',
      providerConfigs: {
        claude: { enabled: true },
      },
    };
    const toggle = {
      setValue: jest.fn(),
    };
    const context = {
      plugin: {
        settings,
        mutateSettings: jest.fn(async (mutation) => mutation(settings)),
      },
      refreshModelSelectors: jest.fn(),
      refreshTitleGenerationModelOptions: jest.fn(),
    };

    const applied = await applyProviderEnablementToggle(
      context as any,
      toggle as any,
      'claude',
      false,
    );

    expect(applied).toBe(false);
    expect(toggle.setValue).toHaveBeenCalledWith(true);
    expect(Notice).toHaveBeenCalledWith('settings.providerEnablement.atLeastOne');
    expect(context.refreshModelSelectors).not.toHaveBeenCalled();
    expect(context.refreshTitleGenerationModelOptions).not.toHaveBeenCalled();
  });

  it('supports card controls without requiring an Obsidian toggle component', async () => {
    const settings: Record<string, unknown> = {
      settingsProvider: 'claude',
      providerConfigs: { claude: { enabled: true } },
    };
    const context = {
      plugin: {
        settings,
        mutateSettings: jest.fn(async (mutation) => mutation(settings)),
      },
      refreshModelSelectors: jest.fn(),
      refreshTitleGenerationModelOptions: jest.fn(),
    };

    const applied = await applyProviderEnablement(context as any, 'claude', false);

    expect(applied).toBe(false);
    expect(Notice).toHaveBeenCalledWith('settings.providerEnablement.atLeastOne');
  });
});
