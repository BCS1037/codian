import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { isPathWithinRoot } from '../../../core/storage/pathContainment';

export type CodexSkillRootId = 'vault-codex' | 'vault-agents';

export const CODEX_VAULT_SKILLS_PATH = '.codex/skills';
export const AGENTS_VAULT_SKILLS_PATH = '.agents/skills';

export const CODEX_SKILL_ROOT_PATHS: Readonly<Record<CodexSkillRootId, string>> = Object.freeze({
  'vault-codex': CODEX_VAULT_SKILLS_PATH,
  'vault-agents': AGENTS_VAULT_SKILLS_PATH,
});

export const CODEX_MCP_CONFIG_PATH = '.codex/config.toml';
export const CODEX_MCP_CONFIG_SOURCE = '~/.codex/config.toml';

export interface CodexHomeAccess {
  readMcpConfig(): Promise<string | null>;
  listSkillNames(rootId: CodexSkillRootId): Promise<string[]>;
  readSkill(rootId: CodexSkillRootId, name: string): Promise<string>;
}

/**
 * Read-only, path-bound access to Codex-owned files under the user's home.
 */
export class CodexHomeFileAccess implements CodexHomeAccess {
  private readonly root: string;

  constructor(root: string = os.homedir()) {
    this.root = path.resolve(root);
  }

  async readMcpConfig(): Promise<string | null> {
    const filePath = await this.resolveExisting(CODEX_MCP_CONFIG_PATH);
    if (!filePath) {
      return null;
    }

    try {
      return await fs.readFile(filePath, 'utf-8');
    } catch {
      return null;
    }
  }

  async listSkillNames(rootId: CodexSkillRootId): Promise<string[]> {
    const rootPath = await this.resolveExisting(CODEX_SKILL_ROOT_PATHS[rootId]);
    if (!rootPath) {
      return [];
    }

    try {
      const entries = await fs.readdir(rootPath, { withFileTypes: true });
      return entries
        .filter(entry => entry.isDirectory())
        .map(entry => entry.name);
    } catch {
      return [];
    }
  }

  async readSkill(rootId: CodexSkillRootId, name: string): Promise<string> {
    if (!isSafeSkillName(name)) {
      throw new Error('Invalid Codex skill name');
    }

    const relativePath = path.join(CODEX_SKILL_ROOT_PATHS[rootId], name, 'SKILL.md');
    const filePath = await this.resolveExisting(relativePath);
    if (!filePath) {
      throw new Error('Codex skill is unavailable');
    }

    return fs.readFile(filePath, 'utf-8');
  }

  private async resolveExisting(relativePath: string): Promise<string | null> {
    const candidate = path.resolve(this.root, relativePath);
    if (!isPathWithinRoot(candidate, this.root)) {
      return null;
    }

    try {
      const [realRoot, realCandidate] = await Promise.all([
        fs.realpath(this.root),
        fs.realpath(candidate),
      ]);
      return isPathWithinRoot(realCandidate, realRoot) ? realCandidate : null;
    } catch {
      return null;
    }
  }
}

function isSafeSkillName(name: string): boolean {
  return Boolean(name)
    && name !== '.'
    && name !== '..'
    && !name.includes('/')
    && !name.includes('\\')
    && !name.includes('\0');
}
