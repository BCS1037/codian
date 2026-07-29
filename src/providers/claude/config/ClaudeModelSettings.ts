import * as fs from 'node:fs';
import * as path from 'node:path';

import { CLAUDE_MODEL_ENV_KEYS } from '../env/claudeModelEnv';
import { resolveClaudeConfigDir } from './ClaudeConfigDir';

const PROJECT_SETTINGS_PATH = path.join('.claude', 'settings.json');
const PROJECT_LOCAL_SETTINGS_PATH = path.join('.claude', 'settings.local.json');
const CLAUDE_AUTHENTICATION_ENV_KEYS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
] as const;

interface ClaudeSettingsFile {
  env?: unknown;
  model?: unknown;
}

export interface ClaudeModelSettingsContext {
  configDir?: string;
  loadUserSettings: boolean;
  readFile?: (filePath: string) => string;
  vaultPath?: string | null;
}

function readModelEnvironment(
  filePath: string,
  readFile: (filePath: string) => string,
): Record<string, string> {
  try {
    const parsed = JSON.parse(readFile(filePath)) as ClaudeSettingsFile;
    const environment = parsed.env && typeof parsed.env === 'object' && !Array.isArray(parsed.env)
      ? Object.fromEntries(Object.entries(parsed.env).filter(([, value]) => typeof value === 'string'))
      : {};
    const model = typeof parsed.model === 'string' ? parsed.model.trim() : '';
    if (model && !environment.ANTHROPIC_MODEL) {
      environment.ANTHROPIC_MODEL = model;
    }

    return Object.fromEntries(
      CLAUDE_MODEL_ENV_KEYS
        .filter(key => typeof environment[key] === 'string' && environment[key].trim())
        .map(key => [key, environment[key].trim()]),
    );
  } catch {
    return {};
  }
}

function readAuthenticationEnvironment(
  filePath: string,
  readFile: (filePath: string) => string,
): Record<string, string> {
  try {
    const parsed = JSON.parse(readFile(filePath)) as ClaudeSettingsFile;
    const environment = parsed.env && typeof parsed.env === 'object' && !Array.isArray(parsed.env)
      ? parsed.env as Record<string, unknown>
      : {};

    return Object.fromEntries(
      CLAUDE_AUTHENTICATION_ENV_KEYS
        .filter(key => typeof environment[key] === 'string')
        .map(key => [key, (environment[key] as string).trim()]),
    );
  } catch {
    return {};
  }
}

function getClaudeSettingsSources(context: ClaudeModelSettingsContext): string[] {
  const sources: string[] = [];
  if (context.loadUserSettings) {
    const configDir = context.configDir ?? resolveClaudeConfigDir();
    sources.push(path.join(configDir, 'settings.json'));
  }
  if (context.vaultPath) {
    sources.push(path.join(context.vaultPath, PROJECT_SETTINGS_PATH));
    sources.push(path.join(context.vaultPath, PROJECT_LOCAL_SETTINGS_PATH));
  }
  return sources;
}

/**
 * Mirrors Claude Code model-setting precedence without reading credentials.
 * Codian runtime environment values are merged by the caller after this result.
 */
export function getClaudeSettingsModelEnvironment(
  context: ClaudeModelSettingsContext,
): Record<string, string> {
  const readFile = context.readFile ?? ((filePath: string) => fs.readFileSync(filePath, 'utf8'));
  return getClaudeSettingsSources(context).reduce<Record<string, string>>(
    (environment, source) => ({ ...environment, ...readModelEnvironment(source, readFile) }),
    {},
  );
}

/**
 * Reads explicit authentication only from trusted user settings.
 * Project settings must not establish an authentication boundary.
 */
export function getClaudeUserSettingsAuthenticationEnvironment(
  context: ClaudeModelSettingsContext,
): Record<string, string> {
  if (!context.loadUserSettings) {
    return {};
  }
  const readFile = context.readFile ?? ((filePath: string) => fs.readFileSync(filePath, 'utf8'));
  const configDir = context.configDir ?? resolveClaudeConfigDir();
  return readAuthenticationEnvironment(
    path.join(configDir, 'settings.json'),
    readFile,
  );
}
