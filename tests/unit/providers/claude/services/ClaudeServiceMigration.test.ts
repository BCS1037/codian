import { migrateClaudeServiceSettings } from '../../../../../src/providers/claude/services/ClaudeServiceMigration';

describe('migrateClaudeServiceSettings', () => {
  it('moves legacy third-party credentials out of persisted Claude environment text', () => {
    const secrets = new Map<string, string>();
    const settings: Record<string, unknown> = {
      providerConfigs: {
        claude: {
          environmentVariables: [
            'ANTHROPIC_API_KEY=legacy-key',
            'ANTHROPIC_BASE_URL=https://gateway.example.com',
            'ANTHROPIC_MODEL=model-main',
            'ANTHROPIC_DEFAULT_HAIKU_MODEL=model-light',
          ].join('\n'),
        },
      },
    };

    expect(migrateClaudeServiceSettings(
      settings,
      {
        setSecret: (id, value) => secrets.set(id, value),
      },
      () => 'service-1',
    )).toBe(true);

    expect(settings.providerConfigs).toMatchObject({
      claude: {
        environmentVariables: '',
        defaultThirdPartyServiceId: 'service-1',
        thirdPartyServices: [{
          id: 'service-1',
          defaultModel: 'model-main',
          lightweightModel: 'model-light',
          secretId: 'codian-claude-service-1',
        }],
      },
    });
    expect(secrets.get('codian-claude-service-1')).toBe('legacy-key');
  });

  it('converts legacy Claude snippets into separate services and removes credential snippets', () => {
    const secrets = new Map<string, string>();
    const settings: Record<string, unknown> = {
      envSnippets: [{
        id: 'snippet-1',
        name: 'CST-Qwen',
        description: '',
        envVars: [
          'ANTHROPIC_API_KEY=snippet-key',
          'ANTHROPIC_BASE_URL=https://uni-api.cstcloud.cn/v1',
          'ANTHROPIC_MODEL=qwen3:235b',
        ].join('\n'),
        contextLimits: { 'qwen3:235b': 200000 },
        modelAliases: { 'qwen3:235b': 'Qwen 3' },
      }, {
        id: 'shared-path',
        name: 'Shared PATH',
        description: '',
        envVars: 'PATH=/opt/bin',
      }],
      customContextLimits: {},
      customModelAliases: {},
      providerConfigs: { claude: {} },
    };

    expect(migrateClaudeServiceSettings(
      settings,
      { setSecret: (id, value) => secrets.set(id, value) },
      () => 'unused',
    )).toBe(true);

    expect(settings.envSnippets).toEqual([expect.objectContaining({ id: 'shared-path' })]);
    expect(settings.customContextLimits).toEqual({ 'qwen3:235b': 200000 });
    expect(settings.customModelAliases).toEqual({ 'qwen3:235b': 'Qwen 3' });
    expect(settings.providerConfigs).toMatchObject({
      claude: {
        thirdPartyServices: [expect.objectContaining({
          id: 'snippet-1',
          name: 'CST-Qwen',
          defaultModel: 'qwen3:235b',
        })],
      },
    });
    expect(secrets.get('codian-claude-snippet-1')).toBe('snippet-key');
  });
});
