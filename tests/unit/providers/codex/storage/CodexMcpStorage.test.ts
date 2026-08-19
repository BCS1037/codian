import type { CodexMcpCatalogReader } from '@/providers/codex/storage/CodexMcpStorage';
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
        provenance: {
          owner: 'provider-cli',
          source: '~/.codex/config.toml',
          readOnly: true,
        },
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
        provenance: {
          owner: 'provider-cli',
          source: '~/.codex/config.toml',
          readOnly: true,
        },
      },
    ]);
  });

  it('returns no servers when configuration is missing or malformed', async () => {
    await expect(new CodexMcpStorage(createHomeAdapter({})).load()).resolves.toEqual([]);
    await expect(new CodexMcpStorage(createHomeAdapter({
      '.codex/config.toml': '[mcp_servers.broken',
    })).load()).resolves.toEqual([]);
  });

  it('prefers the provider CLI catalog over the TOML fallback', async () => {
    const homeAdapter = createHomeAdapter({
      '.codex/config.toml': '[mcp_servers.legacy]\ncommand = "legacy"',
    });
    const cliCatalog: CodexMcpCatalogReader = {
      discoverCatalog: jest.fn().mockResolvedValue({
        kind: 'available',
        servers: [{
          name: 'cli-server',
          config: { command: 'node' },
          enabled: true,
          contextSaving: false,
          provenance: {
            owner: 'provider-cli',
            source: 'codex mcp list --json',
            readOnly: true,
          },
        }],
      }),
    };

    await expect(new CodexMcpStorage(homeAdapter, cliCatalog).load()).resolves.toEqual([
      expect.objectContaining({ name: 'cli-server' }),
    ]);
    expect(homeAdapter.exists).not.toHaveBeenCalled();
  });

  it('uses the TOML catalog when CLI discovery is unavailable', async () => {
    const homeAdapter = createHomeAdapter({
      '.codex/config.toml': '[mcp_servers.legacy]\ncommand = "legacy"',
    });
    const cliCatalog: CodexMcpCatalogReader = {
      discoverCatalog: jest.fn().mockResolvedValue({
        kind: 'unavailable',
        diagnostics: 'Codex MCP catalog timed out',
      }),
    };

    await expect(new CodexMcpStorage(homeAdapter, cliCatalog).load()).resolves.toEqual([
      expect.objectContaining({
        name: 'legacy',
        provenance: {
          owner: 'provider-cli',
          source: '~/.codex/config.toml',
          readOnly: true,
        },
      }),
    ]);
    expect(homeAdapter.exists).toHaveBeenCalledWith('.codex/config.toml');
  });

  it('does not fall back when CLI returns a valid empty catalog', async () => {
    const homeAdapter = createHomeAdapter({
      '.codex/config.toml': '[mcp_servers.legacy]\ncommand = "legacy"',
    });
    const cliCatalog: CodexMcpCatalogReader = {
      discoverCatalog: jest.fn().mockResolvedValue({ kind: 'available', servers: [] }),
    };

    await expect(new CodexMcpStorage(homeAdapter, cliCatalog).load()).resolves.toEqual([]);
    expect(homeAdapter.exists).not.toHaveBeenCalled();
  });
});
