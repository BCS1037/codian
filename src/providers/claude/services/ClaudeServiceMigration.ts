import type { EnvSnippet } from '../../../core/types/settings';
import { getClaudeProviderSettings, updateClaudeProviderSettings } from '../settings';
import {
  type ClaudeThirdPartyService,
  migrateLegacyClaudeEnvironment,
} from './ClaudeThirdPartyServices';

export interface ClaudeServiceSecretWriter {
  setSecret(id: string, secret: string): void;
}

export function migrateClaudeServiceSettings(
  settings: Record<string, unknown>,
  secretStorage: ClaudeServiceSecretWriter,
  createId: () => string,
): boolean {
  const current = getClaudeProviderSettings(settings);
  const services = [...current.thirdPartyServices];
  const serviceFingerprint = (service: ClaudeThirdPartyService): string => (
    `${service.baseUrl.replace(/\/$/, '')}\n${service.defaultModel}`.toLowerCase()
  );
  const fingerprints = new Set(services.map(serviceFingerprint));

  const migrateEnvironment = (
    envText: string,
    idFactory: () => string,
    name?: string,
  ): { migrated: boolean; remaining: string } => {
    let pendingSecretId = '';
    let pendingSecretValue = '';
    const migration = migrateLegacyClaudeEnvironment(envText, {
      createId: idFactory,
      setSecret: (id, value) => {
        pendingSecretId = id;
        pendingSecretValue = value;
      },
    });
    if (!migration.service) {
      return { migrated: false, remaining: envText };
    }
    const service = name ? { ...migration.service, name } : migration.service;
    const fingerprint = serviceFingerprint(service);
    if (!fingerprints.has(fingerprint)) {
      if (pendingSecretId) {
        secretStorage.setSecret(pendingSecretId, pendingSecretValue);
      }
      services.push(service);
      fingerprints.add(fingerprint);
    }
    return { migrated: true, remaining: migration.remainingEnvironmentVariables };
  };

  const mainMigration = migrateEnvironment(current.environmentVariables, createId);
  let changed = mainMigration.migrated;

  const snippets = Array.isArray(settings.envSnippets)
    ? settings.envSnippets as EnvSnippet[]
    : [];
  const remainingSnippets: EnvSnippet[] = [];
  const migratedSnippets: EnvSnippet[] = [];
  for (const snippet of snippets) {
    const migration = migrateEnvironment(snippet.envVars, () => snippet.id, snippet.name);
    if (migration.migrated) {
      changed = true;
      migratedSnippets.push(snippet);
    } else {
      remainingSnippets.push(snippet);
    }
  }

  if (!changed) {
    return false;
  }

  settings.envSnippets = remainingSnippets;
  settings.customContextLimits = migratedSnippets.reduce<Record<string, number>>(
    (limits, snippet) => ({ ...limits, ...(snippet.contextLimits ?? {}) }),
    { ...settings.customContextLimits as Record<string, number> | undefined },
  );
  settings.customModelAliases = migratedSnippets.reduce<Record<string, string>>(
    (aliases, snippet) => ({ ...aliases, ...(snippet.modelAliases ?? {}) }),
    { ...settings.customModelAliases as Record<string, string> | undefined },
  );
  updateClaudeProviderSettings(settings, {
    thirdPartyServices: services,
    defaultThirdPartyServiceId: current.defaultThirdPartyServiceId || services[0]?.id || '',
    environmentVariables: mainMigration.remaining,
  });
  return true;
}
