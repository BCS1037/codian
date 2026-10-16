import { toProviderRuntimeModelId } from './modelSelection';
import { ProviderRegistry } from './ProviderRegistry';
import { ProviderSettingsCoordinator } from './ProviderSettingsCoordinator';
import type { ProviderId } from './types';

export type ConversationModelSource = 'selected' | 'usage' | 'default';

export interface ConversationModelResolution {
  model: string;
  source: ConversationModelSource;
  shouldPersist: boolean;
}

function trimModel(model: unknown): string {
  return typeof model === 'string' ? model.trim() : '';
}

export function findProviderModelOption(
  providerId: ProviderId,
  model: string,
  settings: Record<string, unknown>,
): string | null {
  const runtimeModel = toProviderRuntimeModelId(providerId, model);
  const option = ProviderRegistry
    .getChatUIConfig(providerId)
    .getModelOptions(settings)
    .find(candidate =>
      candidate.value === model
      || toProviderRuntimeModelId(providerId, candidate.value) === runtimeModel
    );
  return option?.value ?? null;
}

function findModelOption(
  providerId: ProviderId,
  model: string,
  settings: Record<string, unknown>,
): string | null {
  return findProviderModelOption(providerId, model, settings);
}

export function resolveProviderDefaultModel(
  providerId: ProviderId,
  settings: Record<string, unknown>,
): string | null {
  const uiConfig = ProviderRegistry.getChatUIConfig(providerId);
  const options = uiConfig.getModelOptions(settings);
  if (options.length === 0) {
    return null;
  }

  const preferred = trimModel(uiConfig.getDefaultModel?.(settings));
  if (preferred) {
    const preferredRuntimeModel = toProviderRuntimeModelId(providerId, preferred);
    const option = options.find(candidate => (
      candidate.value === preferred
      || toProviderRuntimeModelId(providerId, candidate.value) === preferredRuntimeModel
    ));
    if (option) {
      return option.value;
    }
  }

  return options[0]?.value ?? null;
}

export function resolveNewConversationModel(
  settings: Record<string, unknown>,
): { providerId: ProviderId; model: string } | null {
  const registeredProviderIds = new Set(ProviderRegistry.getRegisteredProviderIds());
  const lastSelected = settings.lastSelectedChatModel as { providerId?: string; model?: string } | undefined;
  if (
    lastSelected?.providerId
    && lastSelected?.model
    && registeredProviderIds.has(lastSelected.providerId)
    && ProviderRegistry.isEnabled(lastSelected.providerId, settings)
  ) {
    const selectedModel = findProviderModelOption(
      lastSelected.providerId,
      lastSelected.model,
      settings,
    );
    if (selectedModel) {
      return {
        providerId: lastSelected.providerId,
        model: selectedModel,
      };
    }

    return { providerId: lastSelected.providerId, model: lastSelected.model };
  }

  const defaultChatProviderId = ProviderRegistry.resolveDefaultChatProviderId(settings);
  if (defaultChatProviderId) {
    const blankDefault = resolveProviderDefaultModel(defaultChatProviderId, settings);
    if (blankDefault) {
      return {
        providerId: defaultChatProviderId,
        model: blankDefault,
      };
    }
  }

  for (const providerId of ProviderRegistry.getEnabledProviderIds(settings)) {
    const providerDefault = resolveProviderDefaultModel(providerId, settings);
    if (providerDefault) {
      return {
        providerId,
        model: providerDefault,
      };
    }
  }

  return null;
}

export function normalizeProviderModelSelection(
  providerId: ProviderId,
  settings: Record<string, unknown>,
  model: unknown,
): string | null {
  const rawModel = trimModel(model);
  if (!rawModel) {
    return null;
  }

  const uiConfig = ProviderRegistry.getChatUIConfig(providerId);
  const baseSettings = ProviderSettingsCoordinator.getProviderSettingsSnapshot(
    settings,
    providerId,
  );
  const rawSettings = {
    ...baseSettings,
    model: rawModel,
  };

  const rawOption = findModelOption(providerId, rawModel, rawSettings);
  if (rawOption) {
    return rawOption;
  }
  if (uiConfig.ownsModel(rawModel, rawSettings)) {
    return rawModel;
  }

  const normalizedModel = trimModel(uiConfig.normalizeModelVariant(rawModel, rawSettings));
  if (!normalizedModel) {
    return null;
  }

  const normalizedSettings = {
    ...baseSettings,
    model: normalizedModel,
  };
  const normalizedOption = findModelOption(providerId, normalizedModel, normalizedSettings);
  if (normalizedOption) {
    return normalizedOption;
  }

  return normalizedModel === rawModel && uiConfig.ownsModel(normalizedModel, normalizedSettings)
    ? normalizedModel
    : null;
}

export function resolveConversationModel(
  settings: Record<string, unknown>,
  providerId: ProviderId,
  conversation?: { selectedModel?: string; usage?: { model?: string } } | null,
): ConversationModelResolution {
  const selectedModel = normalizeProviderModelSelection(
    providerId,
    settings,
    conversation?.selectedModel,
  );
  if (selectedModel) {
    return {
      model: selectedModel,
      source: 'selected',
      shouldPersist: selectedModel !== conversation?.selectedModel,
    };
  }

  const usageModel = normalizeProviderModelSelection(
    providerId,
    settings,
    conversation?.usage?.model,
  );
  if (usageModel) {
    return {
      model: usageModel,
      source: 'usage',
      shouldPersist: true,
    };
  }

  const providerSettings = ProviderSettingsCoordinator.getProviderSettingsSnapshot(
    settings,
    providerId,
  );
  const defaultModel = normalizeProviderModelSelection(
    providerId,
    settings,
    providerSettings.model,
  ) ?? trimModel(providerSettings.model);

  return {
    model: defaultModel,
    source: 'default',
    shouldPersist: false,
  };
}

export function getProviderSettingsSnapshotWithModel<T extends Record<string, unknown>>(
  settings: T,
  providerId: ProviderId,
  model?: string | null,
): T {
  const snapshot = ProviderSettingsCoordinator.getProviderSettingsSnapshot(
    settings,
    providerId,
  );
  const normalizedModel = normalizeProviderModelSelection(providerId, snapshot, model);
  if (normalizedModel) {
    ProviderSettingsCoordinator.projectModelSelection(snapshot, providerId, normalizedModel);
  }
  return snapshot;
}
