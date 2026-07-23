import { getRuntimeEnvironmentText } from '../../../core/providers/providerEnvironment';
import type { ProviderCliResolver } from '../../../core/providers/types';
import { findCliBinaryPath, resolveConfiguredCliPath } from '../../../utils/cliBinaryLocator';
import { getHostnameKey, parseEnvironmentVariables } from '../../../utils/env';
import { getNativeAcpProviderSettings } from '../settings';

export class NativeAcpCliResolver implements ProviderCliResolver {
  private resolvedPath: string | null = null;
  private resolutionKey = '';

  constructor(
    private readonly providerId: string,
    private readonly defaultCommand: string,
  ) {}

  resolveFromSettings(settings: Record<string, unknown>): string | null {
    const providerSettings = getNativeAcpProviderSettings(settings, this.providerId);
    const hostnamePath = providerSettings.cliPathsByHost[getHostnameKey()] ?? '';
    const envText = getRuntimeEnvironmentText(settings, this.providerId);
    const key = `${hostnamePath}\u0000${providerSettings.cliPath}\u0000${envText}`;
    if (key === this.resolutionKey) {
      return this.resolvedPath;
    }

    const env = parseEnvironmentVariables(envText);
    this.resolutionKey = key;
    this.resolvedPath = resolveConfiguredCliPath(hostnamePath)
      ?? resolveConfiguredCliPath(providerSettings.cliPath)
      ?? findCliBinaryPath(this.defaultCommand, env.PATH);
    return this.resolvedPath;
  }

  reset(): void {
    this.resolutionKey = '';
    this.resolvedPath = null;
  }
}
