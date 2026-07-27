import { CodexMcpStorage } from '@/providers/codex/storage/CodexMcpStorage';

function createHomeAdapter(files: Record<string, string>) {
  return {
    exists: jest.fn(async (path: string) => path in files),
    read: jest.fn(async (path: string) => files[path]),
  };
}

describe('CodexMcpStorage', () => {
  it('loads stdio and HTTP servers from the Codex home configuration', async () => {
    const storage = new CodexMcpStorage(createHomeAdapter({
      '.codex/config.toml': [
        '[mcp_servers.local]',
        'command = "node"',
        'args = ["server.mjs"]',
        '[mcp_servers.local.env]',
        'TOKEN = "test"',
        '',
        '[mcp_servers.remote]',
        'url = "https://example.test/mcp"',
        '[mcp_servers.remote.http_headers]',
        'Authorization = "Bearer test"',
      ].join('\n'),
    }));

    await expect(storage.load()).resolves.toEqual([
      {
        name: 'local',
        config: {
          command: 'node',
          args: ['server.mjs'],
          env: { TOKEN: 'test' },
        },
        enabled: true,
        contextSaving: false,
      },
      {
        name: 'remote',
        config: {
          type: 'http',
          url: 'https://example.test/mcp',
          headers: { Authorization: 'Bearer test' },
        },
        enabled: true,
        contextSaving: false,
      },
    ]);
  });

  it('returns no servers when configuration is missing or malformed', async () => {
    await expect(new CodexMcpStorage(createHomeAdapter({})).load()).resolves.toEqual([]);
    await expect(new CodexMcpStorage(createHomeAdapter({
      '.codex/config.toml': '[mcp_servers.broken',
    })).load()).resolves.toEqual([]);
  });
});
