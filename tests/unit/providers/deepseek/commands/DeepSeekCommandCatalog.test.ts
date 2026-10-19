import type { SlashCommand } from '@/core/types';
import {
  DeepSeekCommandCatalog,
  readDeepSeekCommands,
} from '@/providers/deepseek/commands/DeepSeekCommandCatalog';
import type { DeepSeekReader } from '@/providers/deepseek/remote/DeepSeekRemoteClient';

jest.mock('@/providers/deepseek/commands/DeepSeekSkillScanner', () => ({
  discoverDeepSeekLocalSkills: jest.fn().mockResolvedValue([]),
}));

describe('DeepSeekCommandCatalog', () => {
  it('returns configured dropdown config with slash trigger', () => {
    const catalog = new DeepSeekCommandCatalog();
    const config = catalog.getDropdownConfig();

    expect(config).toEqual({
      builtInPrefix: '/',
      commandPrefix: '/',
      providerId: 'deepseek',
      skillPrefix: '/',
      triggerChars: ['/'],
    });
  });

  it('lists entries from context.runtimeCommands when provided', async () => {
    const catalog = new DeepSeekCommandCatalog();
    const runtimeCommands: SlashCommand[] = [
      {
        id: 'deepseek:skill:tdd',
        name: 'tdd',
        description: 'TDD skill',
        content: '',
        kind: 'skill',
        userInvocable: true,
      },
    ];

    const entries = await catalog.listDropdownEntries({
      includeBuiltIns: false,
      runtimeCommands,
    });

    expect(entries).toEqual([
      {
        agent: undefined,
        allowedTools: undefined,
        argumentHint: undefined,
        content: '',
        context: undefined,
        description: 'TDD skill',
        disableModelInvocation: undefined,
        displayPrefix: '/',
        hooks: undefined,
        id: 'deepseek:skill:tdd',
        insertPrefix: '/',
        isDeletable: false,
        isEditable: false,
        kind: 'skill',
        model: undefined,
        name: 'tdd',
        providerId: 'deepseek',
        scope: 'user',
        source: 'sdk',
        userInvocable: true,
      },
    ]);
  });

  it('caches runtime commands and clears on refresh', async () => {
    const catalog = new DeepSeekCommandCatalog();
    catalog.setRuntimeCommands([
      {
        id: 'deepseek:command:compact',
        name: 'compact',
        description: 'Compact history',
        content: '',
        kind: 'command',
      },
    ]);

    let entries = await catalog.listDropdownEntries({
      includeBuiltIns: false,
    });
    expect(entries).toHaveLength(1);
    expect(entries[0].name).toBe('compact');
    expect(entries[0].kind).toBe('command');
    expect(entries[0].scope).toBe('runtime');

    await catalog.refresh();

    // After refresh, runtimeCommands is cleared; if no local skills found in cwd it returns empty
    entries = await catalog.listDropdownEntries({
      includeBuiltIns: false,
      allowCachedRuntimeCommands: false,
    });
    expect(entries).toEqual([]);
  });

  it('reads deepseek commands including compact and skills resiliently', async () => {
    const mockClient: DeepSeekReader = {
      call: jest.fn().mockImplementation((method: string) => {
        if (method === 'commands/list') {
          return Promise.resolve([
            { name: 'compact', description: 'Compact conversation history' },
            { name: 'unsupported-internal', description: 'Internal only' },
          ]);
        }
        if (method === 'skills/list') {
          return Promise.resolve({
            skills: [
              { name: 'tdd', description: 'Test driven development' },
            ],
          });
        }
        return Promise.reject(new Error(`Unexpected method: ${method}`));
      }),
    };

    const commands = await readDeepSeekCommands(mockClient, 'sess-123');
    expect(commands).toEqual([
      {
        id: 'deepseek:command:compact',
        name: 'compact',
        description: 'Compact conversation history',
        content: '',
        source: 'sdk',
        kind: 'command',
      },
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
});
