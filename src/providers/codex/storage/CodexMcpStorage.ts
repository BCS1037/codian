import { parse as parseToml } from 'smol-toml';

import type { McpStorageAdapter } from '../../../core/mcp/McpServerManager';
import type { HomeFileAdapter } from '../../../core/storage/HomeFileAdapter';
import type { ManagedMcpServer, McpServerConfig } from '../../../core/types';
import type { CodexMcpCatalogResult } from '../runtime/CodexMcpCatalogService';

export const CODEX_MCP_CONFIG_PATH = '.codex/config.toml';
export const CODEX_MCP_CONFIG_SOURCE = '~/.codex/config.toml';

export interface CodexMcpCatalogReader {
  discoverCatalog(): Promise<CodexMcpCatalogResult>;
}

type CodexMcpConfig = Record<string, unknown>;

/** Read-only catalog for MCP servers owned by the Codex CLI. */
export class CodexMcpStorage implements McpStorageAdapter {
  constructor(
    private readonly homeAdapter: Pick<HomeFileAdapter, 'exists' | 'read'>,
    private readonly cliCatalog?: CodexMcpCatalogReader,
  ) {}

  async load(): Promise<ManagedMcpServer[]> {
    if (this.cliCatalog) {
      const cliResult = await this.cliCatalog.discoverCatalog().catch(() => null);
      if (cliResult?.kind === 'available') {
        return cliResult.servers;
      }
    }

    return this.loadFromConfigFile();
  }

  private async loadFromConfigFile(): Promise<ManagedMcpServer[]> {
    try {
      if (!(await this.homeAdapter.exists(CODEX_MCP_CONFIG_PATH))) {
        return [];
      }

      const parsed = parseToml(await this.homeAdapter.read(CODEX_MCP_CONFIG_PATH)) as CodexMcpConfig;
      const configuredServers = asRecord(parsed.mcp_servers);
      if (!configuredServers) {
        return [];
      }

      const servers = Object.entries(configuredServers).flatMap(([name, rawConfig]) => {
        const config = parseMcpServer(rawConfig);
        return config ? [{ name, config, enabled: true, contextSaving: false }] : [];
      });
      return servers.map(server => ({
        ...server,
        provenance: {
          owner: 'provider-cli' as const,
          source: CODEX_MCP_CONFIG_SOURCE,
          readOnly: true,
        },
      }));
    } catch {
      return [];
    }
  }
}

function parseMcpServer(rawConfig: unknown): McpServerConfig | null {
  const config = asRecord(rawConfig);
  if (!config) {
    return null;
  }

  if (typeof config.command === 'string') {
    const args = asStringArray(config.args);
    const env = asStringRecord(config.env);
    return {
      command: config.command,
      ...(args ? { args } : {}),
      ...(env ? { env } : {}),
    };
  }

  if (typeof config.url === 'string') {
    const headers = asStringRecord(config.http_headers);
    return {
      type: 'http',
      url: config.url,
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
  return Array.isArray(value) && value.every(item => typeof item === 'string') ? value : null;
}

function asStringRecord(value: unknown): Record<string, string> | null {
  const record = asRecord(value);
  if (!record || !Object.values(record).every(item => typeof item === 'string')) {
    return null;
  }
  return record as Record<string, string>;
}
