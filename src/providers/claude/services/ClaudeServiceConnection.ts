import { requestUrl, type RequestUrlParam } from 'obsidian';

import type { ClaudeThirdPartyService } from './ClaudeThirdPartyServices';

function getMessagesEndpoint(baseUrl: string): string {
  const normalized = baseUrl.trim().replace(/\/$/, '');
  return normalized.endsWith('/v1')
    ? `${normalized}/messages`
    : `${normalized}/v1/messages`;
}

export function buildClaudeServiceTestRequest(
  service: ClaudeThirdPartyService,
  secret: string,
): RequestUrlParam {
  const headers: Record<string, string> = {
    'anthropic-version': '2023-06-01',
    'content-type': 'application/json',
  };
  if (service.authMode === 'api-key') {
    headers['x-api-key'] = secret;
  } else {
    headers.authorization = `Bearer ${secret}`;
  }

  return {
    url: getMessagesEndpoint(service.baseUrl),
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: service.defaultModel,
      max_tokens: 1,
      messages: [{ role: 'user', content: 'Reply with OK.' }],
    }),
    throw: false,
  };
}

export function redactClaudeServiceSecret(message: string, secret: string): string {
  return secret ? message.split(secret).join('[REDACTED]') : message;
}

export async function testClaudeServiceConnection(
  service: ClaudeThirdPartyService,
  secret: string,
): Promise<{ latencyMs: number }> {
  const startedAt = performance.now();
  try {
    const response = await requestUrl(buildClaudeServiceTestRequest(service, secret));
    if (response.status < 200 || response.status >= 300) {
      const detail = typeof response.text === 'string' ? response.text.slice(0, 500) : '';
      throw new Error(`HTTP ${response.status}${detail ? `: ${detail}` : ''}`);
    }
    return { latencyMs: Math.max(0, Math.round(performance.now() - startedAt)) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(redactClaudeServiceSecret(message, secret), { cause: error });
  }
}
