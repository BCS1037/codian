import { ProviderRegistry } from './ProviderRegistry';
import { ProviderSettingsCoordinator } from './ProviderSettingsCoordinator';
import type { ProviderId, ProviderUIOption } from './types';

export function getProviderForModel(model: string, settings?: Record<string, unknown>): ProviderId {
  return ProviderRegistry.resolveProviderForModel(model, settings);
}

export function getEnabledProviderForModel(
  model: string,
  settings: Record<string, unknown>,
  fallbackProviderId?: ProviderId,
): ProviderId {
  return ProviderRegistry.resolveProviderForModel(model, settings, {
    onlyEnabledProviders: true,
    fallbackProviderId,
  });
}
/**
 * Returns model options across all enabled providers, grouped and with provider icons.
 */
export function getAllEnabledProviderModelOptions(
  settings: Record<string, unknown>,
  getEnvVars?: (providerId: ProviderId) => string,
): ProviderUIOption[] {
  const enabledProviderIds = ProviderRegistry.orderProviderIds(
    ProviderRegistry.getEnabledProviderIds(settings),
  );
  const defaultProviderId = ProviderRegistry.resolveDefaultChatProviderId(settings);
  const providerIds = defaultProviderId && enabledProviderIds.includes(defaultProviderId)
    ? [defaultProviderId, ...enabledProviderIds.filter(providerId => providerId !== defaultProviderId)]
    : enabledProviderIds;

  return providerIds.flatMap((providerId) => {
    const uiConfig = ProviderRegistry.getChatUIConfig(providerId);
    const providerIcon = uiConfig.getProviderIcon?.() ?? undefined;
    const group = ProviderRegistry.getProviderDisplayName(providerId);
    const envVars = getEnvVars ? getEnvVars(providerId) : '';
    const providerSettings = ProviderSettingsCoordinator.getProviderSettingsSnapshot(settings, providerId);

    return uiConfig.getModelOptions({
      ...providerSettings,
      environmentVariables: envVars,
    })
      .filter(model => providerId !== 'claude' || uiConfig.modelManagement !== 'manual-models' || !uiConfig.isDefaultModel?.(model.value))
      .map(model => ({
        ...model,
        group: model.group ? `${group} - ${model.group}` : group,
        providerIcon: model.providerIcon ?? providerIcon,
        providerId,
      }));
  });
}
