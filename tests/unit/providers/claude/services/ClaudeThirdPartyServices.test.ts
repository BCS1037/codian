import {
  applyClaudeServiceEnvironment,
  buildClaudeServiceEnvironment,
  decodeClaudeServiceModelSelection,
  encodeClaudeServiceModelSelection,
  migrateLegacyClaudeEnvironment,
  normalizeClaudeThirdPartyServices,
  resolveClaudeServiceLightweightSelection,
  resolveClaudeServicePreset,
  resolveClaudeServiceRuntime,
} from '../../../../../src/providers/claude/services/ClaudeThirdPartyServices';

describe('ClaudeThirdPartyServices', () => {
  it('provides accurate Anthropic-compatible presets', () => {
    expect(resolveClaudeServicePreset('cstcloud')).toMatchObject({
      name: '中国科技云',
      baseUrl: 'https://uni-api.cstcloud.cn',
      authMode: 'api-key',
    });
    expect(resolveClaudeServicePreset('aliyun-coding-plan')).toMatchObject({
      name: '阿里百炼 · Coding Plan',
      baseUrl: 'https://coding.dashscope.aliyuncs.com/apps/anthropic',
      authMode: 'auth-token',
    });
    expect(resolveClaudeServicePreset('aliyun-token-plan')).toMatchObject({
      baseUrl: 'https://token-plan.cn-beijing.maas.aliyuncs.com/apps/anthropic',
    });
    expect(resolveClaudeServicePreset('aliyun-payg')).toMatchObject({
      baseUrl: 'https://dashscope.aliyuncs.com/apps/anthropic',
    });
    expect(resolveClaudeServicePreset('volcengine-coding-plan')).toMatchObject({
      name: '火山方舟 · Coding Plan',
      baseUrl: 'https://ark.cn-beijing.volces.com/api/coding',
      authMode: 'auth-token',
    });
  });

  it('normalizes persisted services without retaining unknown fields', () => {
    expect(normalizeClaudeThirdPartyServices([{
      id: ' service-1 ',
      name: ' 百炼 ',
      preset: 'aliyun-coding-plan',
      baseUrl: ' https://example.com/ ',
      authMode: 'auth-token',
      secretId: 'codian-claude-service-1',
      defaultModel: ' qwen-plus ',
      lightweightModel: ' qwen-flash ',
      enabled: true,
      ignored: 'value',
    }])).toEqual([{
      id: 'service-1',
      name: '百炼',
      preset: 'aliyun-coding-plan',
      baseUrl: 'https://example.com',
      authMode: 'auth-token',
      secretId: 'codian-claude-service-1',
      defaultModel: 'qwen-plus',
      lightweightModel: 'qwen-flash',
      enabled: true,
      advancedEnvironmentVariables: '',
    }]);
  });

  it('round-trips service-bound model selections', () => {
    const selection = encodeClaudeServiceModelSelection('service-1', 'qwen/model v2');
    expect(selection).toBe('claude-code/service/service-1/qwen%2Fmodel%20v2');
    expect(decodeClaudeServiceModelSelection(selection)).toEqual({
      serviceId: 'service-1',
      modelId: 'qwen/model v2',
    });
  });

  it('maps friendly service fields to Claude runtime variables', () => {
    const env = buildClaudeServiceEnvironment({
      id: 'service-1',
      name: '百炼',
      preset: 'aliyun-coding-plan',
      baseUrl: 'https://coding.dashscope.aliyuncs.com/apps/anthropic',
      authMode: 'auth-token',
      secretId: 'codian-claude-service-1',
      defaultModel: 'qwen-plus',
      lightweightModel: 'qwen-flash',
      enabled: true,
      advancedEnvironmentVariables: 'CLAUDE_CODE_MAX_CONTEXT_TOKENS=1000000',
    }, 'secret-value');

    expect(env).toMatchObject({
      ANTHROPIC_AUTH_TOKEN: 'secret-value',
      ANTHROPIC_BASE_URL: 'https://coding.dashscope.aliyuncs.com/apps/anthropic',
      ANTHROPIC_MODEL: 'qwen-plus',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'qwen-flash',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'qwen-plus',
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'qwen-plus',
      CLAUDE_CODE_SUBAGENT_MODEL: 'qwen-plus',
      CLAUDE_CODE_MAX_CONTEXT_TOKENS: '1000000',
    });
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it('resolves bound service selections even when hidden from new chats', () => {
    const services = normalizeClaudeThirdPartyServices([{
      id: 'enabled',
      name: 'Enabled',
      baseUrl: 'https://enabled.example.com',
      authMode: 'api-key',
      secretId: 'codian-claude-enabled',
      defaultModel: 'main',
      lightweightModel: 'light',
      enabled: true,
    }, {
      id: 'disabled',
      name: 'Disabled',
      baseUrl: 'https://disabled.example.com',
      authMode: 'auth-token',
      secretId: 'codian-claude-disabled',
      defaultModel: 'main',
      lightweightModel: 'light',
      enabled: false,
    }]);

    expect(resolveClaudeServiceRuntime(
      encodeClaudeServiceModelSelection('enabled', 'main'),
      services,
      id => id === 'codian-claude-enabled' ? 'secret' : null,
    )).toMatchObject({
      modelId: 'main',
      service: { id: 'enabled' },
      environment: {
        ANTHROPIC_API_KEY: 'secret',
        ANTHROPIC_BASE_URL: 'https://enabled.example.com',
      },
    });
    expect(resolveClaudeServiceRuntime(
      encodeClaudeServiceModelSelection('disabled', 'main'),
      services,
      () => 'secret',
    )).toMatchObject({ service: { id: 'disabled', enabled: false } });
  });

  it('replaces conflicting legacy Claude credentials for a selected service', () => {
    const service = normalizeClaudeThirdPartyServices([{
      id: 'service-1',
      name: 'Service',
      baseUrl: 'https://service.example.com',
      authMode: 'auth-token',
      secretId: 'codian-claude-service-1',
      defaultModel: 'main',
      lightweightModel: 'light',
      enabled: true,
    }])[0];

    expect(applyClaudeServiceEnvironment(
      { PATH: '/bin', ANTHROPIC_API_KEY: 'old-key', ANTHROPIC_BASE_URL: 'https://old.example.com' },
      encodeClaudeServiceModelSelection('service-1', 'main'),
      [service],
      () => 'new-token',
    )).toMatchObject({
      PATH: '/bin',
      ANTHROPIC_AUTH_TOKEN: 'new-token',
      ANTHROPIC_BASE_URL: 'https://service.example.com',
    });
  });

  it('fails closed when a bound service has no SecretStorage key', () => {
    const service = normalizeClaudeThirdPartyServices([{
      id: 'service-1',
      name: 'Service',
      baseUrl: 'https://service.example.com',
      authMode: 'auth-token',
      secretId: 'codian-claude-service-1',
      defaultModel: 'main',
      lightweightModel: 'light',
      enabled: true,
    }])[0];

    expect(() => applyClaudeServiceEnvironment(
      { ANTHROPIC_API_KEY: 'official-key' },
      encodeClaudeServiceModelSelection('service-1', 'main'),
      [service],
      () => null,
    )).toThrow('API key is unavailable');
  });

  it('routes auxiliary work to the selected service lightweight model', () => {
    const service = normalizeClaudeThirdPartyServices([{
      id: 'service-1',
      name: 'Service',
      baseUrl: 'https://service.example.com',
      authMode: 'auth-token',
      secretId: 'codian-claude-service-1',
      defaultModel: 'main',
      lightweightModel: 'light',
      enabled: true,
    }])[0];

    expect(resolveClaudeServiceLightweightSelection(
      encodeClaudeServiceModelSelection('service-1', 'main'),
      [service],
    )).toBe('claude-code/service/service-1/light');
  });

  it('migrates legacy third-party variables into a service and SecretStorage', () => {
    const secrets = new Map<string, string>();
    const result = migrateLegacyClaudeEnvironment([
      'ANTHROPIC_AUTH_TOKEN=legacy-secret',
      'ANTHROPIC_BASE_URL=https://gateway.example.com',
      'ANTHROPIC_MODEL=main-model',
      'ANTHROPIC_DEFAULT_HAIKU_MODEL=light-model',
      'CLAUDE_CODE_MAX_CONTEXT_TOKENS=500000',
    ].join('\n'), {
      createId: () => 'migrated-service',
      setSecret: (id, value) => secrets.set(id, value),
    });

    expect(result.service).toMatchObject({
      id: 'migrated-service',
      name: '已迁移的 Claude 服务',
      baseUrl: 'https://gateway.example.com',
      authMode: 'auth-token',
      secretId: 'codian-claude-migrated-service',
      defaultModel: 'main-model',
      lightweightModel: 'light-model',
      enabled: true,
      advancedEnvironmentVariables: 'CLAUDE_CODE_MAX_CONTEXT_TOKENS=500000',
    });
    expect(result.remainingEnvironmentVariables).toBe('');
    expect(secrets.get('codian-claude-migrated-service')).toBe('legacy-secret');
  });
});
