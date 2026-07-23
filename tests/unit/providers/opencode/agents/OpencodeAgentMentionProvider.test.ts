import { OpencodeAgentMentionProvider } from '@/providers/opencode/agents/OpencodeAgentMentionProvider';
import type { OpencodeAgentStorage } from '@/providers/opencode/storage/OpencodeAgentStorage';
import type { OpencodeAgentDefinition } from '@/providers/opencode/types/agent';

function makeAgent(overrides: Partial<OpencodeAgentDefinition> = {}): OpencodeAgentDefinition {
  return {
    name: 'test-agent',
    description: 'A test agent',
    prompt: 'Do useful work.',
    ...overrides,
  };
}

function makeMockStorage(agents: OpencodeAgentDefinition[] = []): OpencodeAgentStorage {
  return { loadAll: async () => agents } as unknown as OpencodeAgentStorage;
}

describe('OpencodeAgentMentionProvider', () => {
  it('returns an empty array before loadAgents is called', () => {
    const provider = new OpencodeAgentMentionProvider(makeMockStorage([makeAgent()]));
    expect(provider.searchAgents('')).toEqual([]);
  });

  it('returns only explicit subagents after load', async () => {
    const provider = new OpencodeAgentMentionProvider(makeMockStorage([
      makeAgent({ name: 'review', description: 'Reviews code', mode: 'subagent' }),
      makeAgent({ name: 'plan', description: 'Plans work', mode: 'all' }),
      makeAgent({ name: 'general', description: 'Uses the default all-mode behavior' }),
      makeAgent({ name: 'build', description: 'Primary only', mode: 'primary' }),
      makeAgent({ name: 'hidden-review', description: 'Hidden', hidden: true, mode: 'subagent' }),
      makeAgent({ name: 'disabled-review', description: 'Disabled', disable: true, mode: 'subagent' }),
    ]));
    await provider.loadAgents();

    expect(provider.searchAgents('')).toEqual([
      {
        id: 'review',
        name: 'review',
        description: 'Reviews code',
        filePath: '.opencode/agent/review.md',
        source: 'vault',
      },
    ]);
  });

  it('filters case-insensitively by name and description', async () => {
    const provider = new OpencodeAgentMentionProvider(makeMockStorage([
      makeAgent({ name: 'security/review', description: 'Finds auth issues', mode: 'subagent' }),
      makeAgent({ name: 'perf/explore', description: 'Profiles hot paths', mode: 'subagent' }),
    ]));
    await provider.loadAgents();

    expect(provider.searchAgents('SECURITY')).toHaveLength(1);
    expect(provider.searchAgents('auth')).toHaveLength(1);
    expect(provider.searchAgents('missing')).toEqual([]);
  });
});
