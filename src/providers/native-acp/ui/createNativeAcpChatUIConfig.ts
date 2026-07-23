import {
  encodeProviderModelSelectionId,
  isProviderModelSelectionId,
} from '../../../core/providers/modelSelection';
import type {
  ProviderChatUIConfig,
  ProviderId,
  ProviderUIOption,
} from '../../../core/providers/types';

const DEFAULT_CONTEXT_WINDOW = 200_000;

export function createNativeAcpChatUIConfig(
  providerId: ProviderId,
  displayName: string,
): ProviderChatUIConfig {
  const defaultModelId = encodeProviderModelSelectionId(providerId, 'default');
  const defaultModels: ProviderUIOption[] = [{
    value: defaultModelId,
    label: displayName,
    description: 'CLI default model',
  }];

  return {
    modelManagement: 'cli-managed',
    getModelOptions(): ProviderUIOption[] {
      return [...defaultModels];
    },
    ownsModel(model: string): boolean {
      return isProviderModelSelectionId(providerId, model);
    },
    isAdaptiveReasoningModel(): boolean {
      return false;
    },
    getReasoningOptions() {
      return [];
    },
    getDefaultReasoningValue(): string {
      return 'medium';
    },
    getContextWindowSize(model: string, customLimits?: Record<string, number>): number {
      return customLimits?.[model] ?? DEFAULT_CONTEXT_WINDOW;
    },
    isDefaultModel(model: string): boolean {
      return model === defaultModelId;
    },
    applyModelDefaults(model: string, settings: unknown): void {
      if (settings && typeof settings === 'object' && !Array.isArray(settings)) {
        (settings as Record<string, unknown>).model = model;
      }
    },
    normalizeModelVariant(model: string): string {
      return model;
    },
    getCustomModelIds(): Set<string> {
      return new Set();
    },
    getPermissionModeToggle(): null {
      return null;
    },
    resolvePermissionMode(settings: Record<string, unknown>): string | null {
      return typeof settings.permissionMode === 'string' ? settings.permissionMode : 'normal';
    },
    applyPermissionMode(value: string, settings: unknown): void {
      if (settings && typeof settings === 'object' && !Array.isArray(settings)) {
        (settings as Record<string, unknown>).permissionMode = value;
      }
    },
    getModeSelector(): null {
      return null;
    },
  };
}
