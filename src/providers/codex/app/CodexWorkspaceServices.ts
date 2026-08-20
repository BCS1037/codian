import { McpServerCatalog } from '../../../core/mcp/McpServerCatalog';
import type { ProviderCommandCatalog } from '../../../core/providers/commands/ProviderCommandCatalog';
import type { ProviderVaultEntryRepository } from '../../../core/providers/commands/ProviderVaultEntryRepository';
import type { ProviderHost } from '../../../core/providers/ProviderHost';
import { ProviderWorkspaceRegistry } from '../../../core/providers/ProviderWorkspaceRegistry';
import type {
  ProviderCliResolver,
  ProviderModelCatalogRefreshResult,
  ProviderTransitionOwnerContext,
  ProviderWorkspaceRegistration,
  ProviderWorkspaceServices,
} from '../../../core/providers/types';
import type { VaultFileAdapter } from '../../../core/storage/VaultFileAdapter';
import { getVaultPath } from '../../../utils/path';
import { CodexAgentMentionProvider } from '../agents/CodexAgentMentionProvider';
import { CodexSkillCatalog, CodexVaultSkillRepository } from '../commands/CodexSkillCatalog';
import { CodexCliResolver } from '../runtime/CodexCliResolver';
import { CodexMcpCatalogService } from '../runtime/CodexMcpCatalogService';
import { CodexModelCatalogCoordinator } from '../runtime/CodexModelCatalogCoordinator';
import { CodexModelDiscoveryService } from '../runtime/CodexModelDiscoveryService';
import { getCodexProviderSettings } from '../settings';
import { CodexSkillListingService } from '../skills/CodexSkillListingService';
import type { CodexHomeAccess } from '../storage/CodexHomeAccess';
import { CodexHomeFileAccess } from '../storage/CodexHomeAccess';
import { CodexMcpStorage } from '../storage/CodexMcpStorage';
import { CodexSkillStorage } from '../storage/CodexSkillStorage';
import { CodexSubagentStorage } from '../storage/CodexSubagentStorage';
import { codexSettingsTabRenderer } from '../ui/CodexSettingsTab';

export interface CodexWorkspaceServices extends ProviderWorkspaceServices {
  mcpCatalog: McpServerCatalog;
  subagentStorage: CodexSubagentStorage;
  commandCatalog: ProviderCommandCatalog;
  vaultCommandRepository: ProviderVaultEntryRepository & { refresh(): Promise<void> };
  agentMentionProvider: CodexAgentMentionProvider;
  cliResolver: ProviderCliResolver;
  modelCatalogCoordinator: CodexModelCatalogCoordinator;
  refreshModelCatalog(
    context?: ProviderTransitionOwnerContext,
  ): Promise<ProviderModelCatalogRefreshResult>;
}

function createCodexCliResolver(): ProviderCliResolver {
  return new CodexCliResolver();
}

export async function createCodexWorkspaceServices(
  plugin: ProviderHost,
  vaultAdapter: VaultFileAdapter,
  homeAccess: CodexHomeAccess = new CodexHomeFileAccess(),
): Promise<CodexWorkspaceServices> {
  const cliMcpCatalog = new CodexMcpCatalogService(plugin);
  const mcpStorage = new CodexMcpStorage(homeAccess, cliMcpCatalog);
  const mcpCatalog = new McpServerCatalog(mcpStorage);
  const subagentStorage = new CodexSubagentStorage(vaultAdapter);
  const agentMentionProvider = new CodexAgentMentionProvider(subagentStorage);

  const skillListProvider = new CodexSkillListingService(plugin);
  const modelDiscovery = new CodexModelDiscoveryService(plugin);
  const modelCatalogCoordinator = new CodexModelCatalogCoordinator(plugin, modelDiscovery);
  const commandCatalog = new CodexSkillCatalog(skillListProvider);
  const vaultCommandRepository = new CodexVaultSkillRepository(
    new CodexSkillStorage(vaultAdapter, homeAccess),
    skillListProvider,
    getVaultPath(plugin.app),
  );

  if (getCodexProviderSettings(plugin.settings).enabled) {
    plugin.app.workspace.onLayoutReady(() => {
      void modelCatalogCoordinator.ensureFresh('layout-ready');
    });
  }

  return {
    mcpCatalog,
    mcpSourcePath: 'codex mcp list --json (fallback: ~/.codex/config.toml)',
    subagentStorage,
    commandCatalog,
    vaultCommandRepository,
    agentMentionProvider,
    cliResolver: createCodexCliResolver(),
    modelCatalogCoordinator,
    settingsTabRenderer: codexSettingsTabRenderer,
    refreshAgentMentions: async () => {
      await agentMentionProvider.loadAgents();
    },
    refreshModelCatalog: async context => modelCatalogCoordinator.refreshModelCatalog(context),
    prepareSettings: async () => {
      await Promise.all([
        mcpCatalog.loadServers(),
        agentMentionProvider.loadAgents(),
      ]);
    },
    dispose: () => modelCatalogCoordinator.dispose(),
  };
}

export const codexWorkspaceRegistration: ProviderWorkspaceRegistration<CodexWorkspaceServices> = {
  initialize: async ({ plugin, vaultAdapter }) => createCodexWorkspaceServices(
    plugin,
    vaultAdapter,
  ),
};

export function maybeGetCodexWorkspaceServices(): CodexWorkspaceServices | null {
  return ProviderWorkspaceRegistry.getServices('codex') as CodexWorkspaceServices | null;
}

export function getCodexWorkspaceServices(): CodexWorkspaceServices {
  return ProviderWorkspaceRegistry.requireServices('codex') as CodexWorkspaceServices;
}
