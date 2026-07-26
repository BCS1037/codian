import '@/providers';

import type { ProviderCommandEntry } from '@/core/providers/commands/ProviderCommandEntry';
import type { ProviderVaultEntryRepository } from '@/core/providers/commands/ProviderVaultEntryRepository';
import { ProviderWorkspaceRegistry } from '@/core/providers/ProviderWorkspaceRegistry';
import type { AgentSkillListResult } from '@/core/skills/AgentSkill';
import { loadWorkspaceResources } from '@/features/settings/workspaceResources';

function makeSkill(providerId: 'claude' | 'codex'): ProviderCommandEntry {
  return {
    id: `${providerId}-ask-matt`,
    providerId,
    kind: 'skill',
    name: 'ask-matt',
    content: 'Ask Matt',
    scope: 'vault',
    source: 'user',
    sourcePath: '.agents/skills/ask-matt/SKILL.md',
    isEditable: true,
    isDeletable: true,
    displayPrefix: '/',
    insertPrefix: '/',
  };
}

function makeRepository(entry: ProviderCommandEntry): ProviderVaultEntryRepository {
  return {
    listVaultEntries: jest.fn().mockResolvedValue([entry]),
    saveVaultEntry: jest.fn(),
    deleteVaultEntry: jest.fn(),
  };
}

function makeSharedSkills(): AgentSkillListResult {
  return {
    diagnostics: [],
    skills: [{
      name: 'shared-skill',
      description: 'Shared provider skill',
      instructions: 'Use shared instructions.',
      directoryPath: '.agents/skills/shared-skill',
      filePath: '.agents/skills/shared-skill/SKILL.md',
      frontmatter: {},
      revision: 'revision-1',
    }],
  };
}

describe('workspace resource aggregation', () => {
  afterEach(() => ProviderWorkspaceRegistry.clear());

  it('merges one native source used by multiple providers into one row', async () => {
    ProviderWorkspaceRegistry.setServices('claude', { vaultCommandRepository: makeRepository(makeSkill('claude')) });
    ProviderWorkspaceRegistry.setServices('codex', { vaultCommandRepository: makeRepository(makeSkill('codex')) });

    const rows = await loadWorkspaceResources(['codex', 'claude'], 'skills');

    expect(rows).toEqual([expect.objectContaining({
      name: 'ask-matt',
      providerIds: ['codex', 'claude'],
      source: '.agents/skills/ask-matt/SKILL.md',
      status: 'available',
    })]);
  });

  it('lists shared agent skills for every provider that supports them', async () => {
    const rows = await loadWorkspaceResources(
      ['claude', 'codex', 'grok', 'kimi', 'opencode', 'pi'],
      'skills',
      { loadSharedSkills: async () => makeSharedSkills() },
    );

    expect(rows).toEqual([expect.objectContaining({
      name: 'shared-skill',
      providerIds: ['codex', 'grok', 'opencode', 'pi'],
      source: '.agents/skills/shared-skill/SKILL.md',
      status: 'available',
    })]);
  });
});
