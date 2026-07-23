import * as fs from 'fs';
import { Setting } from 'obsidian';

import { ProviderSettingsCoordinator } from '../../../core/providers/ProviderSettingsCoordinator';
import type { ProviderSettingsTabRenderer } from '../../../core/providers/types';
import { t } from '../../../i18n/i18n';
import { McpSettingsManager } from '../../../shared/settings/McpSettingsManager';
import { getHostnameKey } from '../../../utils/env';
import { expandHomePath } from '../../../utils/path';
import { getClaudeWorkspaceServices } from '../app/ClaudeWorkspaceServices';
import { resolveClaudeModelSelection } from '../modelOptions';
import {
  CLAUDE_SAFE_MODES,
  type ClaudeSafeMode,
  getClaudeProviderSettings,
  updateClaudeProviderSettings,
} from '../settings';
import { AgentSettings } from './AgentSettings';
import { claudeChatUIConfig } from './ClaudeChatUIConfig';
import { renderClaudeServiceSettings } from './ClaudeServiceSettings';
import { PluginSettingsManager } from './PluginSettingsManager';
import { SlashCommandSettings } from './SlashCommandSettings';

export const claudeSettingsTabRenderer: ProviderSettingsTabRenderer = {
  sections: ['provider', 'skills', 'agents', 'mcp', 'commands'],
  render(container, context, section) {
    const claudeWorkspace = getClaudeWorkspaceServices();
    const settingsBag = context.plugin.settings as unknown as Record<string, unknown>;
    const claudeSettings = getClaudeProviderSettings(settingsBag);

    const reconcileActiveClaudeModelSelection = (settings: Record<string, unknown>): void => {
      const activeProvider = settings.settingsProvider;
      if (activeProvider !== undefined && activeProvider !== 'claude') {
        return;
      }

      const currentModel = typeof settings.model === 'string' ? settings.model : '';
      const nextModel = resolveClaudeModelSelection(settings, currentModel);
      if (!nextModel || nextModel === currentModel) {
        return;
      }

      settings.model = nextModel;
      claudeChatUIConfig.applyModelDefaults(nextModel, settings);
    };
    const showSection = (target: NonNullable<typeof section>): boolean => (
      section === undefined || section === target
    );

    if (showSection('provider')) {
      // --- Setup ---

    new Setting(container).setName(t('settings.setup')).setHeading();

    const hostnameKey = getHostnameKey();
    const platformDesc = process.platform === 'win32'
      ? t('settings.cliPath.descWindows')
      : t('settings.cliPath.descUnix');
    const cliPathDescription = `${t('settings.cliPath.desc')} ${platformDesc}`;

    const cliPathSetting = new Setting(container)
      .setName(t('settings.cliPath.name'))
      .setDesc(cliPathDescription);

    const validationEl = container.createDiv({
      cls: 'claudian-cli-path-validation claudian-setting-validation claudian-setting-validation-error claudian-hidden',
    });

    const validatePath = (value: string): string | null => {
      const trimmed = value.trim();
      if (!trimmed) return null;

      const expandedPath = expandHomePath(trimmed);

      if (!fs.existsSync(expandedPath)) {
        return t('settings.cliPath.validation.notExist');
      }
      const stat = fs.statSync(expandedPath);
      if (!stat.isFile()) {
        return t('settings.cliPath.validation.isDirectory');
      }
      return null;
    };

    const updateCliPathValidation = (value: string, inputEl?: HTMLInputElement): boolean => {
      const error = validatePath(value);
      if (error) {
        validationEl.setText(error);
        validationEl.toggleClass('claudian-hidden', false);
        if (inputEl) {
          inputEl.toggleClass('claudian-input-error', true);
        }
        return false;
      }

      validationEl.toggleClass('claudian-hidden', true);
      if (inputEl) {
        inputEl.toggleClass('claudian-input-error', false);
      }
      return true;
    };

    const currentValue = claudeSettings.cliPathsByHost[hostnameKey] || '';
    const cliPathsByHost = { ...claudeSettings.cliPathsByHost };
    let cliPathInputEl: HTMLInputElement | null = null;

    const persistCliPath = async (value: string): Promise<boolean> => {
      const isValid = updateCliPathValidation(value, cliPathInputEl ?? undefined);
      if (!isValid) {
        return false;
      }

      const trimmed = value.trim();
      if (trimmed) {
        cliPathsByHost[hostnameKey] = trimmed;
      } else {
        delete cliPathsByHost[hostnameKey];
      }

      await context.plugin.mutateSettings((settings) => {
        updateClaudeProviderSettings(settings, { cliPathsByHost: { ...cliPathsByHost } });
      });
      claudeWorkspace.cliResolver.reset();
      await context.plugin.recycleProviderRuntimes?.('claude');
      return true;
    };

    cliPathSetting.addText((text) => {
      const placeholder = process.platform === 'win32'
        ? 'D:\\nodejs\\node_global\\node_modules\\@anthropic-ai\\claude-code\\cli-wrapper.cjs'
        : '/usr/local/lib/node_modules/@anthropic-ai/claude-code/cli-wrapper.cjs';

      text
        .setPlaceholder(placeholder)
        .setValue(currentValue)
        .onChange(async (value) => {
          await persistCliPath(value);
        });
      text.inputEl.addClass('claudian-settings-cli-path-input');
      cliPathInputEl = text.inputEl;

      updateCliPathValidation(currentValue, text.inputEl);
    });

    // --- Models ---

    new Setting(container).setName(t('settings.models')).setHeading();

    new Setting(container)
      .setName(t('settings.customModels.name'))
      .setDesc(t('settings.customModels.desc'))
      .addTextArea((text) => {
        let pendingCustomModels = claudeSettings.customModels;
        let savedCustomModels = claudeSettings.customModels;

        const commitCustomModels = async (): Promise<void> => {
          if (pendingCustomModels === savedCustomModels) {
            return;
          }

          const nextCustomModels = pendingCustomModels;
          await context.plugin.mutateSettings((settings) => {
            updateClaudeProviderSettings(settings, { customModels: nextCustomModels });
            reconcileActiveClaudeModelSelection(settings);
            ProviderSettingsCoordinator.reconcileTitleGenerationModelSelection(settings);
          });
          savedCustomModels = nextCustomModels;
          context.refreshModelSelectors();
        };

        text
          .setPlaceholder(t('settings.customModels.placeholder'))
          .setValue(claudeSettings.customModels)
          .onChange((value) => {
            pendingCustomModels = value;
          });
        text.inputEl.rows = 6;
        text.inputEl.cols = 40;
        text.inputEl.addEventListener('blur', () => {
          void commitCustomModels();
        });
      });

    renderClaudeServiceSettings(container, context);

    // --- Safety ---

    new Setting(container).setName(t('settings.safety')).setHeading();

    new Setting(container)
      .setName(t('settings.claudeSafeMode.name'))
      .setDesc(t('settings.claudeSafeMode.desc'))
      .addDropdown((dropdown) => {
        for (const mode of CLAUDE_SAFE_MODES) {
          dropdown.addOption(mode, t(`settings.claudeSafeMode.${mode}`));
        }
        dropdown
          .setValue(claudeSettings.safeMode)
          .onChange(async (value) => {
            await context.plugin.mutateSettings((settings) => {
              updateClaudeProviderSettings(
                settings,
                { safeMode: value as ClaudeSafeMode },
              );
            });
          });
      });

    new Setting(container)
      .setName(t('settings.loadUserSettings.name'))
      .setDesc(t('settings.loadUserSettings.desc'))
      .addToggle((toggle) =>
        toggle
          .setValue(claudeSettings.loadUserSettings)
          .onChange(async (value) => {
            await context.plugin.mutateSettings((settings) => {
              updateClaudeProviderSettings(settings, { loadUserSettings: value });
            });
          })
      );

    }

    if (showSection('skills')) {
      // --- Skills ---

    new Setting(container).setName(t('settings.slashCommands.name')).setHeading();

    const slashCommandsDesc = container.createDiv({ cls: 'claudian-sp-settings-desc' });
    const descP = slashCommandsDesc.createEl('p', { cls: 'setting-item-description' });
    descP.appendText(t('settings.slashCommands.desc') + ' ');
    descP.createEl('a', {
      text: 'Learn more',
      href: 'https://code.claude.com/docs/en/skills',
    });

    const slashCommandsContainer = container.createDiv({ cls: 'claudian-slash-commands-container' });
    new SlashCommandSettings(
      slashCommandsContainer,
      context.plugin.app,
      claudeWorkspace.vaultCommandRepository,
      'skill',
    );
    }

    if (showSection('commands')) {
    new Setting(container).setName(t('settings.slashCommands.name')).setHeading();

    const commandsContainer = container.createDiv({ cls: 'claudian-slash-commands-container' });
    new SlashCommandSettings(
      commandsContainer,
      context.plugin.app,
      claudeWorkspace.vaultCommandRepository,
      'command',
    );

    context.renderHiddenProviderCommandSetting(container, 'claude', {
      name: t('settings.hiddenSlashCommands.name'),
      desc: t('settings.hiddenSlashCommands.desc'),
      placeholder: t('settings.hiddenSlashCommands.placeholder'),
    });
    }

    if (showSection('agents')) {
      // --- Subagents ---

    new Setting(container).setName(t('settings.subagents.name')).setHeading();

    const agentsDesc = container.createDiv({ cls: 'claudian-sp-settings-desc' });
    agentsDesc.createEl('p', {
      text: t('settings.subagents.desc'),
      cls: 'setting-item-description',
    });

    const agentsContainer = container.createDiv({ cls: 'claudian-agents-container' });
    new AgentSettings(agentsContainer, {
      app: context.plugin.app,
      agentManager: claudeWorkspace.agentManager,
      agentStorage: claudeWorkspace.agentStorage,
    });
    }

    if (showSection('mcp')) {
      // --- MCP Servers ---

    new Setting(container).setName(t('settings.mcpServers.name')).setHeading();

    const mcpDesc = container.createDiv({ cls: 'claudian-mcp-settings-desc' });
    mcpDesc.createEl('p', {
      text: t('settings.mcpServers.desc'),
      cls: 'setting-item-description',
    });

    const mcpContainer = container.createDiv({ cls: 'claudian-mcp-container' });
    new McpSettingsManager(mcpContainer, {
      app: context.plugin.app,
      mcpStorage: claudeWorkspace.mcpStorage,
      broadcastMcpReload: async () => {
        await context.plugin.broadcastToAllViewRuntimes?.(
          (service) => service.reloadMcpServers(),
        );
      },
    });
    }

    if (showSection('provider')) {
      // --- Plugins ---

    new Setting(container).setName(t('settings.plugins.name')).setHeading();

    const pluginsDesc = container.createDiv({ cls: 'claudian-plugin-settings-desc' });
    pluginsDesc.createEl('p', {
      text: t('settings.plugins.desc'),
      cls: 'setting-item-description',
    });

    const pluginsContainer = container.createDiv({ cls: 'claudian-plugins-container' });
    new PluginSettingsManager(pluginsContainer, {
      pluginManager: claudeWorkspace.pluginManager,
      agentManager: claudeWorkspace.agentManager,
      restartTabs: async () => {
        await context.plugin.broadcastToActiveViewRuntimes?.(
          async (service) => { await service.ensureReady({ force: true }); },
        );
      },
    });
    }

    if (showSection('provider')) {
      // --- Experimental ---

    new Setting(container).setName(t('settings.experimental')).setHeading();

    new Setting(container)
      .setName(t('settings.enableChrome.name'))
      .setDesc(t('settings.enableChrome.desc'))
      .addToggle((toggle) =>
        toggle
          .setValue(claudeSettings.enableChrome)
          .onChange(async (value) => {
            await context.plugin.mutateSettings((settings) => {
              updateClaudeProviderSettings(settings, { enableChrome: value });
            });
          })
      );

    new Setting(container)
      .setName(t('settings.enableBangBash.name'))
      .setDesc(t('settings.enableBangBash.desc'))
      .addToggle((toggle) =>
        toggle
          .setValue(claudeSettings.enableBangBash)
          .onChange(async (value) => {
            bangBashValidationEl.toggleClass('claudian-hidden', true);
            if (value) {
              const { findNodeExecutable, getEnhancedPath } = await import('../../../utils/env');
              const nodePath = findNodeExecutable(getEnhancedPath());
              if (!nodePath) {
                bangBashValidationEl.setText(t('settings.enableBangBash.validation.noNode'));
                bangBashValidationEl.toggleClass('claudian-hidden', false);
                toggle.setValue(false);
                return;
              }
            }
            await context.plugin.mutateSettings((settings) => {
              updateClaudeProviderSettings(settings, { enableBangBash: value });
            });
          })
      );

    const bangBashValidationEl = container.createDiv({
      cls: 'claudian-bang-bash-validation claudian-setting-validation claudian-setting-validation-error claudian-hidden',
    });
    }
  },
};
