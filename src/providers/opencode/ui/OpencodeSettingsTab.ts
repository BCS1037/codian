import * as fs from 'fs';
import { Setting } from 'obsidian';

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
import { maybeGetOpencodeWorkspaceServices } from '../app/OpencodeWorkspaceServices';
import { clearOpencodeDiscoveryState } from '../discoveryState';
import { sameStringList } from '../internal/compareCollections';
import {
  buildOpencodeBaseModels,
  encodeOpencodeModelId,
  type OpencodeDiscoveredModel,
  splitOpencodeModelLabel,
} from '../models';
import { OpencodeChatRuntime } from '../runtime/OpencodeChatRuntime';
import {
  getOpencodeProviderSettings,
  normalizeOpencodeVisibleModels,
  updateOpencodeProviderSettings,
} from '../settings';
import { OpencodeAgentSettings } from './OpencodeAgentSettings';

const OPENCODE_METADATA_WARMUP_DB = ':memory:';

export const opencodeSettingsTabRenderer: ProviderSettingsTabRenderer = {
  sections: ['provider', 'skills', 'agents', 'commands'],
  render(container, context, section) {
    const opencodeWorkspace = maybeGetOpencodeWorkspaceServices();
    const settingsBag = context.plugin.settings as unknown as Record<string, unknown>;
    const opencodeSettings = getOpencodeProviderSettings(settingsBag);
    const hostnameKey = getHostnameKey();
    const showSection = (target: NonNullable<typeof section>): boolean => (
      section === undefined || section === target
    );
    const recycleOpencodeRuntime = async (): Promise<void> => {
      await context.plugin.recycleProviderRuntimes?.('opencode');
    };

    if (showSection('provider')) {
    new Setting(container).setName(t('settings.setup')).setHeading();

    const cliPathSetting = new Setting(container)
      .setName(t('settings.providerCliPath.name'))
      .setDesc(t('settings.providerCliPath.desc', { command: 'opencode', provider: 'OpenCode' }));

    const validationEl = container.createDiv({
      cls: 'claudian-cli-path-validation claudian-setting-validation claudian-setting-validation-error claudian-hidden',
    });
    const cliPathsByHost = { ...opencodeSettings.cliPathsByHost };
    const currentValue = opencodeSettings.cliPathsByHost[hostnameKey] || '';
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

    const persistCliPath = async (value: string): Promise<boolean> => {
      if (!updateCliPathValidation(value, cliPathInputEl ?? undefined)) {
        return false;
      }

      const trimmed = value.trim();
      if (trimmed) {
        cliPathsByHost[hostnameKey] = trimmed;
      } else {
        delete cliPathsByHost[hostnameKey];
      }

      await context.plugin.mutateSettings((settings) => {
        updateOpencodeProviderSettings(settings, { cliPathsByHost: { ...cliPathsByHost } });
        clearOpencodeDiscoveryState(settings);
      });
      opencodeWorkspace?.cliResolver?.reset();
      await recycleOpencodeRuntime();
      return true;
    };

    cliPathSetting.addText((text) => {
      text
        .setPlaceholder(process.platform === 'win32'
          ? 'C:\\Users\\you\\AppData\\Roaming\\npm\\opencode.cmd'
          : '/usr/local/bin/opencode')
        .setValue(currentValue)
        .onChange(async (value) => {
          await persistCliPath(value);
        });
      text.inputEl.addClass('claudian-settings-cli-path-input');
      cliPathInputEl = text.inputEl;
      updateCliPathValidation(currentValue, text.inputEl);
    });

    new Setting(container).setName(t('settings.models')).setHeading();
    renderOpencodeModelPicker(container, context, settingsBag);

    new Setting(container).setName(t('settings.safety')).setHeading();
    new Setting(container)
      .setName(t('settings.providerPermissions.name'))
      .setDesc(t('settings.providerPermissions.opencodeDesc'));
    }

    if (showSection('skills') || showSection('commands')) {
    new Setting(container)
      .setName(t('settings.opencode.commandsAndSkills'))
      .setHeading();

    const commandsDesc = container.createDiv({ cls: 'claudian-sp-settings-desc' });
    commandsDesc.createEl('p', {
      cls: 'setting-item-description',
      text: t('settings.opencode.commandsAndSkillsDesc'),
    });

    if (showSection('commands')) {
      context.renderHiddenProviderCommandSetting(container, 'opencode', {
        name: t('settings.opencode.hiddenCommandsAndSkills'),
        desc: t('settings.opencode.hiddenCommandsAndSkillsDesc'),
        placeholder: 'compact\nreview\nfix',
      });
    }
    }

    if (showSection('agents') && opencodeWorkspace?.agentStorage) {
      new Setting(container).setName(t('settings.opencode.subagents')).setHeading();

      const subagentsDesc = container.createDiv({ cls: 'claudian-sp-settings-desc' });
      subagentsDesc.createEl('p', {
        cls: 'setting-item-description',
        text: t('settings.opencode.subagentsDesc'),
      });

      const subagentsContainer = container.createDiv({ cls: 'claudian-slash-commands-container' });
      new OpencodeAgentSettings(
        subagentsContainer,
        opencodeWorkspace.agentStorage,
        context.plugin.app,
        async () => {
          await opencodeWorkspace.refreshAgentMentions?.();
          await recycleOpencodeRuntime();
        },
      );
    }

  },
};

function renderOpencodeModelPicker(
  container: HTMLElement,
  context: ProviderSettingsTabRendererContext,
  settingsBag: Record<string, unknown>,
): void {
  const getState = (): ProviderModelPickerState => {
    const current = getOpencodeProviderSettings(settingsBag);
    return {
      aliases: current.modelAliases,
      discoveredCount: current.discoveredModels.length,
      models: buildOpencodePickerModels(current.discoveredModels, current.visibleModels),
      selectedIds: current.visibleModels,
    };
  };

  const warmModelMetadata = async (rawId: string): Promise<void> => {
    const runtime = new OpencodeChatRuntime(context.plugin);
    try {
      runtime.syncConversationState({
        providerState: { databasePath: OPENCODE_METADATA_WARMUP_DB },
        sessionId: null,
      });
      if (await runtime.warmModelMetadata(encodeOpencodeModelId(rawId))) {
        context.refreshModelSelectors();
      }
    } catch {
      // Metadata warmup is opportunistic; the first chat turn can still discover it.
    } finally {
      runtime.cleanup();
    }
  };

  renderProviderModelPicker({
    container,
    emptyCatalogText: t('settings.providerCatalog.empty', { provider: 'OpenCode' }),
    failedCatalogText: t('settings.providerCatalog.failed', { provider: 'OpenCode' }),
    getState,
    async loadCatalog() {
      const runtime = new OpencodeChatRuntime(context.plugin);
      try {
        runtime.syncConversationState({
          providerState: { databasePath: OPENCODE_METADATA_WARMUP_DB },
          sessionId: null,
        });
        const loaded = await runtime.ensureReady({ allowSessionCreation: true });
        const discoveredCount = getOpencodeProviderSettings(settingsBag).discoveredModels.length;
        if (!loaded) {
          return 'failed';
        }
        if (discoveredCount > 0) {
          context.refreshModelSelectors();
          return 'loaded';
        }
        return 'empty';
      } catch {
        return 'failed';
      } finally {
        runtime.cleanup();
      }
    },
    loadCatalogOnRender: true,
    loadingCatalogText: t('settings.providerCatalog.loading', { provider: 'OpenCode' }),
    modifier: 'opencode',
    async onAliasesChange(modelAliases) {
      await context.plugin.mutateSettings((settings) => {
        updateOpencodeProviderSettings(settings, { modelAliases });
      });
      context.refreshModelSelectors();
    },
    onModelSelected: async (model) => warmModelMetadata(model.id),
    async onSelectedIdsChange(visibleModels) {
      const current = getOpencodeProviderSettings(settingsBag);
      const normalized = normalizeOpencodeVisibleModels(visibleModels, current.discoveredModels);
      if (sameStringList(current.visibleModels, normalized)) {
        return;
      }

      await context.plugin.mutateSettings((settings) => {
        updateOpencodeProviderSettings(settings, { visibleModels: normalized });
      });
      context.refreshModelSelectors();
    },
    providerName: 'OpenCode',
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

function buildOpencodePickerModels(
  discoveredModels: OpencodeDiscoveredModel[],
  visibleModels: string[],
): ProviderModelPickerModel[] {
  const models: ProviderModelPickerModel[] = [];
  const discoveredIds = new Set<string>();

  for (const model of buildOpencodeBaseModels(discoveredModels)) {
    const { modelLabel, providerLabel } = splitOpencodeModelLabel(model.label || model.rawId);
    discoveredIds.add(model.rawId);
    models.push({
      description: model.description ?? '',
      id: model.rawId,
      isAvailable: true,
      name: modelLabel,
      providerKey: providerLabel.toLowerCase(),
      providerLabel,
    });
  }

  for (const rawId of visibleModels) {
    if (discoveredIds.has(rawId)) {
      continue;
    }

    const { modelLabel, providerLabel } = splitOpencodeModelLabel(rawId);
    models.push({
      id: rawId,
      isAvailable: false,
      name: modelLabel,
      providerKey: providerLabel.toLowerCase(),
      providerLabel,
      unavailableMessage: 'Not currently reported by OpenCode',
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
