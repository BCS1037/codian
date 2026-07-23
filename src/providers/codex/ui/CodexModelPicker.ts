import { Notice } from 'obsidian';

import { ProviderSettingsCoordinator } from '../../../core/providers/ProviderSettingsCoordinator';
import type { ProviderSettingsTabRendererContext } from '../../../core/providers/types';
import { t } from '../../../i18n/i18n';
import {
  type ProviderModelPickerModel,
  type ProviderModelPickerState,
  renderProviderModelPicker,
} from '../../../shared/settings/ProviderModelPicker';
import type { CodexWorkspaceServices } from '../app/CodexWorkspaceServices';
import { getCodexModelsInPickerOrder } from '../models';
import {
  createCodexVisibleModelFilter,
  getCodexProviderSettings,
  getVisibleCodexModelIds,
  updateCodexProviderSettings,
} from '../settings';

function sameVisibleModels(left: string[] | null, right: string[] | null): boolean {
  if (left === null || right === null) {
    return left === right;
  }
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export function renderCodexModelPicker(
  container: HTMLElement,
  context: ProviderSettingsTabRendererContext,
  workspace: CodexWorkspaceServices,
): void {
  const settingsBag = context.plugin.settings as unknown as Record<string, unknown>;

  const getState = (): ProviderModelPickerState => {
    const current = getCodexProviderSettings(settingsBag);
    const pickerOrderedModels = getCodexModelsInPickerOrder(current.discoveredModels);
    const visibleModelIds = getVisibleCodexModelIds(
      current.visibleModels,
      current.discoveredModels,
    );
    const visibleModelIdSet = new Set(visibleModelIds);
    const selectedIds = pickerOrderedModels
      .map(model => model.model)
      .filter(modelId => visibleModelIdSet.has(modelId));
    for (const modelId of visibleModelIds) {
      if (!selectedIds.includes(modelId)) {
        selectedIds.push(modelId);
      }
    }

    const models: ProviderModelPickerModel[] = pickerOrderedModels.map(model => ({
      ...(model.isDefault ? { catalogBadge: t('settings.providerModels.defaultBadge') } : {}),
      description: model.description,
      id: model.model,
      isAvailable: true,
      name: model.displayName,
    }));
    const discoveredIds = new Set(models.map(model => model.id));
    for (const modelId of visibleModelIds) {
      if (!discoveredIds.has(modelId)) {
        models.push({
          description: t('settings.providerModels.selectedModel'),
          id: modelId,
          isAvailable: false,
          name: modelId,
          unavailableMessage: t('settings.providerModels.notReported', { provider: 'Codex' }),
        });
      }
    }

    return {
      aliases: current.modelAliases,
      discoveredCount: current.discoveredModels.length,
      models,
      selectedIds,
    };
  };

  const persistVisibleModels = async (modelIds: string[]): Promise<void> => {
    const current = getCodexProviderSettings(settingsBag);
    const nextVisibleModels = createCodexVisibleModelFilter(modelIds, current.discoveredModels);
    if (sameVisibleModels(current.visibleModels, nextVisibleModels)) {
      return;
    }

    await context.plugin.mutateSettings((settings) => {
      updateCodexProviderSettings(settings, { visibleModels: nextVisibleModels });
      ProviderSettingsCoordinator.normalizeAllModelVariants(settings);
    });
    context.refreshModelSelectors();
  };

  let refreshPicker = (): void => {};
  const picker = renderProviderModelPicker({
    checkCatalogFreshnessWhenCached: true,
    container,
    emptyCatalogText: t('settings.providerCatalog.empty', { provider: 'Codex' }),
    failedCatalogText: t('settings.providerCatalog.failed', { provider: 'Codex' }),
    getState,
    initiallyOpen: getCodexProviderSettings(settingsBag).discoveredModels.length === 0,
    async loadCatalog(force) {
      if (!workspace.modelCatalogCoordinator) {
        return 'failed';
      }

      const result = await workspace.modelCatalogCoordinator.ensureFresh('model-picker', { force });
      if (result.backgroundRefresh) {
        void result.backgroundRefresh.then(
          () => {
            context.refreshModelSelectors();
            refreshPicker();
          },
          () => refreshPicker(),
        );
      }
      if (result.diagnostics) {
        new Notice(t('settings.providerCatalog.discoveryFailed', {
          message: result.diagnostics,
          provider: 'Codex',
        }));
        return 'failed';
      }
      context.refreshModelSelectors();
      return getCodexProviderSettings(settingsBag).discoveredModels.length > 0 ? 'loaded' : 'empty';
    },
    loadingCatalogText: t('settings.providerCatalog.loading', { provider: 'Codex' }),
    modifier: 'codex',
    async onAliasesChange(modelAliases) {
      await context.plugin.mutateSettings((settings) => {
        updateCodexProviderSettings(settings, { modelAliases });
      });
      context.refreshModelSelectors();
    },
    onSelectedIdsChange: persistVisibleModels,
    providerName: 'Codex',
    searchPlaceholder: t('settings.providerModels.searchPlaceholder'),
  });
  refreshPicker = picker.refresh;
}
