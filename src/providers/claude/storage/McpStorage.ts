import { Notice } from 'obsidian';

import { NotifiedMutationError } from '../../../core/storage/NotifiedMutationError';
import type { VaultFileAdapter } from '../../../core/storage/VaultFileAdapter';
import type {
  ManagedMcpConfigFile,
  ManagedMcpServer,
  McpServerConfig,
} from '../../../core/types';
import { DEFAULT_MCP_SERVER, isValidMcpServerConfig } from '../../../core/types';

export const MCP_CONFIG_PATH = '.claude/mcp.json';
const INVALID_MCP_CONFIG_MESSAGE =
  'Failed to update .claude/mcp.json because it contains invalid JSON.';

export class McpStorage {
  constructor(private adapter: VaultFileAdapter) {}

  async load(): Promise<ManagedMcpServer[]> {
    try {
      if (!(await this.adapter.exists(MCP_CONFIG_PATH))) {
        return [];
      }

      const content = await this.adapter.read(MCP_CONFIG_PATH);
      const file = JSON.parse(content) as ManagedMcpConfigFile;

      if (!file.mcpServers || typeof file.mcpServers !== 'object') {
        return [];
      }

      const codianMeta = file._codian?.servers ?? {};
      const servers: ManagedMcpServer[] = [];

      for (const [name, config] of Object.entries(file.mcpServers)) {
        if (!isValidMcpServerConfig(config)) {
          continue;
        }

        const meta = codianMeta[name] ?? {};
        const disabledTools = Array.isArray(meta.disabledTools)
          ? meta.disabledTools.filter((tool) => typeof tool === 'string')
          : undefined;
        const normalizedDisabledTools =
          disabledTools && disabledTools.length > 0 ? disabledTools : undefined;

        servers.push({
          name,
          config,
          enabled: meta.enabled ?? DEFAULT_MCP_SERVER.enabled,
          contextSaving: meta.contextSaving ?? DEFAULT_MCP_SERVER.contextSaving,
          disabledTools: normalizedDisabledTools,
          description: meta.description,
        });
      }

      return servers;
    } catch {
      return [];
    }
  }

  async save(servers: ManagedMcpServer[]): Promise<void> {
    const mcpServers: Record<string, McpServerConfig> = {};
    const codianServers: Record<
      string,
      { enabled?: boolean; contextSaving?: boolean; disabledTools?: string[]; description?: string }
    > = {};

    for (const server of servers) {
      mcpServers[server.name] = server.config;

      // Only store Codian metadata if different from defaults
      const meta: {
        enabled?: boolean;
        contextSaving?: boolean;
        disabledTools?: string[];
        description?: string;
      } = {};

      if (server.enabled !== DEFAULT_MCP_SERVER.enabled) {
        meta.enabled = server.enabled;
      }
      if (server.contextSaving !== DEFAULT_MCP_SERVER.contextSaving) {
        meta.contextSaving = server.contextSaving;
      }
      const normalizedDisabledTools = server.disabledTools
        ?.map((tool) => tool.trim())
        .filter((tool) => tool.length > 0);
      if (normalizedDisabledTools && normalizedDisabledTools.length > 0) {
        meta.disabledTools = normalizedDisabledTools;
      }
      if (server.description) {
        meta.description = server.description;
      }

      if (Object.keys(meta).length > 0) {
        codianServers[server.name] = meta;
      }
    }

    let existing: Record<string, unknown> | null = null;
    if (await this.adapter.exists(MCP_CONFIG_PATH)) {
      const raw = await this.adapter.read(MCP_CONFIG_PATH);
      try {
        const parsed: unknown = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') {
          existing = parsed as Record<string, unknown>;
        }
      } catch {
        new Notice(INVALID_MCP_CONFIG_MESSAGE);
        throw new NotifiedMutationError(INVALID_MCP_CONFIG_MESSAGE);
      }
    }

    const file: Record<string, unknown> = existing ? { ...existing } : {};
    file.mcpServers = mcpServers;

    const existingCodian =
      existing && typeof existing._codian === 'object'
        ? (existing._codian as Record<string, unknown>)
        : null;

    if (Object.keys(codianServers).length > 0) {
      file._codian = { ...(existingCodian ?? {}), servers: codianServers };
    } else if (existingCodian) {
      const rest = { ...existingCodian };
      delete rest.servers;
      if (Object.keys(rest).length > 0) {
        file._codian = rest;
      } else {
        delete file._codian;
      }
    } else {
      delete file._codian;
    }

    const content = JSON.stringify(file, null, 2);
    await this.adapter.write(MCP_CONFIG_PATH, content);
  }

  async exists(): Promise<boolean> {
    return this.adapter.exists(MCP_CONFIG_PATH);
  }
}
