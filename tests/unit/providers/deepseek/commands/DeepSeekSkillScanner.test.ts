import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { SlashCommand } from '@/core/types';
import {
  discoverDeepSeekLocalSkills,
  mergeDeepSeekCommands,
} from '@/providers/deepseek/commands/DeepSeekSkillScanner';

describe('DeepSeekSkillScanner', () => {
  let tempRoot: string;
  let dshHome: string;
  let vaultCwd: string;

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'dsh-skills-test-'));
    dshHome = join(tempRoot, '.dsh');
    vaultCwd = join(tempRoot, 'vault');
    await mkdir(join(dshHome, 'skills'), { recursive: true });
    await mkdir(join(vaultCwd, '.agents', 'skills'), { recursive: true });
  });

  afterEach(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  it('discovers global skills from dshHome/skills', async () => {
    const skillDir = join(dshHome, 'skills', 'tdd');
    await mkdir(skillDir, { recursive: true });
    await writeFile(
      join(skillDir, 'SKILL.md'),
      '---\nname: tdd\ndescription: Test driven development\n---\n# TDD',
    );

    const skills = await discoverDeepSeekLocalSkills({
      vaultCwd,
      environment: { DSH_HOME: dshHome } as unknown as NodeJS.ProcessEnv,
    });

    expect(skills).toEqual([
      {
        id: 'deepseek:skill:tdd',
        name: 'tdd',
        description: 'Test driven development',
        content: '',
        source: 'sdk',
        kind: 'skill',
        userInvocable: true,
      },
    ]);
  });

  it('discovers workspace skills and overrides global skills with same name', async () => {
    // Global skill
    const globalSkillDir = join(dshHome, 'skills', 'code-review');
    await mkdir(globalSkillDir, { recursive: true });
    await writeFile(
      join(globalSkillDir, 'SKILL.md'),
      '---\nname: code-review\ndescription: Global code review\n---\n# Review',
    );

    // Workspace skill with same name
    const workspaceSkillDir = join(vaultCwd, '.agents', 'skills', 'code-review');
    await mkdir(workspaceSkillDir, { recursive: true });
    await writeFile(
      join(workspaceSkillDir, 'SKILL.md'),
      '---\nname: code-review\ndescription: Vault customized code review\n---\n# Custom Review',
    );

    // Unique workspace skill
    const uniqueWorkspaceDir = join(vaultCwd, '.agents', 'skills', 'ask-prisma');
    await mkdir(uniqueWorkspaceDir, { recursive: true });
    await writeFile(
      join(uniqueWorkspaceDir, 'SKILL.md'),
      '---\nname: ask-prisma\ndescription: Ask Prisma skill\n---\n# Prisma',
    );

    const skills = await discoverDeepSeekLocalSkills({
      vaultCwd,
      environment: { DSH_HOME: dshHome } as unknown as NodeJS.ProcessEnv,
    });

    expect(skills).toHaveLength(2);
    expect(skills[0].name).toBe('ask-prisma');
    expect(skills[1].name).toBe('code-review');
    expect(skills[1].description).toBe('Vault customized code review');
  });

  it('merges local skills and runtime commands with commands first', () => {
    const localSkills: SlashCommand[] = [
      {
        id: 'deepseek:skill:tdd',
        name: 'tdd',
        description: 'Local TDD',
        content: '',
        kind: 'skill',
      },
      {
        id: 'deepseek:skill:ask-prisma',
        name: 'ask-prisma',
        description: 'Local Prisma',
        content: '',
        kind: 'skill',
      },
    ];

    const runtimeCommands: SlashCommand[] = [
      {
        id: 'deepseek:command:compact',
        name: 'compact',
        description: 'Compact history',
        content: '',
        kind: 'command',
      },
      {
        id: 'deepseek:skill:tdd',
        name: 'tdd',
        description: 'Runtime updated TDD',
        content: '',
        kind: 'skill',
      },
    ];

    const merged = mergeDeepSeekCommands(localSkills, runtimeCommands);

    expect(merged).toHaveLength(3);
    // Command first
    expect(merged[0].name).toBe('compact');
    expect(merged[0].kind).toBe('command');
    // Skills sorted alphabetically
    expect(merged[1].name).toBe('ask-prisma');
    expect(merged[2].name).toBe('tdd');
    expect(merged[2].description).toBe('Runtime updated TDD');
  });
});
