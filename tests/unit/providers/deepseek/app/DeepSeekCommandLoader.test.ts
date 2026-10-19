import type { ProviderHost } from '@/core/providers/ProviderHost';
import type { ProviderRuntimeCommandLoaderContext } from '@/core/providers/types';
import type { SlashCommand } from '@/core/types';
import { createDeepSeekCommandLoader } from '@/providers/deepseek/app/DeepSeekCommandLoader';
import { discoverDeepSeekLocalSkills } from '@/providers/deepseek/commands/DeepSeekSkillScanner';
import type { DeepSeekHost } from '@/providers/deepseek/runtime/DeepSeekHost';

jest.mock('@/providers/deepseek/commands/DeepSeekSkillScanner', () => ({
  discoverDeepSeekLocalSkills: jest.fn(),
  mergeDeepSeekCommands: jest.fn((local, runtime) => [...local, ...runtime]),
}));

function createMockPlugin(): ProviderHost {
  return {
    app: {
      vault: {
        adapter: {
          basePath: '/mock/vault',
        },
      },
    },
    settings: {
      providerConfigs: {
        deepseek: {
          enabled: true,
        },
      },
    },
  } as unknown as ProviderHost;
}

describe('DeepSeekCommandLoader', () => {
  let mockDeepSeek: DeepSeekHost;

  beforeEach(() => {
    jest.clearAllMocks();
    mockDeepSeek = {
      read: jest.fn(),
    } as unknown as DeepSeekHost;
  });

  it('reports availability and cache fingerprint based on enabled setting', () => {
    const loader = createDeepSeekCommandLoader(mockDeepSeek);

    expect(loader.isAvailable({ providerConfigs: { deepseek: { enabled: true } } })).toBe(true);
    expect(loader.isAvailable({ providerConfigs: { deepseek: { enabled: false } } })).toBe(false);
    expect(loader.getCacheFingerprint({ providerConfigs: { deepseek: { enabled: true } } })).toBe('deepseek:commands:true');
  });

  it('discovers local skills when blank session warmup runs', async () => {
    const localSkills: SlashCommand[] = [
      {
        id: 'deepseek:skill:tdd',
        name: 'tdd',
        description: 'TDD skill',
        content: '',
        kind: 'skill',
      },
    ];
    (discoverDeepSeekLocalSkills as jest.Mock).mockResolvedValue(localSkills);
    (mockDeepSeek.read as jest.Mock).mockRejectedValue(new Error('No daemon running'));

    const loader = createDeepSeekCommandLoader(mockDeepSeek);
    const plugin = createMockPlugin();

    const result = await loader.loadCommands({
      allowSessionCreation: true,
      conversation: null,
      plugin,
    } as ProviderRuntimeCommandLoaderContext);

    expect(result).toMatchObject({
      status: 'ready',
      items: [
        expect.objectContaining({ name: 'tdd' }),
      ],
    });
  });

  it('merges runtime commands when host read succeeds', async () => {
    const localSkills: SlashCommand[] = [
      {
        id: 'deepseek:skill:tdd',
        name: 'tdd',
        description: 'Local TDD',
        content: '',
        kind: 'skill',
      },
    ];

    (discoverDeepSeekLocalSkills as jest.Mock).mockResolvedValue(localSkills);
    (mockDeepSeek.read as jest.Mock).mockImplementation(async (callback) => {
      const reader = {
        call: jest.fn().mockImplementation((method: string) => {
          if (method === 'session/list') {
            return Promise.resolve({
              items: [{ sessionId: 'sess-1', cwd: '/mock/vault', origin: 'root', updatedAt: 100 }],
            });
          }
          if (method === 'session/projections') {
            return Promise.resolve({
              asOfSeq: 0,
              values: { agentPreset: 'claudian' },
            });
          }
          if (method === 'commands/list') {
            return Promise.resolve([{ name: 'compact', description: 'Compact history' }]);
          }
          if (method === 'skills/list') {
            return Promise.resolve({ skills: [] });
          }
          return Promise.resolve({});
        }),
      };
      return callback(reader, '/mock/dsh');
    });

    const loader = createDeepSeekCommandLoader(mockDeepSeek);
    const plugin = createMockPlugin();

    const result = await loader.loadCommands({
      allowSessionCreation: true,
      conversation: null,
      plugin,
    } as ProviderRuntimeCommandLoaderContext);

    expect(result).toMatchObject({
      status: 'ready',
      items: expect.arrayContaining([
        expect.objectContaining({ name: 'tdd' }),
        expect.objectContaining({ name: 'compact' }),
      ]),
    });
  });

  it('returns empty when no local skills and no runtime session found', async () => {
    (discoverDeepSeekLocalSkills as jest.Mock).mockResolvedValue([]);
    (mockDeepSeek.read as jest.Mock).mockRejectedValue(new Error('No session'));

    const loader = createDeepSeekCommandLoader(mockDeepSeek);
    const plugin = createMockPlugin();

    const result = await loader.loadCommands({
      allowSessionCreation: true,
      conversation: null,
      plugin,
    } as ProviderRuntimeCommandLoaderContext);

    expect(result.status).toBe('empty');
  });
});
