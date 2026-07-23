import {
  encodeProviderModelSelectionId,
  isProviderModelSelectionId,
} from '../../../core/providers/modelSelection';
import type {
  ProviderChatUIConfig,
  ProviderPermissionModeToggleConfig,
  ProviderUIOption,
} from '../../../core/providers/types';
import { getKimiProviderSettings } from '../settings';

const DEFAULT_CONTEXT_WINDOW = 200_000;
const KIMI_PERMISSION_TOGGLE: ProviderPermissionModeToggleConfig = {
  activeLabel: 'Auto',
  activeValue: 'yolo',
  inactiveLabel: 'Safe',
  inactiveValue: 'normal',
  planLabel: 'Plan',
  planValue: 'plan',
};

export const kimiChatUIConfig: ProviderChatUIConfig = {
  modelManagement: 'visible-models',
  getModelOptions(settings): ProviderUIOption[] {
    const kimiSettings = getKimiProviderSettings(settings);
    const visible = new Set(kimiSettings.visibleModels);
    return kimiSettings.discoveredModels
      .filter(model => visible.has(model.rawId))
      .map(model => ({
        description: model.description ?? 'Kimi ACP model',
        label: kimiSettings.modelAliases[model.rawId] ?? model.label,
        value: encodeProviderModelSelectionId('kimi', model.rawId),
      }));
  },
  getDefaultModel(settings): string | null {
    const rawId = getKimiProviderSettings(settings).visibleModels[0];
    return rawId ? encodeProviderModelSelectionId('kimi', rawId) : null;
  },
  ownsModel(model): boolean {
    return isProviderModelSelectionId('kimi', model);
  },
  isAdaptiveReasoningModel(): boolean {
    return true;
  },
  getReasoningOptions() {
    return [
      { label: 'Off', value: 'off' },
      { label: 'On', value: 'on' },
    ];
  },
  getDefaultReasoningValue(): string {
    return 'off';
  },
  getContextWindowSize(model, customLimits): number {
    return customLimits?.[model] ?? DEFAULT_CONTEXT_WINDOW;
  },
  isDefaultModel(model): boolean {
    return isProviderModelSelectionId('kimi', model);
  },
  applyModelDefaults(model, settings): void {
    if (settings && typeof settings === 'object' && !Array.isArray(settings)) {
      (settings as Record<string, unknown>).model = model;
    }
  },
  normalizeModelVariant(model): string {
    return model;
  },
  getCustomModelIds(): Set<string> {
    return new Set();
  },
  getPermissionModeToggle(): ProviderPermissionModeToggleConfig {
    return KIMI_PERMISSION_TOGGLE;
  },
  resolvePermissionMode(settings): string | null {
    return typeof settings.permissionMode === 'string' ? settings.permissionMode : 'normal';
  },
  applyPermissionMode(value, settings): void {
    if (settings && typeof settings === 'object' && !Array.isArray(settings)) {
      (settings as Record<string, unknown>).permissionMode = value;
    }
  },
  getModeSelector(): null {
    return null;
  },
};
