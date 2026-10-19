import { DEFAULT_REASONING_VALUE } from '../../../core/providers/reasoning';
import type {
  ProviderChatUIConfig,
  ProviderReasoningOption,
  ProviderUIOption,
} from '../../../core/providers/types';
import { DEEPSEEK_PROVIDER_ICON } from '../../../shared/icons';
import { decodeDeepSeekModelId } from '../models';
import {
  DEEPSEEK_PERMISSION_MODE_POLICY,
  DEEPSEEK_PERMISSION_MODE_TOGGLE,
} from '../permissionModes';
import {
  findDeepSeekModel,
  getDeepSeekProviderSettings,
  isDeepSeekModelSelectable,
  updateDeepSeekProviderSettings,
} from '../settings';

export const deepseekModelPolicy = {
  permissionModes: DEEPSEEK_PERMISSION_MODE_POLICY,
  ownsModel: (model: string) => decodeDeepSeekModelId(model) !== null,
  isDefaultModel: (model: string) => decodeDeepSeekModelId(model) !== null,
  getModelOptions(settings: Record<string, unknown>): ProviderUIOption[] {
    const current = getDeepSeekProviderSettings(settings);
    return current.visibleModels.map(id => {
      const model = findDeepSeekModel(current, id);
      return {
        value: id,
        label: model && model.available !== false
          ? current.modelAliases[id] ?? model.label
          : `${current.modelAliases[id] ?? model?.label ?? id} (unavailable)`,
        group: model?.provider,
        description: model?.description,
      };
    });
  },
  getDefaultModel(settings: Record<string, unknown>): string | null {
    const current = getDeepSeekProviderSettings(settings);
    return current.visibleModels.find(id => isDeepSeekModelSelectable(current, id)) ?? null;
  },
  supportsReasoningEffort(model: string, settings: Record<string, unknown>): boolean {
    return (findDeepSeekModel(getDeepSeekProviderSettings(settings), model)?.reasoning?.length ?? 0) > 0;
  },
  getReasoningOptions(model: string, settings: Record<string, unknown>): ProviderReasoningOption[] {
    return (findDeepSeekModel(getDeepSeekProviderSettings(settings), model)?.reasoning ?? [])
      .map(effort => ({ value: effort.id, label: effort.name }));
  },
  getDefaultReasoningValue(model: string, settings: Record<string, unknown>): string {
    const current = getDeepSeekProviderSettings(settings);
    const efforts = findDeepSeekModel(current, model)?.reasoning ?? [];
    const preferred = current.preferredReasoningByModel[model];
    if (preferred && efforts.some(effort => effort.id === preferred)) return preferred;
    return efforts.length > 0 && efforts.every(effort => effort.id === 'off') ? 'off' : DEFAULT_REASONING_VALUE;
  },
  applyModelDefaults(model: string, settings: unknown): void {
    if (!settings || typeof settings !== 'object') return;
    const bag = settings as Record<string, unknown>;
    bag.model = model;
    bag.effortLevel = deepseekModelPolicy.getDefaultReasoningValue(model, bag);
  },
  applyModelProjectionDefaults(model: string, settings: unknown): void {
    if (!settings || typeof settings !== 'object') return;
    const bag = settings as Record<string, unknown>;
    const value = getDeepSeekProviderSettings(bag).preferredReasoningByModel[model];
    if (value) bag.effortLevel = value;
  },
  applyReasoningSelection(model: string, value: string, settings: unknown): void {
    if (!settings || typeof settings !== 'object' || !decodeDeepSeekModelId(model)) return;
    const bag = settings as Record<string, unknown>;
    updateDeepSeekProviderSettings(bag, {
      preferredReasoningByModel: { ...getDeepSeekProviderSettings(bag).preferredReasoningByModel, [model]: value },
    });
  },
  normalizeModelVariant: (model: string) => model,
  getCustomModelIds: () => new Set<string>(),
};

export const deepseekChatUIConfig: ProviderChatUIConfig = {
  ...deepseekModelPolicy,
  modelManagement: 'visible-models',
  isAdaptiveReasoningModel(model: string, settings: Record<string, unknown>): boolean {
    return deepseekModelPolicy.supportsReasoningEffort(model, settings);
  },
  getContextWindowSize(_model: string, customLimits?: Record<string, number>): number {
    return customLimits?.deepseek ?? 64_000;
  },
  getPermissionModeToggle() {
    return DEEPSEEK_PERMISSION_MODE_TOGGLE;
  },
  resolvePermissionMode(settings: Record<string, unknown>): string {
    return settings.permissionMode === 'yolo' ? 'yolo' : 'normal';
  },
  applyPermissionMode(value: string, settings: unknown): void {
    if (settings && typeof settings === 'object' && !Array.isArray(settings)) {
      (settings as Record<string, unknown>).permissionMode = value === 'yolo' ? 'yolo' : 'normal';
    }
  },
  getModeSelector(): null {
    return null;
  },
  getProviderIcon() {
    return DEEPSEEK_PROVIDER_ICON;
  },
};
