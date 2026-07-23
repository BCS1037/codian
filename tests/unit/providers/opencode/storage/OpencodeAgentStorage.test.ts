import type { VaultFileAdapter } from '@/core/storage/VaultFileAdapter';
import {
  createOpencodeAgentPersistenceKey,
  OPENCODE_AGENT_PATH,
  OPENCODE_AGENTS_PATH,
  OpencodeAgentStorage,
  parseOpencodeAgentMarkdown,
  parseOpencodeAgentPersistenceKey,
  serializeOpencodeAgentMarkdown,
} from '@/providers/opencode/storage/OpencodeAgentStorage';
import type { OpencodeAgentDefinition } from '@/providers/opencode/types/agent';

function createMockAdapter(files: Record<string, string> = {}): VaultFileAdapter {
  return {
    exists: jest.fn(async (targetPath: string) =>
      targetPath in files || Object.keys(files).some((key) => key.startsWith(`${targetPath}/`)),
    ),
    read: jest.fn(async (targetPath: string) => {
      if (!(targetPath in files)) {
        throw new Error(`File not found: ${targetPath}`);
      }
      return files[targetPath];
    }),
    write: jest.fn(),
    delete: jest.fn(),
    listFiles: jest.fn(),
    listFolders: jest.fn(),
    listFilesRecursive: jest.fn(async (folder: string) => {
      const prefix = folder.endsWith('/') ? folder : `${folder}/`;
      return Object.keys(files).filter((key) => key.startsWith(prefix));
    }),
    ensureFolder: jest.fn(),
    rename: jest.fn(),
    append: jest.fn(),
    stat: jest.fn(),
    deleteFolder: jest.fn(),
  } as unknown as VaultFileAdapter;
}

const BASIC_MARKDOWN = `---
description: "Reviews code for correctness."
mode: subagent
---
Review code like an owner.
`;

const FULL_MARKDOWN = `---
name: reviewer
description: "Reviews code for correctness."
mode: all
model: "anthropic/claude-sonnet-4-20250514"
variant: "high"
temperature: 0.1
top_p: 0.9
color: "#FF5733"
steps: 12
hidden: true
tools: {"write":false,"edit":false}
options: {"focus":"security"}
permission: {"edit":"deny"}
custom_key: "custom-value"
---
Review deeply and call out regressions.
`;

describe('parseOpencodeAgentMarkdown', () => {
  it('parses required fields and derives the name from the file path', () => {
    const result = parseOpencodeAgentMarkdown(BASIC_MARKDOWN, '.opencode/agent/review.md');

    expect(result).not.toBeNull();
    expect(result!.name).toBe('review');
    expect(result!.description).toBe('Reviews code for correctness.');
    expect(result!.prompt).toBe('Review code like an owner.');
    expect(result!.mode).toBe('subagent');
    expect(result!.persistenceKey).toBe(
      createOpencodeAgentPersistenceKey({ filePath: '.opencode/agent/review.md' }),
    );
  });

  it('supports nested agent paths and maxSteps fallback', () => {
    const result = parseOpencodeAgentMarkdown(`---
description: "Explores bugs."
maxSteps: 7
---
Trace the bug carefully.
`, '.opencode/agents/nested/explorer.md');

    expect(result).not.toBeNull();
    expect(result!.name).toBe('nested/explorer');
    expect(result!.steps).toBe(7);
    expect(result!.persistenceKey).toBe(
      createOpencodeAgentPersistenceKey({ filePath: '.opencode/agents/nested/explorer.md' }),
    );
  });

  it('preserves supported optional fields and unknown frontmatter', () => {
    const result = parseOpencodeAgentMarkdown(FULL_MARKDOWN, '.opencode/agents/reviewer.md');

    expect(result).not.toBeNull();
    expect(result!.model).toBe('anthropic/claude-sonnet-4-20250514');
    expect(result!.variant).toBe('high');
    expect(result!.temperature).toBe(0.1);
    expect(result!.topP).toBe(0.9);
    expect(result!.color).toBe('#FF5733');
    expect(result!.steps).toBe(12);
    expect(result!.hidden).toBe(true);
    expect(result!.tools).toEqual({ write: false, edit: false });
    expect(result!.options).toEqual({ focus: 'security' });
    expect(result!.permission).toEqual({ edit: 'deny' });
    expect(result!.extraFrontmatter).toEqual({ custom_key: 'custom-value' });
  });

  it('returns null when required fields are missing', () => {
    expect(parseOpencodeAgentMarkdown('---\nmode: subagent\n---\nPrompt', 'review.md')).toBeNull();
  });
});

describe('serializeOpencodeAgentMarkdown', () => {
  it('serializes supported fields and round-trips through parse', () => {
    const original: OpencodeAgentDefinition = {
      name: 'nested/reviewer',
      description: 'Reviews code for correctness.',
      prompt: 'Review deeply and call out regressions.',
      mode: 'all',
      model: 'anthropic/claude-sonnet-4-20250514',
      variant: 'high',
      temperature: 0.1,
      topP: 0.9,
      color: '#FF5733',
      steps: 12,
      tools: { write: false, edit: false },
      options: { focus: 'security' },
      permission: { edit: 'deny' },
      extraFrontmatter: { custom_key: 'custom-value' },
    };

    const markdown = serializeOpencodeAgentMarkdown(original);
    const reparsed = parseOpencodeAgentMarkdown(markdown, '.opencode/agents/nested/reviewer.md');

    expect(markdown).toContain('name: nested/reviewer');
    expect(markdown).toContain('mode: all');
    expect(markdown).toContain('tools: {"write":false,"edit":false}');
    expect(markdown).toContain('custom_key: custom-value');
    expect(reparsed).not.toBeNull();
    expect(reparsed!.name).toBe(original.name);
    expect(reparsed!.description).toBe(original.description);
    expect(reparsed!.prompt).toBe(original.prompt);
    expect(reparsed!.mode).toBe(original.mode);
    expect(reparsed!.tools).toEqual(original.tools);
    expect(reparsed!.options).toEqual(original.options);
    expect(reparsed!.permission).toEqual(original.permission);
    expect(reparsed!.extraFrontmatter).toEqual(original.extraFrontmatter);
  });
});

describe('OpencodeAgentStorage', () => {
  describe('loadAll', () => {
    it('loads markdown agents recursively from both supported OpenCode roots', async () => {
      const adapter = createMockAdapter({
        '.opencode/agent/review.md': BASIC_MARKDOWN,
        '.opencode/agents/nested/explorer.md': `---
description: "Explores bugs."
mode: all
---
Trace the bug carefully.
`,
        '.opencode/agent/README.txt': 'ignore me',
      });

      const storage = new OpencodeAgentStorage(adapter);
      const agents = await storage.loadAll();

      expect(agents.map((agent) => agent.name).sort()).toEqual(['nested/explorer', 'review']);
      expect(adapter.listFilesRecursive).toHaveBeenCalledWith(OPENCODE_AGENTS_PATH);
      expect(adapter.listFilesRecursive).toHaveBeenCalledWith(OPENCODE_AGENT_PATH);
    });

    it('prefers the singular root when duplicate agent names exist in both roots', async () => {
      const adapter = createMockAdapter({
        '.opencode/agents/review.md': `---
description: "Plural root"
mode: subagent
---
Plural prompt.
`,
        '.opencode/agent/review.md': `---
description: "Singular root"
mode: subagent
---
Singular prompt.
`,
      });

      const storage = new OpencodeAgentStorage(adapter);
      const agents = await storage.loadAll();

      expect(agents).toHaveLength(1);
      expect(agents[0].description).toBe('Singular root');
      expect(agents[0].persistenceKey).toBe(
        createOpencodeAgentPersistenceKey({ filePath: '.opencode/agent/review.md' }),
      );
    });

    it('returns an empty array when neither supported root exists', async () => {
      const adapter = createMockAdapter({});
      (adapter.listFilesRecursive as jest.Mock).mockRejectedValue(new Error('not found'));

      const storage = new OpencodeAgentStorage(adapter);
      await expect(storage.loadAll()).resolves.toEqual([]);
    });

    it('returns an empty array when one root is missing and the other is empty', async () => {
      const adapter = createMockAdapter({});
      (adapter.listFilesRecursive as jest.Mock)
        .mockRejectedValueOnce(new Error('not found'))
        .mockResolvedValueOnce([]);

      const storage = new OpencodeAgentStorage(adapter);
      await expect(storage.loadAll()).resolves.toEqual([]);
    });
  });

  describe('load', () => {
    it('loads a single nested agent from its persistence key', async () => {
      const adapter = createMockAdapter({
        '.opencode/agents/nested/explorer.md': `---
description: "Explores bugs."
mode: all
---
Trace the bug carefully.
`,
      });

      const storage = new OpencodeAgentStorage(adapter);
      const agent = await storage.load({
        name: 'nested/explorer',
        description: '',
        prompt: '',
        persistenceKey: createOpencodeAgentPersistenceKey({ filePath: '.opencode/agents/nested/explorer.md' }),
      });

      expect(agent).not.toBeNull();
      expect(agent!.name).toBe('nested/explorer');
    });
  });

  describe('save', () => {
    it('writes new nested agents to the singular OpenCode root', async () => {
      const adapter = createMockAdapter({});
      const storage = new OpencodeAgentStorage(adapter);

      await storage.save({
        name: 'nested/reviewer',
        description: 'Reviews code.',
        prompt: 'Review carefully.',
        mode: 'subagent',
      });

      expect(adapter.ensureFolder).toHaveBeenCalledWith('.opencode/agent/nested');
      expect(adapter.write).toHaveBeenCalledWith(
        '.opencode/agent/nested/reviewer.md',
        expect.stringContaining('description: Reviews code.'),
      );
    });

    it('preserves the existing plural-root backing file when the name is unchanged', async () => {
      const adapter = createMockAdapter({});
      const storage = new OpencodeAgentStorage(adapter);

      await storage.save({
        name: 'reviewer',
        description: 'Reviews code.',
        prompt: 'Review carefully.',
        mode: 'subagent',
      }, {
        name: 'reviewer',
        description: 'Reviews code.',
        prompt: 'Review carefully.',
        persistenceKey: createOpencodeAgentPersistenceKey({ filePath: '.opencode/agents/legacy/reviewer.md' }),
      });

      expect(adapter.write).toHaveBeenCalledWith(
        '.opencode/agents/legacy/reviewer.md',
        expect.any(String),
      );
      expect(adapter.delete).not.toHaveBeenCalled();
    });

    it('preserves the existing singular-root backing file when the name is unchanged', async () => {
      const adapter = createMockAdapter({});
      const storage = new OpencodeAgentStorage(adapter);

      await storage.save({
        name: 'reviewer',
        description: 'Reviews code.',
        prompt: 'Review carefully.',
        mode: 'subagent',
      }, {
        name: 'reviewer',
        description: 'Reviews code.',
        prompt: 'Review carefully.',
        persistenceKey: createOpencodeAgentPersistenceKey({ filePath: '.opencode/agent/legacy/reviewer.md' }),
      });

      expect(adapter.write).toHaveBeenCalledWith(
        '.opencode/agent/legacy/reviewer.md',
        expect.any(String),
      );
      expect(adapter.delete).not.toHaveBeenCalled();
    });

    it('renames the backing file when the agent name changes', async () => {
      const adapter = createMockAdapter({});
      const storage = new OpencodeAgentStorage(adapter);

      await storage.save({
        name: 'reviewer',
        description: 'Reviews code.',
        prompt: 'Review carefully.',
        mode: 'subagent',
      }, {
        name: 'legacy/reviewer',
        description: 'Reviews code.',
        prompt: 'Review carefully.',
        persistenceKey: createOpencodeAgentPersistenceKey({ filePath: '.opencode/agent/legacy/reviewer.md' }),
      });

      expect(adapter.write).toHaveBeenCalledWith(
        '.opencode/agent/reviewer.md',
        expect.any(String),
      );
      expect(adapter.delete).toHaveBeenCalledWith('.opencode/agent/legacy/reviewer.md');
    });
  });

  describe('delete', () => {
    it('deletes the resolved nested file', async () => {
      const adapter = createMockAdapter({});
      const storage = new OpencodeAgentStorage(adapter);

      await storage.delete({
        name: 'nested/reviewer',
        description: '',
        prompt: '',
        persistenceKey: createOpencodeAgentPersistenceKey({ filePath: '.opencode/agent/nested/reviewer.md' }),
      });

      expect(adapter.delete).toHaveBeenCalledWith('.opencode/agent/nested/reviewer.md');
    });
  });
});

describe('Opencode agent persistence keys', () => {
  it('round-trips nested file identity for the singular OpenCode root', () => {
    const key = createOpencodeAgentPersistenceKey({ filePath: '.opencode/agent/nested/reviewer.md' });

    expect(parseOpencodeAgentPersistenceKey(key)).toEqual({ filePath: '.opencode/agent/nested/reviewer.md' });
  });

  it('parses direct singular-root storage paths for backward compatibility', () => {
    expect(parseOpencodeAgentPersistenceKey('.opencode/agent/nested/reviewer.md')).toEqual({
      filePath: '.opencode/agent/nested/reviewer.md',
    });
  });

  it('parses direct plural-root storage paths for backward compatibility', () => {
    expect(parseOpencodeAgentPersistenceKey('.opencode/agents/nested/reviewer.md')).toEqual({
      filePath: '.opencode/agents/nested/reviewer.md',
    });
  });

  it('parses legacy encoded relative paths produced by the initial implementation', () => {
    expect(parseOpencodeAgentPersistenceKey('opencode-agent:nested%2Freviewer.md')).toEqual({
      filePath: '.opencode/agents/nested/reviewer.md',
    });
  });
});
