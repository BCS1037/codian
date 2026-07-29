import {
  getClaudeSettingsModelEnvironment,
  getClaudeUserSettingsAuthenticationEnvironment,
} from '@/providers/claude/config/ClaudeModelSettings';

describe('getClaudeSettingsModelEnvironment', () => {
  it('uses the global model when user settings are enabled', () => {
    const environment = getClaudeSettingsModelEnvironment({
      configDir: '/home/user/.claude',
      loadUserSettings: true,
      readFile(filePath) {
        if (filePath === '/home/user/.claude/settings.json') {
          return JSON.stringify({ model: 'gateway/default' });
        }
        throw new Error('not found');
      },
    });

    expect(environment).toEqual({ ANTHROPIC_MODEL: 'gateway/default' });
  });

  it('applies project and local model overrides after user settings', () => {
    const files: Record<string, string> = {
      '/home/user/.claude/settings.json': JSON.stringify({
        env: {
          ANTHROPIC_DEFAULT_HAIKU_MODEL: 'user-haiku',
          ANTHROPIC_DEFAULT_SONNET_MODEL: 'user-sonnet',
        },
      }),
      '/vault/.claude/settings.json': JSON.stringify({
        env: { ANTHROPIC_DEFAULT_SONNET_MODEL: 'project-sonnet' },
      }),
      '/vault/.claude/settings.local.json': JSON.stringify({
        model: 'local-model',
        env: { ANTHROPIC_DEFAULT_OPUS_MODEL: 'local-opus' },
      }),
    };

    const environment = getClaudeSettingsModelEnvironment({
      configDir: '/home/user/.claude',
      loadUserSettings: true,
      vaultPath: '/vault',
      readFile(filePath) {
        if (!(filePath in files)) {
          throw new Error('not found');
        }
        return files[filePath];
      },
    });

    expect(environment).toEqual({
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'user-haiku',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'project-sonnet',
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'local-opus',
      ANTHROPIC_MODEL: 'local-model',
    });
  });

  it('does not read user settings when Claude user settings are disabled', () => {
    const readFile = jest.fn(() => JSON.stringify({ model: 'user-model' }));

    const environment = getClaudeSettingsModelEnvironment({
      configDir: '/home/user/.claude',
      loadUserSettings: false,
      readFile,
    });

    expect(environment).toEqual({});
    expect(readFile).not.toHaveBeenCalled();
  });

  it('ignores invalid JSON and non-model environment values', () => {
    const environment = getClaudeSettingsModelEnvironment({
      configDir: '/home/user/.claude',
      loadUserSettings: true,
      readFile: () => '{invalid',
    });

    expect(environment).toEqual({});
  });
});

describe('getClaudeUserSettingsAuthenticationEnvironment', () => {
  it('reads only supported authentication values from Claude settings', () => {
    const readFile = jest.fn(() => JSON.stringify({
      env: {
        ANTHROPIC_AUTH_TOKEN: 'gateway-token',
        ANTHROPIC_BASE_URL: 'https://gateway.example.com',
        ANTHROPIC_MODEL: 'gateway-model',
        UNRELATED_SECRET: 'do-not-read',
      },
    }));
    const environment = getClaudeUserSettingsAuthenticationEnvironment({
      configDir: '/home/user/.claude',
      loadUserSettings: true,
      readFile,
      vaultPath: '/untrusted/project',
    });

    expect(environment).toEqual({
      ANTHROPIC_AUTH_TOKEN: 'gateway-token',
      ANTHROPIC_BASE_URL: 'https://gateway.example.com',
    });
    expect(readFile).toHaveBeenCalledTimes(1);
    expect(readFile).toHaveBeenCalledWith('/home/user/.claude/settings.json');
  });

  it('does not read user authentication when Claude user settings are disabled', () => {
    const readFile = jest.fn(() => JSON.stringify({
      env: { ANTHROPIC_API_KEY: 'user-key' },
    }));

    const environment = getClaudeUserSettingsAuthenticationEnvironment({
      configDir: '/home/user/.claude',
      loadUserSettings: false,
      readFile,
    });

    expect(environment).toEqual({});
    expect(readFile).not.toHaveBeenCalled();
  });
});
