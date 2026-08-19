import { spawn } from 'node:child_process';

import type { ProviderHost } from '../../../core/providers/ProviderHost';
import type { ProviderTransitionOwnerContext } from '../../../core/providers/types';
import type { ManagedMcpServer, McpServerConfig } from '../../../core/types';
import { getVaultPath } from '../../../utils/path';
import {
  resolveWindowsCmdShimSpawnSpec,
  terminateSpawnedProcess,
} from '../../../utils/windowsCmdShim';
import { getCodexProviderSettings } from '../settings';
import { buildCodexAppServerEnvironment } from './codexAppServerSupport';
import { resolveCodexExecutionTargetAsync } from './CodexExecutionTargetResolver';
import {
  buildCodexCommandLaunchSpec,
} from './CodexLaunchSpecBuilder';

const CODEX_MCP_CLI_ARGS = Object.freeze(['mcp', 'list', '--json']);
const CODEX_MCP_CATALOG_TIMEOUT_MS = 10_000;
const MAX_STDOUT_BYTES = 512 * 1024;
const CODEX_MCP_PROVENANCE = Object.freeze({
  owner: 'provider-cli' as const,
  source: 'codex mcp list --json',
  readOnly: true,
});

export interface CodexMcpCatalogCommandRequest {
  args: string[];
  command: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  timeoutMs: number;
}

export interface CodexMcpCatalogCommandResult {
  exitCode: number | null;
  stdout: string;
  termination?: 'abort' | 'error' | 'output-limit' | 'timeout';
}

export interface CodexMcpCatalogCommandRunner {
  run(request: CodexMcpCatalogCommandRequest): Promise<CodexMcpCatalogCommandResult>;
}

export type CodexMcpCatalogResult =
  | {
    kind: 'available';
    servers: ManagedMcpServer[];
  }
  | {
    kind: 'unavailable';
    diagnostics: string;
  };

export interface CodexMcpCatalogServiceOptions {
  runner?: CodexMcpCatalogCommandRunner;
  timeoutMs?: number;
}

export interface ParsedCodexMcpListJson {
  complete: boolean;
  servers: ManagedMcpServer[];
}

export function parseCodexMcpListJson(output: string): ParsedCodexMcpListJson {
  let value: unknown;
  try {
    value = JSON.parse(output);
  } catch {
    throw new Error('Codex MCP catalog returned invalid JSON catalog');
  }

  if (!Array.isArray(value)) {
    throw new Error('Codex MCP catalog returned invalid JSON catalog');
  }

  let complete = true;
  const names = new Set<string>();
  const servers: ManagedMcpServer[] = [];

  for (const rawServer of value) {
    const server = parseCodexMcpServer(rawServer);
    if (!server || names.has(server.name)) {
      complete = false;
      continue;
    }
    names.add(server.name);
    servers.push(server);
  }

  return { complete, servers };
}

export class CodexMcpCatalogService {
  private readonly runner: CodexMcpCatalogCommandRunner;

  constructor(
    private readonly plugin: ProviderHost,
    private readonly options: CodexMcpCatalogServiceOptions = {},
  ) {
    this.runner = options.runner ?? new SpawnCodexMcpCatalogCommandRunner();
  }

  async discoverCatalog(
    signal?: AbortSignal,
    ownerContext?: ProviderTransitionOwnerContext,
  ): Promise<CodexMcpCatalogResult> {
    if (!getCodexProviderSettings(this.plugin.settings).enabled) {
      return {
        diagnostics: 'Codex MCP catalog skipped because the provider is disabled',
        kind: 'unavailable',
      };
    }

    if (signal?.aborted) {
      return { diagnostics: 'Codex MCP catalog was cancelled', kind: 'unavailable' };
    }

    try {
      const hostVaultPath = getVaultPath(this.plugin.app) ?? process.cwd();
      const executionTarget = await resolveCodexExecutionTargetAsync({
        settings: this.plugin.settings,
        hostVaultPath,
      });
      const resolvedCliCommand = await this.plugin.getResolvedProviderCliPath('codex', {
        ...ownerContext,
        executionTarget,
      });
      const launchSpec = buildCodexCommandLaunchSpec({
        settings: this.plugin.settings,
        resolvedCliCommand,
        hostVaultPath,
        env: buildCodexAppServerEnvironment(this.plugin),
        executionTarget,
        args: CODEX_MCP_CLI_ARGS,
      });
      const result = await this.runner.run({
        args: launchSpec.args,
        command: launchSpec.command,
        cwd: launchSpec.spawnCwd,
        env: launchSpec.env,
        signal,
        timeoutMs: this.options.timeoutMs ?? CODEX_MCP_CATALOG_TIMEOUT_MS,
      });
      const diagnostics = describeCodexMcpCommandFailure(result);
      if (diagnostics) {
        return { diagnostics, kind: 'unavailable' };
      }

      const parsed = parseCodexMcpListJson(result.stdout);
      if (!parsed.complete) {
        return {
          diagnostics: 'Codex MCP catalog contained unsupported entries',
          kind: 'unavailable',
        };
      }

      return { kind: 'available', servers: parsed.servers };
    } catch (error) {
      if (signal?.aborted) {
        return { diagnostics: 'Codex MCP catalog was cancelled', kind: 'unavailable' };
      }

      const message = error instanceof Error ? error.message : '';
      return {
        diagnostics: message.includes('invalid JSON catalog')
          ? message
          : 'Codex MCP catalog could not be read',
        kind: 'unavailable',
      };
    }
  }
}

export class SpawnCodexMcpCatalogCommandRunner implements CodexMcpCatalogCommandRunner {
  run(request: CodexMcpCatalogCommandRequest): Promise<CodexMcpCatalogCommandResult> {
    if (request.signal?.aborted) {
      return Promise.resolve({ exitCode: null, stdout: '', termination: 'abort' });
    }

    return new Promise((resolve) => {
      const spawnSpec = resolveWindowsCmdShimSpawnSpec(request);
      let proc: ReturnType<typeof spawn>;
      try {
        proc = spawn(spawnSpec.command, spawnSpec.args, {
          cwd: request.cwd,
          env: request.env,
          stdio: ['ignore', 'pipe', 'ignore'],
          windowsHide: true,
          ...(spawnSpec.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
        });
      } catch {
        resolve({ exitCode: null, stdout: '', termination: 'error' });
        return;
      }

      const chunks: Buffer[] = [];
      let byteLength = 0;
      let settled = false;

      const finish = (result: CodexMcpCatalogCommandResult): void => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timeout);
        request.signal?.removeEventListener('abort', onAbort);
        resolve(result);
      };
      const terminate = (): void => {
        terminateSpawnedProcess(proc, 'SIGKILL', spawn, spawnSpec);
      };
      const onAbort = (): void => {
        terminate();
        finish({ exitCode: null, stdout: '', termination: 'abort' });
      };
      const timeout = window.setTimeout(() => {
        terminate();
        finish({ exitCode: null, stdout: '', termination: 'timeout' });
      }, request.timeoutMs);

      request.signal?.addEventListener('abort', onAbort, { once: true });
      proc.stdout?.on('data', (chunk: Buffer | string) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        byteLength += buffer.byteLength;
        if (byteLength > MAX_STDOUT_BYTES) {
          terminate();
          finish({ exitCode: null, stdout: '', termination: 'output-limit' });
          return;
        }
        chunks.push(buffer);
      });
      proc.once('error', () => {
        finish({ exitCode: null, stdout: '', termination: 'error' });
      });
      proc.once('close', (exitCode) => {
        finish({ exitCode, stdout: Buffer.concat(chunks).toString('utf8') });
      });
    });
  }
}

function parseCodexMcpServer(value: unknown): ManagedMcpServer | null {
  const rawServer = asRecord(value);
  const name = typeof rawServer?.name === 'string' ? rawServer.name.trim() : '';
  const transport = asRecord(rawServer?.transport);
  const config = transport ? parseCodexMcpTransport(transport) : null;
  if (!name || !config) {
    return null;
  }

  return {
    name,
    config,
    enabled: rawServer?.enabled !== false,
    contextSaving: false,
    provenance: { ...CODEX_MCP_PROVENANCE },
  };
}

function parseCodexMcpTransport(transport: Record<string, unknown>): McpServerConfig | null {
  if (typeof transport.command === 'string' && transport.command.trim()) {
    const args = asStringArray(transport.args);
    if (transport.args !== undefined && !args) {
      return null;
    }
    return {
      command: transport.command,
      ...(args ? { args } : {}),
    };
  }

  if (typeof transport.url === 'string' && transport.url.trim()) {
    const headers = asOptionalStringRecord(transport.http_headers);
    if (transport.http_headers !== undefined && !headers) {
      return null;
    }
    return {
      type: transport.type === 'sse' ? 'sse' : 'http',
      url: transport.url,
      ...(headers ? { headers } : {}),
    };
  }

  return null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function asStringArray(value: unknown): string[] | null {
  return Array.isArray(value) && value.every(item => typeof item === 'string')
    ? value
    : null;
}

function asOptionalStringRecord(value: unknown): Record<string, string> | null {
  if (value === undefined) {
    return null;
  }
  const record = asRecord(value);
  if (!record || !Object.values(record).every(item => typeof item === 'string')) {
    return null;
  }
  return record as Record<string, string>;
}

function describeCodexMcpCommandFailure(result: CodexMcpCatalogCommandResult): string | null {
  switch (result.termination) {
    case 'abort':
      return 'Codex MCP catalog was cancelled';
    case 'error':
      return 'Codex MCP catalog could not be started';
    case 'output-limit':
      return 'Codex MCP catalog returned too much output';
    case 'timeout':
      return 'Codex MCP catalog timed out';
    default:
      return result.exitCode === 0
        ? null
        : `Codex MCP catalog exited with code ${result.exitCode ?? 'unknown'}`;
  }
}
