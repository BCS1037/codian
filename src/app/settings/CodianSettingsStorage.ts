import {
  CODIAN_SETTINGS_PATH,
  LEGACY_CODIAN_SETTINGS_PATH,
} from '../../core/bootstrap/StoragePaths';
import {
  normalizeHiddenCommandList,
  normalizeHiddenProviderCommands,
} from '../../core/providers/commands/hiddenCommands';
import {
  getSharedEnvironmentVariables,
  inferEnvironmentSnippetScope,
  resolveEnvironmentSnippetScope,
} from '../../core/providers/providerEnvironment';
import { ProviderRegistry } from '../../core/providers/ProviderRegistry';
import type { VaultFileAdapter } from '../../core/storage/VaultFileAdapter';
import {
  CHAT_VIEW_PLACEMENTS,
  type ChatViewPlacement,
  type CodianSettings,
  type EnvironmentScope,
  type EnvSnippet,
  type HiddenProviderCommands,
  type ProviderConfigMap,
  type StoredInlineEditModelSelection,
} from '../../core/types/settings';
import { DEFAULT_CODIAN_SETTINGS } from './defaultSettings';

export {
  CODIAN_SETTINGS_PATH,
  LEGACY_CODIAN_SETTINGS_PATH,
};

export type StoredCodianSettings = CodianSettings;

const LEGACY_STRIPPED_SHARED_SETTING_FIELDS = [
  'activeConversationId',
  'show1MModel',
  'hiddenSlashCommands',
  'slashCommands',
  'allowExternalAccess',
  'allowedExportPaths',
  'enableBlocklist',
  'blockedCommands',
  'openInMainTab',
  'locale',
] as const;

function getProviderSettingsAdapters() {
  return ProviderRegistry.getRegisteredProviderIds().map(providerId => ({
    adapter: ProviderRegistry.getSettingsStorageAdapter(providerId),
    providerId,
  }));
}

function getLegacyTopLevelProviderFields(): string[] {
  return getProviderSettingsAdapters().flatMap(({ adapter }) => adapter.legacyTopLevelFields ?? []);
}

function stripLegacyFields(settings: Record<string, unknown>): Record<string, unknown> {
  const cleaned = { ...settings };
  for (const key of [
    ...LEGACY_STRIPPED_SHARED_SETTING_FIELDS,
    ...getLegacyTopLevelProviderFields(),
  ]) {
    delete cleaned[key];
  }
  return cleaned;
}

function isChatViewPlacement(value: unknown): value is ChatViewPlacement {
  return typeof value === 'string'
    && (CHAT_VIEW_PLACEMENTS as readonly string[]).includes(value);
}

function normalizeChatViewPlacement(
  value: unknown,
  legacyOpenInMainTab: unknown,
): ChatViewPlacement {
  if (isChatViewPlacement(value)) {
    return value;
  }

  if (typeof legacyOpenInMainTab === 'boolean') {
    return legacyOpenInMainTab ? 'main-tab' : 'right-sidebar';
  }

  return DEFAULT_CODIAN_SETTINGS.chatViewPlacement;
}

function shouldPersistChatViewPlacementMigration(
  stored: Record<string, unknown>,
  normalized: ChatViewPlacement,
): boolean {
  return 'openInMainTab' in stored
    || (
      'chatViewPlacement' in stored
      && stored.chatViewPlacement !== normalized
    );
}

function normalizeProviderConfigs(value: unknown): ProviderConfigMap {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

  const result: ProviderConfigMap = {};
  for (const [providerId, config] of Object.entries(value as Record<string, unknown>)) {
    if (config && typeof config === 'object' && !Array.isArray(config)) {
      result[providerId] = { ...(config as Record<string, unknown>) };
    }
  }
  return result;
}

function projectPersistableProviderConfigs(value: unknown): {
  changed: boolean;
  providerConfigs: ProviderConfigMap;
} {
  const providerConfigs = normalizeProviderConfigs(value);
  let changed = false;

  for (const { adapter, providerId } of getProviderSettingsAdapters()) {
    const fields = adapter.runtimeOnlyFields ?? [];
    const config = providerConfigs[providerId];
    if (!config) {
      continue;
    }

    for (const field of fields) {
      if (field in config) {
        delete config[field];
        changed = true;
      }
    }
  }

  return { changed, providerConfigs };
}

function hasHostScopedProviderConfigNormalization(
  original: ProviderConfigMap,
  normalized: unknown,
): boolean {
  if (!normalized || typeof normalized !== 'object' || Array.isArray(normalized)) {
    return false;
  }

  const normalizedConfigs = normalized as ProviderConfigMap;
  for (const { adapter, providerId } of getProviderSettingsAdapters()) {
    const fields = adapter.hostScopedFields ?? [];
    const originalConfig = original[providerId];
    const normalizedConfig = normalizedConfigs[providerId];
    if (!originalConfig || !normalizedConfig) {
      continue;
    }

    for (const field of fields) {
      if (
        field in originalConfig
        && JSON.stringify(originalConfig[field]) !== JSON.stringify(normalizedConfig[field])
      ) {
        return true;
      }
    }
  }

  return false;
}

function isEnvironmentScope(value: unknown): value is EnvironmentScope {
  return value === 'shared' || (typeof value === 'string' && value.startsWith('provider:'));
}

function normalizeContextLimits(value: unknown): Record<string, number> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }

  const result: Record<string, number> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === 'number' && Number.isFinite(entry) && entry > 0) {
      result[key] = entry;
    }
  }

  return Object.keys(result).length > 0 ? result : undefined;
}

function normalizeModelAliases(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

  const result: Record<string, string> = {};
  for (const [key, alias] of Object.entries(value)) {
    if (typeof alias !== 'string') {
      continue;
    }

    const modelId = key.trim();
    const normalizedAlias = alias.trim();
    if (modelId && normalizedAlias) {
      result[modelId] = normalizedAlias;
    }
  }

  return result;
}

function normalizeStoredInlineEditModelSelection(
  value: unknown,
): StoredInlineEditModelSelection | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const candidate = value as Record<string, unknown>;
  const providerId = typeof candidate.providerId === 'string' ? candidate.providerId.trim() : '';
  const model = typeof candidate.model === 'string' ? candidate.model.trim() : '';
  if (!providerId || !model || !ProviderRegistry.getRegisteredProviderIds().includes(providerId)) {
    return null;
  }
  const reasoning = typeof candidate.reasoning === 'string' ? candidate.reasoning.trim() : '';
  return reasoning ? { providerId, model, reasoning } : { providerId, model };
}

function normalizeEnvSnippets(value: unknown): EnvSnippet[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const snippets: EnvSnippet[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      continue;
    }

    const candidate = item as Record<string, unknown>;
    if (
      typeof candidate.id !== 'string'
      || typeof candidate.name !== 'string'
      || typeof candidate.description !== 'string'
      || typeof candidate.envVars !== 'string'
    ) {
      continue;
    }

    const modelAliases = 'modelAliases' in candidate
      ? normalizeModelAliases(candidate.modelAliases)
      : undefined;

    snippets.push({
      id: candidate.id,
      name: candidate.name,
      description: candidate.description,
      envVars: candidate.envVars,
      scope: resolveEnvironmentSnippetScope(
        candidate.envVars,
        isEnvironmentScope(candidate.scope)
          ? candidate.scope
          : inferEnvironmentSnippetScope(candidate.envVars),
      ),
      contextLimits: normalizeContextLimits(candidate.contextLimits),
      modelAliases,
    });
  }

  return snippets;
}

function hasLegacyTopLevelProviderFields(stored: Record<string, unknown>): boolean {
  return getLegacyTopLevelProviderFields().some((key) => key in stored);
}

function mergeLegacyClaudeHiddenCommands(
  hiddenProviderCommands: HiddenProviderCommands,
  legacyHiddenSlashCommands: unknown,
): HiddenProviderCommands {
  const legacyCommands = normalizeHiddenCommandList(legacyHiddenSlashCommands);
  if (legacyCommands.length === 0 || hiddenProviderCommands.claude) {
    return hiddenProviderCommands;
  }

  return {
    ...hiddenProviderCommands,
    claude: legacyCommands,
  };
}

export class CodianSettingsStorage {
  constructor(private adapter: VaultFileAdapter) {}

  async load(): Promise<StoredCodianSettings> {
    const settingsPath = await this.getLoadPath();
    if (!settingsPath) {
      return this.getDefaults();
    }

    const content = await this.adapter.read(settingsPath);
    const stored = JSON.parse(content) as Record<string, unknown>;
    const hiddenProviderCommands = mergeLegacyClaudeHiddenCommands(
      normalizeHiddenProviderCommands(stored.hiddenProviderCommands),
      stored.hiddenSlashCommands,
    );
    const envSnippets = normalizeEnvSnippets(stored.envSnippets);
    const customModelAliases = normalizeModelAliases(stored.customModelAliases);
    const inlineEditModel = normalizeStoredInlineEditModelSelection(stored.inlineEditModel);
    const {
      changed: didStripRuntimeProviderConfig,
      providerConfigs,
    } = projectPersistableProviderConfigs(stored.providerConfigs);
    const chatViewPlacement = normalizeChatViewPlacement(
      stored.chatViewPlacement,
      stored.openInMainTab,
    );
    const legacyProviderSettings = {
      ...stored,
      hiddenProviderCommands,
      providerConfigs,
    };
    const storedWithoutLegacy = stripLegacyFields({
      ...legacyProviderSettings,
    });

    const legacyNormalized = {
      ...storedWithoutLegacy,
      sharedEnvironmentVariables: getSharedEnvironmentVariables(legacyProviderSettings),
      envSnippets,
      customModelAliases,
      inlineEditModel,
      hiddenProviderCommands,
      providerConfigs,
      chatViewPlacement,
    };

    const merged = {
      ...this.getDefaults(),
      ...legacyNormalized,
    };

    let didNormalizeProviderSettings = false;
    for (const { adapter } of getProviderSettingsAdapters()) {
      didNormalizeProviderSettings = adapter.normalizeStored(
        merged,
        legacyProviderSettings,
      ) || didNormalizeProviderSettings;
    }
    const didNormalizeHostScopedProviderConfigs = hasHostScopedProviderConfigNormalization(
      providerConfigs,
      merged.providerConfigs,
    );

    if (
      settingsPath !== CODIAN_SETTINGS_PATH
      || (
      hasLegacyTopLevelProviderFields(stored)
      || 'show1MModel' in stored
      || 'slashCommands' in stored
      || 'hiddenSlashCommands' in stored
      || 'activeConversationId' in stored
      || 'allowExternalAccess' in stored
      || 'allowedExportPaths' in stored
      || 'enableBlocklist' in stored
      || 'blockedCommands' in stored
      || 'locale' in stored
      || shouldPersistChatViewPlacementMigration(stored, chatViewPlacement)
      || JSON.stringify(envSnippets) !== JSON.stringify(stored.envSnippets ?? [])
      || (
        'customModelAliases' in stored
        && JSON.stringify(customModelAliases) !== JSON.stringify(stored.customModelAliases ?? {})
      )
      || (
        'inlineEditModel' in stored
        && JSON.stringify(inlineEditModel) !== JSON.stringify(stored.inlineEditModel ?? null)
      )
      || didNormalizeProviderSettings
      || didStripRuntimeProviderConfig
      || didNormalizeHostScopedProviderConfigs
      )
    ) {
      await this.save(merged);
    }

    return merged;
  }

  async save(settings: StoredCodianSettings): Promise<void> {
    const { providerConfigs } = projectPersistableProviderConfigs(settings.providerConfigs);
    const content = JSON.stringify(
      stripLegacyFields({
        ...settings,
        providerConfigs,
      }),
      null,
      2,
    );
    await this.adapter.write(CODIAN_SETTINGS_PATH, content);
    await this.deleteLegacyFileIfPresent();
  }

  async exists(): Promise<boolean> {
    if (await this.adapter.exists(CODIAN_SETTINGS_PATH)) {
      return true;
    }

    return this.adapter.exists(LEGACY_CODIAN_SETTINGS_PATH);
  }

  async update(updates: Partial<StoredCodianSettings>): Promise<void> {
    const current = await this.load();
    await this.save({ ...current, ...updates });
  }

  private getDefaults(): StoredCodianSettings {
    return DEFAULT_CODIAN_SETTINGS;
  }

  private async getLoadPath(): Promise<string | null> {
    if (await this.adapter.exists(CODIAN_SETTINGS_PATH)) {
      return CODIAN_SETTINGS_PATH;
    }

    if (await this.adapter.exists(LEGACY_CODIAN_SETTINGS_PATH)) {
      return LEGACY_CODIAN_SETTINGS_PATH;
    }

    return null;
  }

  private async deleteLegacyFileIfPresent(): Promise<void> {
    if (await this.adapter.exists(LEGACY_CODIAN_SETTINGS_PATH)) {
      await this.adapter.delete(LEGACY_CODIAN_SETTINGS_PATH);
    }
  }
}
