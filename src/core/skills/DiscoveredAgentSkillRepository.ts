import { createHash } from 'node:crypto';
import path from 'node:path';

import type { AgentSkillDocument, AgentSkillListResult } from './AgentSkill';
import { AgentSkillCodecError, parseAgentSkillMarkdown } from './AgentSkillCodec';

export const DISCOVERED_AGENT_SKILLS_ROOT = '.agents/skills';

export interface DiscoveredAgentSkillStorage {
  listFolders(folder: string): Promise<string[]>;
  read(path: string): Promise<string>;
}

function digest(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

/** Read-only discovery permits externally managed skill-directory symlinks. */
export class DiscoveredAgentSkillRepository {
  constructor(private readonly files: DiscoveredAgentSkillStorage) {}

  async list(): Promise<AgentSkillListResult> {
    const folders = await this.files.listFolders(DISCOVERED_AGENT_SKILLS_ROOT);
    const skills: AgentSkillDocument[] = [];
    const diagnostics: AgentSkillListResult['diagnostics'] = [];

    for (const folder of folders
      .filter(candidate => path.posix.dirname(candidate) === DISCOVERED_AGENT_SKILLS_ROOT)
      .sort((left, right) => left.localeCompare(right))) {
      const name = path.posix.basename(folder);
      const filePath = `${folder}/SKILL.md`;
      try {
        const raw = await this.files.read(filePath);
        const parsed = parseAgentSkillMarkdown(raw, name);
        skills.push({
          ...parsed,
          directoryPath: folder,
          filePath,
          revision: digest(raw),
        });
      } catch (error) {
        diagnostics.push({
          directoryPath: folder,
          message: error instanceof AgentSkillCodecError || error instanceof Error
            ? error.message
            : 'Could not read skill package',
        });
      }
    }

    skills.sort((left, right) => left.name.localeCompare(right.name));
    diagnostics.sort((left, right) => (
      left.directoryPath.localeCompare(right.directoryPath)
      || left.message.localeCompare(right.message)
    ));
    return { skills, diagnostics };
  }
}
