import {
  DEFAULT_DEEPSEEK_PROVIDER_SETTINGS,
  getDeepSeekProviderSettings,
  updateDeepSeekProviderSettings,
} from '@/providers/deepseek/settings';

describe('DeepSeek settings', () => {
  it('returns default settings when unconfigured', () => {
    const settings = getDeepSeekProviderSettings({});
    expect(settings).toEqual(DEFAULT_DEEPSEEK_PROVIDER_SETTINGS);
  });

  it('updates deepseek provider settings', () => {
    const bag: Record<string, unknown> = {};
    updateDeepSeekProviderSettings(bag, {
      enabled: true,
      codeMode: true,
      presetPlugins: 'test: yaml',
    });

    const settings = getDeepSeekProviderSettings(bag);
    expect(settings.enabled).toBe(true);
    expect(settings.codeMode).toBe(true);
    expect(settings.presetPlugins).toBe('test: yaml');
  });

  it('migrates cliPath into cliPathsByHost', () => {
    const bag: Record<string, unknown> = {};
    updateDeepSeekProviderSettings(bag, {
      cliPath: '/custom/path/dsh',
    });

    const settings = getDeepSeekProviderSettings(bag);
    expect(settings.cliPath).toBe('');
    expect(Object.values(settings.cliPathsByHost)).toContain('/custom/path/dsh');
  });
});
