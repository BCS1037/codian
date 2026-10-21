import '@/providers';

import { TEST_CODEX_MODEL } from '@test/helpers/codexModels';

import {
  getAllEnabledProviderModelOptions,
  getEnabledProviderForModel,
  getProviderForModel,
} from '@/core/providers/modelRouting';

describe('getProviderForModel', () => {
  it('routes Claude default models to claude', () => {
    expect(getProviderForModel('haiku')).toBe('claude');
    expect(getProviderForModel('sonnet')).toBe('claude');
    expect(getProviderForModel('opus')).toBe('claude');
  });

  it('routes Claude extended models to claude', () => {
    expect(getProviderForModel('claude-sonnet-4-5-20250514')).toBe('claude');
    expect(getProviderForModel('claude-opus-4-6-20250616')).toBe('claude');
  });

  it('routes Codex default models to codex', () => {
    expect(getProviderForModel(TEST_CODEX_MODEL)).toBe('codex');
  });

  it('routes unknown models to claude (default)', () => {
    expect(getProviderForModel('some-unknown-model')).toBe('claude');
  });

  it('routes models starting with gpt- to codex', () => {
    expect(getProviderForModel('gpt-4o')).toBe('codex');
    expect(getProviderForModel('gpt-custom')).toBe('codex');
  });

  it('routes models starting with o prefix to codex', () => {
    expect(getProviderForModel('o3')).toBe('codex');
    expect(getProviderForModel('o4-mini')).toBe('codex');
  });

  it('routes provider-qualified custom model ids without raw name collisions', () => {
    const settings = {
      providerConfigs: {
        claude: {
          customModels: 'deepseek-v4-pro',
        },
        codex: {
          enabled: true,
          customModels: 'deepseek-v4-pro',
        },
      },
    };

    expect(getProviderForModel('claude-code/deepseek-v4-pro', settings)).toBe('claude');
    expect(getProviderForModel('openai-codex/deepseek-v4-pro', settings)).toBe('codex');
  });

  it('routes settings-defined custom Codex models to codex when settings are provided', () => {
    const settings = {
      providerConfigs: {
        codex: {
          enabled: true,
          customModels: 'my-custom-model',
        },
      },
    };

    expect(getProviderForModel('my-custom-model', settings)).toBe('codex');
  });

  it('routes custom OPENAI_MODEL to claude without settings (no context)', () => {
    expect(getProviderForModel('my-custom-model')).toBe('claude');
  });

  it('can resolve blank-tab routing within enabled providers only', () => {
    const settings = {
      settingsProvider: 'claude',
      providerConfigs: {
        claude: {
          environmentVariables: `ANTHROPIC_MODEL=${TEST_CODEX_MODEL}`,
        },
        codex: {
          enabled: false,
        },
      },
    };

    expect(getProviderForModel(TEST_CODEX_MODEL, settings)).toBe('codex');
    expect(getEnabledProviderForModel(TEST_CODEX_MODEL, settings)).toBe('claude');
  });
});

describe('getAllEnabledProviderModelOptions', () => {
  it('returns grouped model options with provider icons across enabled providers', () => {
    const settings = {
      defaultChatProvider: 'claude',
      providerConfigs: {
        claude: {
          enabled: true,
          customModels: 'claude-3-5-sonnet',
        },
        codex: {
          enabled: true,
          visibleModels: ['gpt-4o'],
        },
      },
    };

    const options = getAllEnabledProviderModelOptions(settings as any);
    expect(options.length).toBeGreaterThan(0);

    const claudeOption = options.find(opt => opt.providerId === 'claude');
    expect(claudeOption).toBeDefined();
    expect(claudeOption?.group).toBe('Claude');
    expect(claudeOption?.providerIcon).toBeDefined();

    const codexOption = options.find(opt => opt.providerId === 'codex');
    expect(codexOption).toBeDefined();
    expect(codexOption?.group).toBe('Codex');
    expect(codexOption?.providerIcon).toBeDefined();
  });

  it('excludes disabled providers from model options', () => {
    const settings = {
      defaultChatProvider: 'claude',
      providerConfigs: {
        claude: {
          enabled: true,
          customModels: 'claude-3-5-sonnet',
        },
        codex: {
          enabled: false,
          visibleModels: ['gpt-4o'],
        },
      },
    };

    const options = getAllEnabledProviderModelOptions(settings as any);
    expect(options.some(opt => opt.providerId === 'codex')).toBe(false);
    expect(options.some(opt => opt.providerId === 'claude')).toBe(true);
  });
});
