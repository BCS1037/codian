import { t } from '../../../i18n/i18n';

const SUPPORTED_CLOUD_FLAGS = [
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
] as const;

function isEnabled(value: string | undefined): boolean {
  return ['1', 'true', 'yes'].includes(value?.trim().toLowerCase() ?? '');
}

export function hasSupportedClaudeAuthentication(
  environment: Readonly<Record<string, string | undefined>>,
): boolean {
  if (environment.ANTHROPIC_API_KEY?.trim()) {
    return true;
  }

  if (
    environment.ANTHROPIC_BASE_URL?.trim()
    && environment.ANTHROPIC_AUTH_TOKEN?.trim()
  ) {
    return true;
  }

  return SUPPORTED_CLOUD_FLAGS.some(key => isEnabled(environment[key]));
}

export function assertSupportedClaudeAuthentication(
  environment: Readonly<Record<string, string | undefined>>,
): void {
  if (!hasSupportedClaudeAuthentication(environment)) {
    throw new Error(t('settings.claude.authenticationRequired'));
  }
}
