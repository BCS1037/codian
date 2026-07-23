jest.mock('obsidian', () => ({
  Modal: class MockModal {},
  Notice: jest.fn(),
  Setting: jest.fn(),
  setIcon: jest.fn(),
}));

jest.mock('@/shared/modals/ConfirmModal', () => ({
  confirmDelete: jest.fn(),
}));

import { createOpencodeAgentPersistenceKey } from '@/providers/opencode/storage/OpencodeAgentStorage';
import type { OpencodeAgentDefinition } from '@/providers/opencode/types/agent';
import {
  findOpencodeAgentNameConflict,
  validateOpencodeAgentName,
} from '@/providers/opencode/ui/OpencodeAgentSettings';

function makeAgent(overrides: Partial<OpencodeAgentDefinition> = {}): OpencodeAgentDefinition {
  return {
    name: 'review',
    description: 'Reviews code.',
    prompt: 'Review carefully.',
    ...overrides,
  };
}

describe('validateOpencodeAgentName', () => {
  it('accepts mixed-case nested names with spaces', () => {
    expect(validateOpencodeAgentName('Security Review/Builder')).toBeNull();
  });

  it('rejects leading or trailing slashes', () => {
    expect(validateOpencodeAgentName('/review')).toBe(
      'Agent name must use slash-separated path segments without leading or trailing slashes',
    );
    expect(validateOpencodeAgentName('review/')).toBe(
      'Agent name must use slash-separated path segments without leading or trailing slashes',
    );
  });

  it('rejects dot path segments', () => {
    expect(validateOpencodeAgentName('review/../builder')).toBe(
      'Agent name cannot include "." or ".." path segments',
    );
  });

  it('rejects Windows-reserved filename characters', () => {
    expect(validateOpencodeAgentName('review:builder')).toBe(
      'Agent name path segments cannot contain Windows-reserved filename characters',
    );
  });

  it('rejects leading or trailing whitespace inside a segment', () => {
    expect(validateOpencodeAgentName('review /builder')).toBe(
      'Agent name path segments cannot start or end with whitespace',
    );
  });
});

describe('findOpencodeAgentNameConflict', () => {
  it('detects conflicts against primary-capable agents, not just visible subagents', () => {
    const agents = [
      makeAgent({
        name: 'Builder',
        mode: 'primary',
        persistenceKey: createOpencodeAgentPersistenceKey({ filePath: '.opencode/agent/Builder.md' }),
      }),
      makeAgent({
        name: 'review',
        mode: 'subagent',
        persistenceKey: createOpencodeAgentPersistenceKey({ filePath: '.opencode/agent/review.md' }),
      }),
    ];

    expect(findOpencodeAgentNameConflict(agents, 'builder')?.name).toBe('Builder');
  });

  it('ignores the current backing file when editing in place', () => {
    const persistenceKey = createOpencodeAgentPersistenceKey({ filePath: '.opencode/agent/review.md' });
    const agents = [
      makeAgent({
        name: 'review',
        mode: 'subagent',
        persistenceKey,
      }),
    ];

    expect(findOpencodeAgentNameConflict(agents, 'review', persistenceKey)).toBeNull();
  });
});
