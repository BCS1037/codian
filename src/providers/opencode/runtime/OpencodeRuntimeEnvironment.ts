import { getRuntimeEnvironmentText } from '../../../core/providers/providerEnvironment';
import { getEnhancedPath, parseEnvironmentVariables } from '../../../utils/env';

export function buildOpencodeRuntimeEnv(
  settings: Record<string, unknown>,
  cliPath: string,
  databasePathOverride?: string | null,
): NodeJS.ProcessEnv {
  const envText = getRuntimeEnvironmentText(settings, 'opencode');
  const envVars = parseEnvironmentVariables(envText);
  return {
    ...process.env,
    ...envVars,
    OPENCODE_DISABLE_CLAUDE_CODE_PROMPT: 'true',
    ...(databasePathOverride ? { OPENCODE_DB: databasePathOverride } : {}),
    PATH: getEnhancedPath(envVars.PATH, cliPath || undefined),
  };
}
