import * as fs from 'node:fs';

import { Notice, Setting } from 'obsidian';

import type {
  ProviderSettingsTabRenderer,
  ProviderSettingsTabRendererContext,
} from '../../../core/providers/types';
import { t } from '../../../i18n/i18n';
import {
  type ProviderModelPickerModel,
  type ProviderModelPickerState,
  renderProviderModelPicker,
} from '../../../shared/settings/ProviderModelPicker';
import { getHostnameKey } from '../../../utils/env';
import { expandHomePath } from '../../../utils/path';
import { maybeGetPiWorkspaceServices } from '../app/PiWorkspaceServices';
import { sameStringList } from '../internal/compareCollections';
import { decodePiModelId, type PiDiscoveredModel } from '../models';
import { PiModelDiscoveryService } from '../runtime/PiModelDiscoveryService';
import {
  getPiProviderSettings,
  normalizePiVisibleModels,
  updatePiProviderSettings,
} from '../settings';

export const piSettingsTabRenderer: ProviderSettingsTabRenderer = {
  sections: ['provider'],
  render(container, context, section) {
    const settingsBag = context.plugin.settings as unknown as Record<string, unknown>;
    const piSettings = getPiProviderSettings(settingsBag);
    const hostnameKey = getHostnameKey();
    const workspace = maybeGetPiWorkspaceServices();
    const showSection = (target: NonNullable<typeof section>): boolean => (
      section === undefined || section === target
    );

    if (showSection('provider')) {
    new Setting(container).setName(t('settings.setup')).setHeading();

    const validationEl = container.createDiv({
      cls: 'claudian-cli-path-validation claudian-setting-validation claudian-setting-validation-error claudian-hidden',
    });
    const cliPathsByHost = { ...piSettings.cliPathsByHost };
    let cliPathInputEl: HTMLInputElement | null = null;

    const updateCliPathValidation = (value: string, inputEl?: HTMLInputElement): boolean => {
      const error = validateCliPath(value);
      if (error) {
        validationEl.setText(error);
        validationEl.toggleClass('claudian-hidden', false);
        inputEl?.toggleClass('claudian-input-error', true);
        return false;
      }

      validationEl.toggleClass('claudian-hidden', true);
      inputEl?.toggleClass('claudian-input-error', false);
      return true;
    };

    const persistCliPath = async (value: string): Promise<void> => {
      if (!updateCliPathValidation(value, cliPathInputEl ?? undefined)) {
        return;
      }

      const trimmed = value.trim();
      if (trimmed) {
        cliPathsByHost[hostnameKey] = trimmed;
      } else {
        delete cliPathsByHost[hostnameKey];
      }

      await context.plugin.mutateSettings((settings) => {
        updatePiProviderSettings(settings, {
          cliPathsByHost: { ...cliPathsByHost },
          discoveredModels: [],
        });
        workspace?.cliResolver?.reset();
      });
      context.refreshModelSelectors();
    };

    new Setting(container)
      .setName(t('settings.providerCliPath.name'))
      .setDesc(t('settings.providerCliPath.desc', { command: 'pi', provider: 'Pi' }))
      .addText((text) => {
        const currentValue = piSettings.cliPathsByHost[hostnameKey] || '';
        text
          .setPlaceholder(process.platform === 'win32'
            ? 'C:\\Users\\you\\AppData\\Roaming\\npm\\pi.cmd'
            : '/usr/local/bin/pi')
          .setValue(currentValue)
          .onChange((value) => {
            void persistCliPath(value);
          });
        cliPathInputEl = text.inputEl;
        updateCliPathValidation(currentValue, text.inputEl);
      });

    new Setting(container).setName(t('settings.models')).setHeading();
    renderPiModelPicker(container, context, settingsBag);

    new Setting(container).setName(t('settings.safety')).setHeading();
    new Setting(container)
      .setName(t('settings.providerPermissions.name'))
      .setDesc(t('settings.providerPermissions.piDesc'));
    }

  },
};

function renderPiModelPicker(
  container: HTMLElement,
  context: ProviderSettingsTabRendererContext,
  settingsBag: Record<string, unknown>,
): void {
  const getState = (): ProviderModelPickerState => {
    const current = getPiProviderSettings(settingsBag);
    return {
      aliases: current.modelAliases,
      discoveredCount: current.discoveredModels.length,
      models: buildPiPickerModels(current.discoveredModels, current.visibleModels),
      selectedIds: current.visibleModels,
    };
  };

  renderProviderModelPicker({
    container,
    emptyCatalogText: t('settings.providerCatalog.empty', { provider: 'Pi' }),
    failedCatalogText: t('settings.providerCatalog.failed', { provider: 'Pi' }),
    getState,
    async loadCatalog() {
      const result = await new PiModelDiscoveryService(context.plugin).discoverModels();
      if (result.kind === 'skipped') {
        return getPiProviderSettings(settingsBag).discoveredModels.length > 0 ? 'loaded' : 'empty';
      }
      if (result.diagnostics) {
        new Notice(t('settings.providerCatalog.discoveryFailed', {
          message: result.diagnostics,
          provider: 'Pi',
        }));
        return 'failed';
      }

      const current = getPiProviderSettings(settingsBag);
      const normalizedVisibleModels = normalizePiVisibleModels(current.visibleModels, result.models);
      const shouldPersist = result.models.length > 0
        || current.discoveredModels.length > 0
        || !sameStringList(current.visibleModels, normalizedVisibleModels);
      if (shouldPersist) {
        await context.plugin.mutateSettings((settings) => {
          updatePiProviderSettings(settings, {
            discoveredModels: result.models,
            visibleModels: normalizedVisibleModels,
          });
        });
        context.refreshModelSelectors();
      }
      return result.models.length > 0 ? 'loaded' : 'empty';
    },
    loadingCatalogText: t('settings.providerCatalog.loading', { provider: 'Pi' }),
    modifier: 'pi',
    async onAliasesChange(modelAliases) {
      await context.plugin.mutateSettings((settings) => {
        updatePiProviderSettings(settings, { modelAliases });
      });
      context.refreshModelSelectors();
    },
    async onSelectedIdsChange(visibleModels) {
      const current = getPiProviderSettings(settingsBag);
      const normalized = normalizePiVisibleModels(visibleModels, current.discoveredModels);
      if (sameStringList(current.visibleModels, normalized)) {
        return;
      }

      await context.plugin.mutateSettings((settings) => {
        updatePiProviderSettings(settings, { visibleModels: normalized });
      });
      context.refreshModelSelectors();
    },
    providerName: 'Pi',
  });
}

function validateCliPath(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  const expandedPath = expandHomePath(trimmed);
  if (!fs.existsSync(expandedPath)) {
    return t('settings.providerCliPath.notExist');
  }

  if (!fs.statSync(expandedPath).isFile()) {
    return t('settings.providerCliPath.isDirectory');
  }

  return null;
}

function buildPiPickerModels(
  discoveredModels: PiDiscoveredModel[],
  visibleModels: string[],
): ProviderModelPickerModel[] {
  const models: ProviderModelPickerModel[] = [];
  const discoveredIds = new Set<string>();

  for (const model of discoveredModels) {
    discoveredIds.add(model.encodedId);
    models.push({
      description: buildPiModelDescription(model),
      id: model.encodedId,
      isAvailable: true,
      name: model.label || model.id,
      providerKey: model.provider.toLowerCase(),
      providerLabel: formatProviderLabel(model.provider),
    });
  }

  for (const encodedId of visibleModels) {
    if (discoveredIds.has(encodedId)) {
      continue;
    }

    const decoded = decodePiModelId(encodedId);
    const provider = decoded?.provider ?? 'pi';
    models.push({
      description: 'Configured model',
      id: encodedId,
      isAvailable: false,
      name: decoded?.modelId ?? encodedId,
      providerKey: provider.toLowerCase(),
      providerLabel: formatProviderLabel(provider),
      unavailableMessage: 'Not currently reported by Pi',
    });
  }

  return models.sort((left, right) => {
    const providerCmp = (left.providerLabel ?? '').localeCompare(right.providerLabel ?? '');
    if (providerCmp !== 0) {
      return providerCmp;
    }
    return left.name.localeCompare(right.name);
  });
}

function buildPiModelDescription(model: PiDiscoveredModel): string {
  const details: string[] = [];
  if (model.api) {
    details.push(`API: ${model.api}`);
  }
  if (model.contextWindow) {
    details.push(`${model.contextWindow.toLocaleString()} context`);
  }
  if (model.maxTokens) {
    details.push(`${model.maxTokens.toLocaleString()} output`);
  }
  if (model.input.includes('image')) {
    details.push('image input');
  }
  details.push(model.reasoning
    ? `thinking: ${model.thinkingLevels.join(', ')}`
    : 'thinking: off');

  return details.join(' | ');
}

function formatProviderLabel(provider: string): string {
  const normalized = provider.trim();
  const knownProviders: Record<string, string> = {
    anthropic: 'Anthropic',
    deepseek: 'DeepSeek',
    google: 'Google',
    openai: 'OpenAI',
    xai: 'xAI',
  };
  const known = knownProviders[normalized.toLowerCase()];
  if (known) {
    return known;
  }

  return normalized
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ') || 'Pi';
}
