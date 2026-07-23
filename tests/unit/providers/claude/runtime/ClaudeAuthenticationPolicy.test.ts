import { hasSupportedClaudeAuthentication } from '@/providers/claude/runtime/ClaudeAuthenticationPolicy';

describe('ClaudeAuthenticationPolicy', () => {
  it('accepts an Anthropic API key', () => {
    expect(hasSupportedClaudeAuthentication({ ANTHROPIC_API_KEY: 'test-key' })).toBe(true);
  });

  it.each([
    'CLAUDE_CODE_USE_BEDROCK',
    'CLAUDE_CODE_USE_VERTEX',
    'CLAUDE_CODE_USE_FOUNDRY',
  ])('accepts supported cloud authentication through %s', (key) => {
    expect(hasSupportedClaudeAuthentication({ [key]: 'true' })).toBe(true);
  });

  it('accepts a token only for an explicit compatible endpoint', () => {
    expect(hasSupportedClaudeAuthentication({
      ANTHROPIC_BASE_URL: 'https://provider.example.com',
      ANTHROPIC_AUTH_TOKEN: 'test-token',
    })).toBe(true);
    expect(hasSupportedClaudeAuthentication({
      ANTHROPIC_AUTH_TOKEN: 'test-token',
    })).toBe(false);
  });

  it('rejects an OAuth-only or empty environment', () => {
    expect(hasSupportedClaudeAuthentication({
      CLAUDE_CODE_OAUTH_TOKEN: 'test-oauth-token',
    })).toBe(false);
    expect(hasSupportedClaudeAuthentication({})).toBe(false);
  });
});
