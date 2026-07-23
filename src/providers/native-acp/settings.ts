import { getProviderConfig, setProviderConfig } from '../../core/providers/providerConfig';
import type { HostnameCliPaths } from '../../core/types/settings';

export interface NativeAcpProviderSettings {
  cliPath: string;
  cliPathsByHost: HostnameCliPaths;
  enabled: boolean;
  environmentVariables: string;
}

export const DEFAULT_NATIVE_ACP_PROVIDER_SETTINGS: Readonly<NativeAcpProviderSettings> = Object.freeze({
  cliPath: '',
  cliPathsByHost: {},
  enabled: false,
  environmentVariables: '',
});

export function getNativeAcpProviderSettings(
  settings: Record<string, unknown>,
  providerId: string,
): NativeAcpProviderSettings {
  const config = getProviderConfig(settings, providerId);
  return {
    cliPath: typeof config.cliPath === 'string' ? config.cliPath : '',
    cliPathsByHost: normalizeCliPaths(config.cliPathsByHost),
    enabled: config.enabled === true,
    environmentVariables: typeof config.environmentVariables === 'string'
      ? config.environmentVariables
      : '',
  };
}

export function updateNativeAcpProviderSettings(
  settings: Record<string, unknown>,
  providerId: string,
  updates: Partial<NativeAcpProviderSettings>,
): NativeAcpProviderSettings {
  const existing = getProviderConfig(settings, providerId);
  const next = {
    ...getNativeAcpProviderSettings(settings, providerId),
    ...updates,
  };
  setProviderConfig(settings, providerId, { ...existing, ...next });
  return next;
}

function normalizeCliPaths(value: unknown): HostnameCliPaths {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(value)
      .filter((entry): entry is [string, string] => typeof entry[1] === 'string' && Boolean(entry[1].trim()))
      .map(([host, cliPath]) => [host, cliPath.trim()]),
  );
}
