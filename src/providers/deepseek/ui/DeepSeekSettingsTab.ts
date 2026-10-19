import * as fs from 'node:fs';
import * as path from 'node:path';

import { Setting } from 'obsidian';

import type { ProviderModelCatalogController } from '../../../core/providers/models/ProviderModelCatalog';
import type { ProviderHost } from '../../../core/providers/ProviderHost';
import type {
  ProviderSettingsTabRenderer,
  ProviderSettingsTabRendererContext,
} from '../../../core/providers/types';
import { t } from '../../../i18n/i18n';
import {
  type ProviderModelPickerState,
  renderProviderModelPicker,
} from '../../../shared/settings/ProviderModelPicker';
import { getHostnameKey } from '../../../utils/env';
import { expandHomePath } from '../../../utils/path';
import type { DeepSeekCLIResolver } from '../runtime/DeepSeekCLIResolver';
import {
  getDeepSeekDesktopInstallation,
  resolveDeepSeekCLIPath,
} from '../runtime/DeepSeekInstallation';
import {
  type DeepSeekProviderSettings,
  getDeepSeekProviderSettings,
  updateDeepSeekProviderSettings,
} from '../settings';

const DEEPSEEK_CLI_PLACEHOLDERS: Partial<Record<NodeJS.Platform, string>> = {
  darwin: '/Applications/DeepSeek Harness.app',
  win32: '%LOCALAPPDATA%\\Programs\\DeepSeek Harness',
};

export function createDeepSeekSettingsTabRenderer(workspace: {
  cliResolver: DeepSeekCLIResolver;
  modelCatalog: ProviderModelCatalogController;
}): ProviderSettingsTabRenderer {
  return {
    sections: ['provider', 'commands'],
    render(container, context, section) {
      const showSection = (target: string): boolean => (section === undefined || section === target);
      const host = context.plugin;
      const settings = (): DeepSeekProviderSettings =>
        getDeepSeekProviderSettings(host.settings);
      const hostnameKey = getHostnameKey();

      if (showSection('provider')) {
        // --- 1. 连接 (Setup) ---
        new Setting(container).setName(t('settings.setup')).setHeading();

        const baseDesc = t('settings.deepseek.installation.desc');
        const cliPathSetting = new Setting(container)
          .setName(t('settings.cliPath.genericName'))
          .setDesc(baseDesc);

        const validationEl = container.createDiv({
          cls: 'codian-cli-path-validation codian-setting-validation codian-setting-validation-error codian-hidden',
        });

        const initialCliPath = settings().cliPathsByHost[hostnameKey] ?? settings().cliPath ?? '';
        let currentCliPath = initialCliPath;
        let cliPathInputEl: HTMLInputElement | null = null;

        const updateValidation = (value: string, input?: HTMLInputElement): boolean => {
          const error = validateDeepSeekCliPath(value);
          if (error) {
            validationEl.setText(error);
            validationEl.toggleClass('codian-hidden', false);
            input?.toggleClass('codian-input-error', true);
            cliPathSetting.setDesc(baseDesc);
            return false;
          }
          validationEl.toggleClass('codian-hidden', true);
          input?.toggleClass('codian-input-error', false);
          const resolved = value.trim() ? resolveDeepSeekCLIPath(value.trim()) : null;
          if (resolved) {
            const isDesktop = getDeepSeekDesktopInstallation(resolved);
            const profileText = t(isDesktop ? 'settings.deepseek.installation.desktop' : 'settings.deepseek.installation.web');
            cliPathSetting.setDesc(`${baseDesc} (${profileText})`);
          } else {
            cliPathSetting.setDesc(baseDesc);
          }
          return true;
        };

        const persistCliPath = async (value: string): Promise<void> => {
          if (!updateValidation(value, cliPathInputEl ?? undefined)) return;
          const trimmed = value.trim();
          if (trimmed === currentCliPath.trim()) return;

          const cliPathsByHost = { ...settings().cliPathsByHost };
          if (trimmed) cliPathsByHost[hostnameKey] = trimmed;
          else delete cliPathsByHost[hostnameKey];

          await host.mutateSettings(s => {
            updateDeepSeekProviderSettings(s, {
              cliPath: '',
              cliPathsByHost,
            });
          });
          workspace.cliResolver.reset();
          currentCliPath = trimmed;
          context.notifyProviderModelOptionsChanged('deepseek');
        };

        cliPathSetting.addText(text => {
          text
            .setPlaceholder(DEEPSEEK_CLI_PLACEHOLDERS[process.platform] ?? '/usr/local/bin/dsh')
            .setValue(initialCliPath)
            .onChange(persistCliPath);
          text.inputEl.addClass('codian-settings-cli-path-input');
          cliPathInputEl = text.inputEl;
          updateValidation(initialCliPath, text.inputEl);
        });

        // --- 2. 模型 (Models) ---
        new Setting(container).setName(t('settings.models')).setHeading();
        renderDeepSeekModelPicker(container, context, host, workspace.modelCatalog);

        // --- 3. 权限与运行模式 (Safety & Execution Policy) ---
        new Setting(container).setName(t('settings.safety')).setHeading();

        new Setting(container)
          .setName(t('settings.deepseek.codeMode.name'))
          .setDesc(t('settings.deepseek.codeMode.desc'))
          .addToggle(toggle => {
            toggle.setValue(settings().codeMode).onChange(async codeMode => {
              await host.mutateSettings(s => {
                updateDeepSeekProviderSettings(s, { codeMode });
              });
            });
          });

        new Setting(container)
          .setName(t('settings.providerPermissions.name'))
          .setDesc(t('settings.providerPermissions.cliManagedDesc', { provider: 'DeepSeek Harness' }));
      }

      if (showSection('commands')) {
        new Setting(container).setName(t('settings.settingsHub.workspaceSections.commands')).setHeading();
        context.renderHiddenProviderCommandSetting?.(container, 'deepseek', {
          name: 'Hidden DeepSeek commands',
          desc: 'Hide runtime commands advertised by DeepSeek Harness from the command dropdown. Enter names without the leading slash, one per line.',
          placeholder: 'compact\nreview',
        });
      }
    },
  };
}

function renderDeepSeekModelPicker(
  container: HTMLElement,
  context: ProviderSettingsTabRendererContext,
  host: ProviderHost,
  modelCatalog: ProviderModelCatalogController,
): void {
  const settingsBag = host.settings as Record<string, unknown>;
  const getState = (): ProviderModelPickerState => {
    const current = getDeepSeekProviderSettings(settingsBag);
    const catalogModels = current.discoveredModels ?? [];
    const selectedIds = current.visibleModels.length > 0
      ? current.visibleModels
      : catalogModels.map(m => m.encodedId);
    return {
      aliases: current.modelAliases,
      discoveredCount: catalogModels.length,
      models: catalogModels.map(model => ({
        id: model.encodedId,
        name: model.label,
        description: model.description,
        isAvailable: model.available !== false,
      })),
      selectedIds,
    };
  };

  renderProviderModelPicker({
    checkCatalogFreshnessWhenCached: true,
    container,
    emptyCatalogText: t('settings.providerCatalog.empty', { provider: 'DeepSeek Harness' }),
    failedCatalogText: t('settings.providerCatalog.failed', { provider: 'DeepSeek Harness' }),
    getState,
    initiallyOpen: (getDeepSeekProviderSettings(settingsBag).discoveredModels.length ?? 0) === 0,
    loadCatalog: async () => {
      await modelCatalog.refresh({ force: true });
      context.notifyProviderModelOptionsChanged('deepseek');
      return (getDeepSeekProviderSettings(settingsBag).discoveredModels.length ?? 0) > 0 ? 'loaded' : 'empty';
    },
    loadingCatalogText: t('settings.providerCatalog.loading', { provider: 'DeepSeek Harness' }),
    modifier: 'deepseek',
    async onAliasesChange(aliases) {
      await host.mutateSettings(s => {
        updateDeepSeekProviderSettings(s, { modelAliases: aliases });
      });
      context.notifyProviderModelOptionsChanged('deepseek');
    },
    async onSelectedIdsChange(selectedIds) {
      await host.mutateSettings(s => {
        updateDeepSeekProviderSettings(s, { visibleModels: selectedIds });
      });
      context.notifyProviderModelOptionsChanged('deepseek');
    },
    providerName: 'DeepSeek Harness',
  });
}

function validateDeepSeekCliPath(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const desktop = getDeepSeekDesktopInstallation(trimmed);
  if (desktop) return null;
  const expandedPath = expandHomePath(trimmed);
  if (!path.posix.isAbsolute(expandedPath) && !path.win32.isAbsolute(expandedPath)) {
    return t('settings.cliPath.validation.notExist');
  }
  try {
    if (!fs.existsSync(expandedPath)) return t('settings.cliPath.validation.notExist');
    if (fs.statSync(expandedPath).isDirectory()) {
      const resolved = resolveDeepSeekCLIPath(expandedPath);
      if (resolved && fs.existsSync(resolved)) return null;
      return t('settings.cliPath.validation.isDirectory');
    }
    if (process.platform !== 'win32') {
      fs.accessSync(expandedPath, fs.constants.X_OK);
    }
  } catch {
    return process.platform === 'win32'
      ? t('settings.cliPath.validation.notExist')
      : 'Path must be executable';
  }
  return null;
}
