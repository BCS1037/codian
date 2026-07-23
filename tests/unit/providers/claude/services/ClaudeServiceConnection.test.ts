import {
  buildClaudeServiceTestRequest,
  redactClaudeServiceSecret,
} from '../../../../../src/providers/claude/services/ClaudeServiceConnection';
import type { ClaudeThirdPartyService } from '../../../../../src/providers/claude/services/ClaudeThirdPartyServices';

const service: ClaudeThirdPartyService = {
  id: 'service-1',
  name: '百炼',
  preset: 'aliyun-coding-plan',
  baseUrl: 'https://coding.dashscope.aliyuncs.com/apps/anthropic/',
  authMode: 'auth-token',
  secretId: 'codian-claude-service-1',
  defaultModel: 'qwen-plus',
  lightweightModel: 'qwen-flash',
  enabled: true,
  advancedEnvironmentVariables: '',
};

describe('ClaudeServiceConnection', () => {
  it('builds a minimal Anthropic Messages request', () => {
    expect(buildClaudeServiceTestRequest(service, 'secret')).toEqual({
      url: 'https://coding.dashscope.aliyuncs.com/apps/anthropic/v1/messages',
      method: 'POST',
      headers: {
        'anthropic-version': '2023-06-01',
        authorization: 'Bearer secret',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'qwen-plus',
        max_tokens: 1,
        messages: [{ role: 'user', content: 'Reply with OK.' }],
      }),
      throw: false,
    });
  });

  it('uses x-api-key for API key authentication', () => {
    expect(buildClaudeServiceTestRequest({ ...service, authMode: 'api-key' }, 'secret').headers)
      .toMatchObject({ 'x-api-key': 'secret' });
  });

  it('redacts secrets from provider errors', () => {
    expect(redactClaudeServiceSecret('Request failed for secret', 'secret'))
      .toBe('Request failed for [REDACTED]');
  });
});
