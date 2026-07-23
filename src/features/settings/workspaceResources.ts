import type { ProviderCommandEntry } from '../../core/providers/commands/ProviderCommandEntry';
import { ProviderWorkspaceRegistry } from '../../core/providers/ProviderWorkspaceRegistry';
import type { ProviderId, ProviderSettingsSectionId } from '../../core/providers/types';

export type WorkspaceResourceSection = Extract<
  ProviderSettingsSectionId,
  'skills' | 'agents' | 'mcp' | 'commands'
>;

export type WorkspaceResourceStatus = 'available' | 'connected' | 'disabled' | 'readonly';

export interface WorkspaceResourceRow {
  key: string;
  name: string;
  providerIds: ProviderId[];
  source: string;
  status: WorkspaceResourceStatus;
}

function fallbackCommandSource(entry: ProviderCommandEntry): string {
  if (entry.scope === 'runtime' || entry.source === 'sdk' || entry.source === 'builtin') {
    return 'Provider runtime';
  }
  if (entry.providerId === 'claude') {
    return entry.kind === 'skill'
      ? `.claude/skills/${entry.name}/SKILL.md`
      : `.claude/commands/${entry.name}.md`;
  }
  return 'Provider native storage';
}

function mergeRows(rows: WorkspaceResourceRow[], providerOrder: readonly ProviderId[]): WorkspaceResourceRow[] {
  const merged = new Map<string, WorkspaceResourceRow>();
  for (const row of rows) {
    const mergeKey = `${row.name.toLowerCase()}\u0000${row.source}`;
    const existing = merged.get(mergeKey);
    if (!existing) {
      merged.set(mergeKey, { ...row, providerIds: [...row.providerIds] });
      continue;
    }
    for (const providerId of row.providerIds) {
      if (!existing.providerIds.includes(providerId)) {
        existing.providerIds.push(providerId);
      }
    }
  }

  const order = new Map(providerOrder.map((providerId, index) => [providerId, index]));
  return [...merged.values()]
    .map(row => ({
      ...row,
      providerIds: row.providerIds.sort((left, right) => (
        (order.get(left) ?? Number.MAX_SAFE_INTEGER) - (order.get(right) ?? Number.MAX_SAFE_INTEGER)
      )),
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

async function loadCommandResources(
  providerIds: readonly ProviderId[],
  section: 'skills' | 'commands',
): Promise<WorkspaceResourceRow[]> {
  const rows = await Promise.all(providerIds.map(async (providerId) => {
    const repository = ProviderWorkspaceRegistry.getVaultCommandRepository(providerId);
    if (!repository) return [];
    try {
      const entries = await repository.listVaultEntries();
      return entries
        .filter(entry => entry.kind === (section === 'skills' ? 'skill' : 'command'))
        .map((entry): WorkspaceResourceRow => ({
          key: `${providerId}:${entry.id}`,
          name: entry.name,
          providerIds: [providerId],
          source: entry.sourcePath ?? fallbackCommandSource(entry),
          status: entry.isEditable ? 'available' : 'readonly',
        }));
    } catch {
      return [];
    }
  }));
  return rows.flat();
}

function loadAgentResources(providerIds: readonly ProviderId[]): WorkspaceResourceRow[] {
  return providerIds.flatMap((providerId) => {
    const provider = ProviderWorkspaceRegistry.getAgentMentionProvider(providerId);
    if (!provider) return [];
    return provider.searchAgents('').map((agent): WorkspaceResourceRow => ({
      key: `${providerId}:${agent.id}`,
      name: agent.name,
      providerIds: [providerId],
      source: agent.filePath ?? `${providerId} ${agent.source} agents`,
      status: agent.source === 'vault' ? 'available' : 'readonly',
    }));
  });
}

function loadMcpResources(providerIds: readonly ProviderId[]): WorkspaceResourceRow[] {
  return providerIds.flatMap((providerId) => {
    const services = ProviderWorkspaceRegistry.getServices(providerId);
    const manager = services?.mcpServerManager;
    if (!manager) return [];
    const source = services.mcpSourcePath ?? `${providerId} MCP configuration`;
    return manager.getServers().map((server): WorkspaceResourceRow => ({
      key: `${providerId}:${server.name}`,
      name: server.name,
      providerIds: [providerId],
      source,
      status: server.enabled ? 'connected' : 'disabled',
    }));
  });
}

export async function loadWorkspaceResources(
  providerIds: readonly ProviderId[],
  section: WorkspaceResourceSection,
): Promise<WorkspaceResourceRow[]> {
  const rows = section === 'skills' || section === 'commands'
    ? await loadCommandResources(providerIds, section)
    : section === 'agents'
      ? loadAgentResources(providerIds)
      : loadMcpResources(providerIds);
  return mergeRows(rows, providerIds);
}
