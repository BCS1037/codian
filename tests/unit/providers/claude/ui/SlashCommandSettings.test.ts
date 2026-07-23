import type { ProviderCommandEntry } from '@/core/providers/commands/ProviderCommandEntry';
import { filterSettingsEntries } from '@/providers/claude/ui/SlashCommandSettings';

function makeEntry(kind: 'command' | 'skill', name: string): ProviderCommandEntry {
  return {
    id: `${kind}-${name}`,
    providerId: 'claude',
    kind,
    name,
    content: name,
    scope: 'vault',
    source: 'user',
    isEditable: true,
    isDeletable: true,
    displayPrefix: '/',
    insertPrefix: '/',
  };
}

describe('Claude workspace settings entry filtering', () => {
  const entries = [makeEntry('command', 'review'), makeEntry('skill', 'deploy')];

  it('keeps commands and skills in their respective settings sections', () => {
    expect(filterSettingsEntries(entries, 'command').map(entry => entry.name)).toEqual(['review']);
    expect(filterSettingsEntries(entries, 'skill').map(entry => entry.name)).toEqual(['deploy']);
  });
});
