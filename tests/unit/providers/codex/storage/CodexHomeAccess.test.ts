import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  AGENTS_VAULT_SKILLS_PATH,
  CODEX_MCP_CONFIG_PATH,
  CODEX_VAULT_SKILLS_PATH,
  CodexHomeFileAccess,
} from '@/providers/codex/storage/CodexHomeAccess';

describe('CodexHomeFileAccess', () => {
  let homePath: string;

  beforeEach(async () => {
    homePath = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-home-access-'));
  });

  afterEach(async () => {
    await fs.rm(homePath, { recursive: true, force: true });
  });

  it('reads only Codex MCP and skill locations', async () => {
    await fs.mkdir(path.join(homePath, CODEX_VAULT_SKILLS_PATH, 'review'), { recursive: true });
    await fs.mkdir(path.join(homePath, AGENTS_VAULT_SKILLS_PATH, 'agent'), { recursive: true });
    await fs.writeFile(
      path.join(homePath, CODEX_MCP_CONFIG_PATH),
      '[mcp_servers.local]\ncommand = "node"',
    );
    await fs.writeFile(
      path.join(homePath, CODEX_VAULT_SKILLS_PATH, 'review', 'SKILL.md'),
      'Review task',
    );
    await fs.writeFile(
      path.join(homePath, AGENTS_VAULT_SKILLS_PATH, 'agent', 'SKILL.md'),
      'Agent task',
    );

    const access = new CodexHomeFileAccess(homePath);

    await expect(access.readMcpConfig()).resolves.toContain('[mcp_servers.local]');
    await expect(access.listSkillNames('vault-codex')).resolves.toEqual(['review']);
    await expect(access.readSkill('vault-codex', 'review')).resolves.toBe('Review task');
    await expect(access.listSkillNames('vault-agents')).resolves.toEqual(['agent']);
    await expect(access.readSkill('vault-agents', 'agent')).resolves.toBe('Agent task');
  });

  it('rejects skill path traversal', async () => {
    const access = new CodexHomeFileAccess(homePath);

    await expect(access.readSkill('vault-codex', '../outside')).rejects.toThrow(
      'Invalid Codex skill name',
    );
    await expect(access.readSkill('vault-codex', 'nested\\outside')).rejects.toThrow(
      'Invalid Codex skill name',
    );
  });

  it('does not follow a skill symlink outside the Codex home', async () => {
    if (process.platform === 'win32') {
      return;
    }

    const outsidePath = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-home-outside-'));
    try {
      await fs.mkdir(path.join(outsidePath, 'escape'), { recursive: true });
      await fs.writeFile(path.join(outsidePath, 'escape', 'SKILL.md'), 'secret');
      await fs.mkdir(path.join(homePath, CODEX_VAULT_SKILLS_PATH), { recursive: true });
      await fs.symlink(
        path.join(outsidePath, 'escape'),
        path.join(homePath, CODEX_VAULT_SKILLS_PATH, 'escape'),
        'dir',
      );

      const access = new CodexHomeFileAccess(homePath);

      await expect(access.readSkill('vault-codex', 'escape')).rejects.toThrow(
        'Codex skill is unavailable',
      );
    } finally {
      await fs.rm(outsidePath, { recursive: true, force: true });
    }
  });
});
