import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { SlashCommand } from '@/core/types';
import { extractString, parseFrontmatter } from '@/utils/frontmatter';

import { getDeepSeekHome } from '../runtime/DeepSeekHome';

export interface DiscoverSkillOptions {
  vaultCwd?: string;
  environment?: NodeJS.ProcessEnv;
}

/**
 * Discovers local skills from:
 * 1. Global DSH directory: `~/.dsh/skills` (or `$DSH_HOME/skills`)
 * 2. Workspace directory: `<vaultCwd>/.agents/skills` and `<vaultCwd>/.dsh/skills`
 *
 * Workspace skills override global skills with the same name.
 */
export async function discoverDeepSeekLocalSkills(
  vaultCwdOrOptions?: string | DiscoverSkillOptions,
): Promise<SlashCommand[]> {
  const options: DiscoverSkillOptions = typeof vaultCwdOrOptions === 'string'
    ? { vaultCwd: vaultCwdOrOptions }
    : (vaultCwdOrOptions ?? {});

  const environment = options.environment ?? process.env;
  const cwd = options.vaultCwd ?? process.cwd();
  const dshHome = getDeepSeekHome(environment, cwd);

  const globalDir = join(dshHome, 'skills');
  const workspaceAgentsDir = options.vaultCwd ? join(options.vaultCwd, '.agents', 'skills') : undefined;
  const workspaceDshDir = options.vaultCwd ? join(options.vaultCwd, '.dsh', 'skills') : undefined;

  const [globalSkills, workspaceAgentsSkills, workspaceDshSkills] = await Promise.all([
    scanSkillDirectory(globalDir),
    workspaceAgentsDir ? scanSkillDirectory(workspaceAgentsDir) : Promise.resolve([]),
    workspaceDshDir ? scanSkillDirectory(workspaceDshDir) : Promise.resolve([]),
  ]);

  const skillMap = new Map<string, SlashCommand>();

  // Global skills first
  for (const skill of globalSkills) {
    skillMap.set(skill.name, skill);
  }
  // Workspace skills take precedence over global skills
  for (const skill of workspaceAgentsSkills) {
    skillMap.set(skill.name, skill);
  }
  for (const skill of workspaceDshSkills) {
    skillMap.set(skill.name, skill);
  }

  return [...skillMap.values()].sort((a, b) => a.name.localeCompare(b.name));
}

async function scanSkillDirectory(dir: string): Promise<SlashCommand[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    const skills: SlashCommand[] = [];

    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      const skillName = entry.name;
      if (skillName.startsWith('.')) continue;

      const skillFilePath = join(dir, skillName, 'SKILL.md');
      try {
        const rawContent = await readFile(skillFilePath, 'utf8');
        const parsed = parseFrontmatter(rawContent);
        const name = (parsed && extractString(parsed.frontmatter, 'name')) || skillName;
        const description = (parsed && extractString(parsed.frontmatter, 'description')) || '';

        skills.push({
          id: `deepseek:skill:${name}`,
          name,
          description,
          content: '',
          source: 'sdk',
          kind: 'skill',
          userInvocable: true,
        });
      } catch {
        // Not a skill directory or SKILL.md unreadable, safely ignore
      }
    }

    return skills;
  } catch {
    return [];
  }
}

/**
 * Merges local skills and runtime commands, deduplicating by command name.
 * Built-in commands (like /compact) appear before skills, and skills are sorted alphabetically.
 */
export function mergeDeepSeekCommands(
  localSkills: readonly SlashCommand[],
  runtimeCommands: readonly SlashCommand[],
): SlashCommand[] {
  const map = new Map<string, SlashCommand>();

  for (const cmd of localSkills) {
    map.set(cmd.name, cmd);
  }

  for (const cmd of runtimeCommands) {
    const existing = map.get(cmd.name);
    map.set(cmd.name, {
      ...existing,
      ...cmd,
      description: cmd.description || existing?.description || '',
    });
  }

  return [...map.values()].sort((a, b) => {
    if (a.kind !== b.kind) {
      return a.kind === 'command' ? -1 : 1;
    }
    return a.name.localeCompare(b.name);
  });
}
