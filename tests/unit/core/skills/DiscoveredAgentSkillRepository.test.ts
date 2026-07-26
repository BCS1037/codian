import { DiscoveredAgentSkillRepository } from '@/core/skills/DiscoveredAgentSkillRepository';

function markdown(name: string): string {
  return [
    '---',
    `name: ${name}`,
    'description: Shared skill',
    '---',
    'Instructions.',
  ].join('\n');
}

describe('DiscoveredAgentSkillRepository', () => {
  it('lists externally managed vault skill directories without changing them', async () => {
    const repository = new DiscoveredAgentSkillRepository({
      listFolders: jest.fn().mockResolvedValue([
        '.agents/skills/shared-skill',
        '.agents/skills/broken',
      ]),
      read: jest.fn().mockImplementation(async (path: string) => (
        path.includes('shared-skill') ? markdown('shared-skill') : 'not a skill'
      )),
    });

    await expect(repository.list()).resolves.toEqual({
      skills: [expect.objectContaining({
          name: 'shared-skill',
          directoryPath: '.agents/skills/shared-skill',
          filePath: '.agents/skills/shared-skill/SKILL.md',
        })],
      diagnostics: [expect.objectContaining({
        directoryPath: '.agents/skills/broken',
      })],
    });
  });
});
