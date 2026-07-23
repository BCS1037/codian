import { getProviderConfig, setProviderConfig } from '../../core/providers/providerConfig';
import type { HostnameCliPaths } from '../../core/types/settings';

export interface KimiDiscoveredModel {
  description?: string;
  label: string;
  rawId: string;
}

export interface KimiMode {
  description?: string;
  id: string;
  label: string;
}

export interface KimiProviderSettings {
  availableModes: KimiMode[];
  cliPath: string;
  cliPathsByHost: HostnameCliPaths;
  discoveredModels: KimiDiscoveredModel[];
  enabled: boolean;
  environmentVariables: string;
  modelAliases: Record<string, string>;
  visibleModels: string[];
}

export const DEFAULT_KIMI_PROVIDER_SETTINGS: Readonly<KimiProviderSettings> = Object.freeze({
  availableModes: [],
  cliPath: '',
  cliPathsByHost: {},
  discoveredModels: [],
  enabled: false,
  environmentVariables: '',
  modelAliases: {},
  visibleModels: [],
});

export function getKimiProviderSettings(settings: Record<string, unknown>): KimiProviderSettings {
  const config = getProviderConfig(settings, 'kimi');
  const discoveredModels = normalizeDiscoveredModels(config.discoveredModels);
  const discoveredIds = new Set(discoveredModels.map(model => model.rawId));
  const hasVisibleModels = Array.isArray(config.visibleModels);
  const configuredVisibleModels = normalizeStringList(config.visibleModels)
    .filter(modelId => discoveredIds.has(modelId));

  return {
    availableModes: normalizeModes(config.availableModes),
    cliPath: readString(config.cliPath),
    cliPathsByHost: normalizeCliPaths(config.cliPathsByHost),
    discoveredModels,
    enabled: config.enabled === true,
    environmentVariables: readString(config.environmentVariables),
    modelAliases: normalizeAliases(config.modelAliases, discoveredIds),
    visibleModels: hasVisibleModels
      ? configuredVisibleModels
      : discoveredModels.map(model => model.rawId),
  };
}

export function updateKimiProviderSettings(
  settings: Record<string, unknown>,
  updates: Partial<KimiProviderSettings>,
): KimiProviderSettings {
  const current = getKimiProviderSettings(settings);
  const next: KimiProviderSettings = {
    ...current,
    ...updates,
    availableModes: normalizeModes(updates.availableModes ?? current.availableModes),
    cliPathsByHost: normalizeCliPaths(updates.cliPathsByHost ?? current.cliPathsByHost),
    discoveredModels: normalizeDiscoveredModels(updates.discoveredModels ?? current.discoveredModels),
    modelAliases: normalizeAliases(
      updates.modelAliases ?? current.modelAliases,
      new Set(normalizeDiscoveredModels(updates.discoveredModels ?? current.discoveredModels).map(model => model.rawId)),
    ),
    visibleModels: normalizeStringList(updates.visibleModels ?? current.visibleModels),
  };
  setProviderConfig(settings, 'kimi', { ...next });
  return getKimiProviderSettings(settings);
}

function normalizeDiscoveredModels(value: unknown): KimiDiscoveredModel[] {
  if (!Array.isArray(value)) return [];
  const models = new Map<string, KimiDiscoveredModel>();
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const rawId = readString(entry.rawId);
    const label = readString(entry.label);
    if (!rawId || !label) continue;
    const description = readString(entry.description);
    models.set(rawId, { ...(description ? { description } : {}), label, rawId });
  }
  return [...models.values()];
}

function normalizeModes(value: unknown): KimiMode[] {
  if (!Array.isArray(value)) return [];
  const modes = new Map<string, KimiMode>();
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const id = readString(entry.id);
    const label = readString(entry.label);
    if (!id || !label) continue;
    const description = readString(entry.description);
    modes.set(id, { ...(description ? { description } : {}), id, label });
  }
  return [...modes.values()];
}

function normalizeCliPaths(value: unknown): HostnameCliPaths {
  if (!isRecord(value)) return {};
  return Object.fromEntries(
    Object.entries(value)
      .filter((entry): entry is [string, string] => typeof entry[1] === 'string' && Boolean(entry[1].trim()))
      .map(([host, cliPath]) => [host, cliPath.trim()]),
  );
}

function normalizeStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((entry): entry is string => typeof entry === 'string').map(entry => entry.trim()).filter(Boolean))];
}

function normalizeAliases(value: unknown, modelIds: Set<string>): Record<string, string> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(
    Object.entries(value)
      .filter((entry): entry is [string, string] => (
        modelIds.has(entry[0]) && typeof entry[1] === 'string' && Boolean(entry[1].trim())
      ))
      .map(([modelId, alias]) => [modelId, alias.trim()]),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}
