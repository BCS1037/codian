import type { ProviderCommandEntry } from '@/core/providers/commands/ProviderCommandEntry';
import type { ProviderVaultEntryRepository } from '@/core/providers/commands/ProviderVaultEntryRepository';
import { ProviderWorkspaceRegistry } from '@/core/providers/ProviderWorkspaceRegistry';
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
});
