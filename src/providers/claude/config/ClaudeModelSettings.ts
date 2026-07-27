import * as fs from 'node:fs';
import * as path from 'node:path';

import { CLAUDE_MODEL_ENV_KEYS } from '../env/claudeModelEnv';
import { resolveClaudeConfigDir } from './ClaudeConfigDir';

const PROJECT_SETTINGS_PATH = path.join('.claude', 'settings.json');
const PROJECT_LOCAL_SETTINGS_PATH = path.join('.claude', 'settings.local.json');

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

/**
 * Mirrors Claude Code model-setting precedence without reading credentials.
 * Codian runtime environment values are merged by the caller after this result.
 */
export function getClaudeSettingsModelEnvironment(
  context: ClaudeModelSettingsContext,
): Record<string, string> {
  const readFile = context.readFile ?? ((filePath: string) => fs.readFileSync(filePath, 'utf8'));
  const sources: string[] = [];
  if (context.loadUserSettings) {
    const configDir = context.configDir ?? resolveClaudeConfigDir();
    sources.push(path.join(configDir, 'settings.json'));
  }
  if (context.vaultPath) {
    sources.push(path.join(context.vaultPath, PROJECT_SETTINGS_PATH));
    sources.push(path.join(context.vaultPath, PROJECT_LOCAL_SETTINGS_PATH));
  }

  return sources.reduce<Record<string, string>>(
    (environment, source) => ({ ...environment, ...readModelEnvironment(source, readFile) }),
    {},
  );
}
