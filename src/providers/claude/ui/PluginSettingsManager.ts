import { Notice, setIcon } from 'obsidian';

import type {
  AppAgentManager,
  AppPluginManager,
} from '../../../core/providers/types';
import { isNotifiedMutationError } from '../../../core/storage/NotifiedMutationError';
import type { PluginInfo } from '../../../core/types';
import { t } from '../../../i18n/i18n';

export interface PluginSettingsManagerDeps {
  pluginManager: AppPluginManager;
  agentManager: Pick<AppAgentManager, 'loadAgents'>;
  restartTabs: () => Promise<void>;
}

export class PluginSettingsManager {
  private containerEl: HTMLElement;
  private pluginManager: AppPluginManager;
  private agentManager: Pick<AppAgentManager, 'loadAgents'>;
  private restartTabs: () => Promise<void>;

  constructor(containerEl: HTMLElement, deps: PluginSettingsManagerDeps) {
    this.containerEl = containerEl;
    this.pluginManager = deps.pluginManager;
    this.agentManager = deps.agentManager;
    this.restartTabs = deps.restartTabs;
    this.render();
  }

  private render() {
    this.containerEl.empty();

    const headerEl = this.containerEl.createDiv({ cls: 'claudian-plugin-header' });
    headerEl.createSpan({ text: t('settings.plugins.manager.label'), cls: 'claudian-plugin-label' });

    const refreshBtn = headerEl.createEl('button', {
      cls: 'claudian-settings-action-btn',
      attr: { 'aria-label': t('common.refresh') },
    });
    setIcon(refreshBtn, 'refresh-cw');
    refreshBtn.addEventListener('click', () => {
      void this.refreshPlugins();
    });

    const plugins = this.pluginManager.getPlugins();

    if (plugins.length === 0) {
      const emptyEl = this.containerEl.createDiv({ cls: 'claudian-plugin-empty' });
      emptyEl.setText(t('settings.plugins.manager.empty'));
      return;
    }

    const projectPlugins = plugins.filter(p => p.scope === 'project');
    const userPlugins = plugins.filter(p => p.scope === 'user');

    const listEl = this.containerEl.createDiv({ cls: 'claudian-plugin-list' });

    if (projectPlugins.length > 0) {
      const sectionHeader = listEl.createDiv({ cls: 'claudian-plugin-section-header' });
      sectionHeader.setText(t('settings.plugins.manager.project'));

      for (const plugin of projectPlugins) {
        this.renderPluginItem(listEl, plugin);
      }
    }

    if (userPlugins.length > 0) {
      const sectionHeader = listEl.createDiv({ cls: 'claudian-plugin-section-header' });
      sectionHeader.setText(t('settings.plugins.manager.user'));

      for (const plugin of userPlugins) {
        this.renderPluginItem(listEl, plugin);
      }
    }
  }

  private renderPluginItem(listEl: HTMLElement, plugin: PluginInfo) {
    const itemEl = listEl.createDiv({ cls: 'claudian-plugin-item' });
    if (!plugin.enabled) {
      itemEl.addClass('claudian-plugin-item-disabled');
    }

    const statusEl = itemEl.createDiv({ cls: 'claudian-plugin-status' });
    if (plugin.enabled) {
      statusEl.addClass('claudian-plugin-status-enabled');
    } else {
      statusEl.addClass('claudian-plugin-status-disabled');
    }

    const infoEl = itemEl.createDiv({ cls: 'claudian-plugin-info' });

    const nameRow = infoEl.createDiv({ cls: 'claudian-plugin-name-row' });

    const nameEl = nameRow.createSpan({ cls: 'claudian-plugin-name' });
    nameEl.setText(plugin.name);

    const actionsEl = itemEl.createDiv({ cls: 'claudian-plugin-actions' });

    const toggleBtn = actionsEl.createEl('button', {
      cls: 'claudian-plugin-action-btn',
      attr: { 'aria-label': t(plugin.enabled
        ? 'common.disable'
        : 'common.enable') },
    });
    setIcon(toggleBtn, plugin.enabled ? 'toggle-right' : 'toggle-left');
    toggleBtn.addEventListener('click', () => {
      void this.togglePlugin(plugin.id);
    });
  }

  private async togglePlugin(pluginId: string) {
    const plugin = this.pluginManager.getPlugins().find(p => p.id === pluginId);
    const wasEnabled = plugin?.enabled ?? false;
    let didPersistToggle = false;

    try {
      await this.pluginManager.togglePlugin(pluginId);
      didPersistToggle = true;
      await this.agentManager.loadAgents();

      try {
        await this.restartTabs();
      } catch {
        new Notice(t('settings.plugins.manager.restartFailed'));
      }

      new Notice(t('settings.plugins.manager.toggled', {
        id: pluginId,
        state: t(wasEnabled ? 'common.disabled' : 'common.enabled'),
      }));
    } catch (err) {
      if (didPersistToggle) {
        try {
          await this.pluginManager.togglePlugin(pluginId);
        } catch (rollbackError) {
          if (!isNotifiedMutationError(rollbackError)) {
            const message = rollbackError instanceof Error
              ? rollbackError.message
              : t('settings.plugins.manager.unknownError');
            new Notice(t('settings.plugins.manager.rollbackFailed', { message }));
          }
          return;
        }
      }
      if (!isNotifiedMutationError(err)) {
        const message = err instanceof Error ? err.message : t('settings.plugins.manager.unknownError');
        new Notice(t('settings.plugins.manager.toggleFailed', { message }));
      }
    } finally {
      this.render();
    }
  }

  private async refreshPlugins() {
    try {
      await this.pluginManager.loadPlugins();
      await this.agentManager.loadAgents();

      new Notice(t('settings.plugins.manager.refreshed'));
    } catch (err) {
      const message = err instanceof Error ? err.message : t('settings.plugins.manager.unknownError');
      new Notice(t('settings.plugins.manager.refreshFailed', { message }));
    } finally {
      this.render();
    }
  }

  public refresh() {
    this.render();
  }
}
