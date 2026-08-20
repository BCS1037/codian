import type { CodexMcpCatalogReader } from '@/providers/codex/storage/CodexMcpStorage';
import { CodexMcpStorage } from '@/providers/codex/storage/CodexMcpStorage';

function createHomeAccess(files: Record<string, string>) {
  return {
    readMcpConfig: jest.fn(async () => files['.codex/config.toml'] ?? null),
  };
}

describe('CodexMcpStorage', () => {
  it('loads stdio and HTTP servers from the Codex home configuration', async () => {
    const storage = new CodexMcpStorage(createHomeAccess({
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
    await expect(new CodexMcpStorage(createHomeAccess({})).load()).resolves.toEqual([]);
    await expect(new CodexMcpStorage(createHomeAccess({
      '.codex/config.toml': '[mcp_servers.broken',
    })).load()).resolves.toEqual([]);
  });

  it('prefers the provider CLI catalog over the TOML fallback', async () => {
    const homeAccess = createHomeAccess({
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

    await expect(new CodexMcpStorage(homeAccess, cliCatalog).load()).resolves.toEqual([
      expect.objectContaining({ name: 'cli-server' }),
    ]);
    expect(homeAccess.readMcpConfig).not.toHaveBeenCalled();
  });

  it('uses the TOML catalog when CLI discovery is unavailable', async () => {
    const homeAccess = createHomeAccess({
      '.codex/config.toml': '[mcp_servers.legacy]\ncommand = "legacy"',
    });
    const cliCatalog: CodexMcpCatalogReader = {
      discoverCatalog: jest.fn().mockResolvedValue({
        kind: 'unavailable',
        diagnostics: 'Codex MCP catalog timed out',
      }),
    };

    await expect(new CodexMcpStorage(homeAccess, cliCatalog).load()).resolves.toEqual([
      expect.objectContaining({
        name: 'legacy',
        provenance: {
          owner: 'provider-cli',
          source: '~/.codex/config.toml',
          readOnly: true,
        },
      }),
    ]);
    expect(homeAccess.readMcpConfig).toHaveBeenCalledTimes(1);
  });

  it('does not fall back when CLI returns a valid empty catalog', async () => {
    const homeAccess = createHomeAccess({
      '.codex/config.toml': '[mcp_servers.legacy]\ncommand = "legacy"',
    });
    const cliCatalog: CodexMcpCatalogReader = {
      discoverCatalog: jest.fn().mockResolvedValue({ kind: 'available', servers: [] }),
    };

    await expect(new CodexMcpStorage(homeAccess, cliCatalog).load()).resolves.toEqual([]);
    expect(homeAccess.readMcpConfig).not.toHaveBeenCalled();
  });
});
