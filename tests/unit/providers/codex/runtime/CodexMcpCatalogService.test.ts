import type { ProviderHost } from '@/core/providers/ProviderHost';
import {
  type CodexMcpCatalogCommandRequest,
  type CodexMcpCatalogCommandResult,
  type CodexMcpCatalogCommandRunner,
  CodexMcpCatalogService,
  parseCodexMcpListJson,
  SpawnCodexMcpCatalogCommandRunner,
} from '@/providers/codex/runtime/CodexMcpCatalogService';

function makeHost(enabled = true): ProviderHost {
  return {
    app: {
      vault: {
        adapter: { basePath: '/vault' },
      },
    },
    getActiveEnvironmentVariables: jest.fn(() => 'OPENAI_API_KEY=secret\nCUSTOM=enabled'),
    getResolvedProviderCliPath: jest.fn(async () => '/opt/codex/bin/codex'),
    settings: {
      providerConfigs: {
        codex: { enabled },
      },
      sharedEnvironmentVariables: 'HTTPS_PROXY=https://proxy.example',
    },
  } as unknown as ProviderHost;
}

function makeRunner(result: CodexMcpCatalogCommandResult): CodexMcpCatalogCommandRunner & {
  requests: CodexMcpCatalogCommandRequest[];
} {
  const requests: CodexMcpCatalogCommandRequest[] = [];
  return {
    requests,
    run: jest.fn(async (request) => {
      requests.push(request);
      return result;
    }),
  };
}

describe('parseCodexMcpListJson', () => {
  it('normalizes provider-owned transports without copying secrets', () => {
    const result = parseCodexMcpListJson(JSON.stringify([
      {
        name: 'local',
        enabled: true,
        transport: {
          type: 'stdio',
          command: 'node',
          args: ['server.mjs'],
          env: { TOKEN: 'secret-value' },
          env_vars: ['TOKEN'],
        },
      },
      {
        name: 'remote',
        enabled: false,
        transport: {
          type: 'streamable_http',
          url: 'https://example.test/mcp',
          http_headers: { 'Content-Type': 'application/json' },
          env_http_headers: { Authorization: 'TOKEN' },
        },
      },
    ]));

    expect(result).toEqual({
      complete: true,
      servers: [
        {
          name: 'local',
          config: { command: 'node', args: ['server.mjs'] },
          enabled: true,
          contextSaving: false,
          provenance: {
            owner: 'provider-cli',
            source: 'codex mcp list --json',
            readOnly: true,
          },
        },
        {
          name: 'remote',
          config: {
            type: 'http',
            url: 'https://example.test/mcp',
            headers: { 'Content-Type': 'application/json' },
          },
          enabled: false,
          contextSaving: false,
          provenance: {
            owner: 'provider-cli',
            source: 'codex mcp list --json',
            readOnly: true,
          },
        },
      ],
    });
    expect(JSON.stringify(result)).not.toContain('secret-value');
  });

  it('marks catalog incomplete when CLI returns an unsupported entry', () => {
    expect(parseCodexMcpListJson(JSON.stringify([
      { name: 'future', enabled: true, transport: { type: 'future_transport' } },
    ]))).toEqual({ complete: false, servers: [] });
  });

  it('rejects non-array output', () => {
    expect(() => parseCodexMcpListJson('{"servers":[]}')).toThrow('invalid JSON catalog');
  });
});

describe('CodexMcpCatalogService', () => {
  it('runs the resolved Codex CLI in read-only catalog mode', async () => {
    const runner = makeRunner({
      exitCode: 0,
      stdout: JSON.stringify([
        {
          name: 'local',
          enabled: true,
          transport: { type: 'stdio', command: 'node', args: ['server.mjs'] },
        },
      ]),
    });
    const result = await new CodexMcpCatalogService(makeHost(), { runner }).discoverCatalog();

    expect(result).toEqual({
      kind: 'available',
      servers: [{
        name: 'local',
        config: { command: 'node', args: ['server.mjs'] },
        enabled: true,
        contextSaving: false,
        provenance: {
          owner: 'provider-cli',
          source: 'codex mcp list --json',
          readOnly: true,
        },
      }],
    });
    expect(runner.requests).toHaveLength(1);
    expect(runner.requests[0]).toMatchObject({
      args: ['mcp', 'list', '--json'],
      command: '/opt/codex/bin/codex',
      cwd: '/vault',
    });
    expect(runner.requests[0].env).toMatchObject({
      CUSTOM: 'enabled',
      OPENAI_API_KEY: 'secret',
    });
  });

  it('returns concise diagnostics without exposing CLI output', async () => {
    const runner = makeRunner({
      exitCode: 17,
      stdout: 'private output token=secret-value',
    });

    const result = await new CodexMcpCatalogService(makeHost(), { runner }).discoverCatalog();

    expect(result).toEqual({
      diagnostics: 'Codex MCP catalog exited with code 17',
      kind: 'unavailable',
    });
    expect(JSON.stringify(result)).not.toContain('secret-value');
  });

  it('falls back through storage when CLI output is incomplete', async () => {
    const runner = makeRunner({
      exitCode: 0,
      stdout: JSON.stringify([{ name: 'future', transport: { type: 'future' } }]),
    });

    await expect(
      new CodexMcpCatalogService(makeHost(), { runner }).discoverCatalog(),
    ).resolves.toEqual({
      diagnostics: 'Codex MCP catalog contained unsupported entries',
      kind: 'unavailable',
    });
  });

  it('does not invoke CLI when Codex is disabled', async () => {
    const runner = makeRunner({ exitCode: 0, stdout: '[]' });

    await expect(
      new CodexMcpCatalogService(makeHost(false), { runner }).discoverCatalog(),
    ).resolves.toEqual({
      kind: 'unavailable',
      diagnostics: 'Codex MCP catalog skipped because the provider is disabled',
    });
    expect(runner.requests).toHaveLength(0);
  });
});

describe('SpawnCodexMcpCatalogCommandRunner', () => {
  it('enforces command timeout', async () => {
    const runner = new SpawnCodexMcpCatalogCommandRunner();

    await expect(runner.run({
      args: ['-e', 'setTimeout(() => {}, 10_000)'],
      command: process.execPath,
      cwd: process.cwd(),
      env: process.env,
      timeoutMs: 20,
    })).resolves.toEqual({
      exitCode: null,
      stdout: '',
      termination: 'timeout',
    });
  });
});
