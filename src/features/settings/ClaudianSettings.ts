import type { App, Plugin } from 'obsidian';
import { Modal, Notice, Platform, PluginSettingTab, Setting } from 'obsidian';

import {
  getHiddenProviderCommands,
  normalizeHiddenCommandList,
} from '../../core/providers/commands/hiddenCommands';
import { ProviderRegistry } from '../../core/providers/ProviderRegistry';
import { ProviderSettingsCoordinator } from '../../core/providers/ProviderSettingsCoordinator';
import { ProviderWorkspaceRegistry } from '../../core/providers/ProviderWorkspaceRegistry';
import type {
  ProviderId,
  ProviderSettingsSectionId,
  ProviderSettingsTabRendererContext,
} from '../../core/providers/types';
import { AgentSkillRepository } from '../../core/skills/AgentSkillRepository';
import type { ChatViewPlacement } from '../../core/types/settings';
import { t } from '../../i18n/i18n';
import { syncLocaleWithObsidian } from '../../i18n/obsidianLocale';
import type { TranslationKey } from '../../i18n/types';
import { AgentSkillSettings } from '../../shared/settings/AgentSkillSettings';
import { applyProviderEnablement } from '../../shared/settings/ProviderEnablementToggle';
import { formatContextLimit, parseContextLimit, parseEnvironmentVariables } from '../../utils/env';
import type { FeatureHost } from '../FeatureHost';
import { AgentSkillManagementCoordinator } from './AgentSkillManagementCoordinator';
import { buildNavMappingText, parseNavMappings } from './keyboardNavigation';
import {
  loadWorkspaceResources,
  type WorkspaceResourceRow,
  type WorkspaceResourceStatus,
} from './workspaceResources';

type SettingsTabId = string;
type WorkspaceSettingsSection = Extract<ProviderSettingsSectionId, 'skills' | 'agents' | 'mcp' | 'commands'>;
const WORKSPACE_SETTINGS_SECTIONS: readonly WorkspaceSettingsSection[] = [
  'skills',
  'agents',
  'mcp',
  'commands',
];
type ObsidianHotkey = { modifiers: string[]; key: string };
type ObsidianHotkeyManager = {
  customKeys?: Record<string, ObsidianHotkey[] | undefined>;
  defaultKeys?: Record<string, ObsidianHotkey[] | undefined>;
};
type ObsidianHotkeyTab = {
  searchInputEl?: HTMLInputElement;
  searchComponent?: { inputEl?: HTMLInputElement };
  updateHotkeyVisibility?: () => void;
};
type ObsidianSettingsController = {
  activeTab?: ObsidianHotkeyTab;
  open: () => void;
  openTabById: (id: string) => void;
};
type AppWithHotkeyInternals = App & {
  hotkeyManager?: ObsidianHotkeyManager;
  setting?: ObsidianSettingsController;
};

class WorkspaceSettingsModal extends Modal {
  constructor(
    app: App,
    private title: string,
    private providerIds: readonly ProviderId[],
    private initialProviderId: ProviderId,
    private renderProvider: (container: HTMLElement, providerId: ProviderId) => void,
  ) {
    super(app);
  }

  onOpen(): void {
    this.setTitle(this.title);
    this.modalEl.addClass('claudian-workspace-manager-modal');
    const nav = this.contentEl.createDiv({ cls: 'claudian-settings-segmented-nav' });
    const content = this.contentEl.createDiv({ cls: 'claudian-settings-workspace-modal-content' });

    const showProvider = (providerId: ProviderId): void => {
      content.empty();
      for (const button of nav.querySelectorAll('button')) {
        const active = button.dataset.providerId === providerId;
        button.toggleClass('is-active', active);
        button.setAttribute('aria-pressed', String(active));
      }
      this.renderProvider(content, providerId);
    };

    for (const providerId of this.providerIds) {
      const button = nav.createEl('button', {
        text: ProviderRegistry.getProviderDisplayName(providerId),
        attr: {
          type: 'button',
          'aria-pressed': String(providerId === this.initialProviderId),
        },
      });
      button.dataset.providerId = providerId;
      button.addEventListener('click', () => showProvider(providerId));
    }
    showProvider(this.initialProviderId);
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

export function getSettingsTabIds(
  _providerTabs: readonly ProviderId[],
): SettingsTabId[] {
  return ['general', 'providers', 'workspace'];
}

export function getOrderedProviderIds(providerIds: readonly ProviderId[]): ProviderId[] {
  return ProviderRegistry.orderProviderIds(providerIds);
}

export type ProviderCardModelState =
  | { kind: 'cli-managed' }
  | { kind: 'manual-models' | 'visible-models'; count: number };

export function getProviderCardMetadata(
  modelState: ProviderCardModelState,
  cliAvailable: boolean,
): string {
  if (!cliAvailable) {
    return t('settings.settingsHub.cliUnavailable');
  }
  if (modelState.kind === 'cli-managed') {
    return t('settings.settingsHub.cliManagedModels');
  }
  return t('settings.settingsHub.visibleModels', { count: modelState.count });
}

export function getProviderCardModelState(
  providerId: ProviderId,
  settings: Record<string, unknown>,
): ProviderCardModelState {
  const config = ProviderRegistry.getChatUIConfig(providerId);
  if (config.modelManagement === 'cli-managed') {
    return { kind: 'cli-managed' };
  }
  return {
    kind: config.modelManagement === 'manual-models' ? 'manual-models' : 'visible-models',
    count: config.getModelOptions(settings).length,
  };
}

function formatHotkey(hotkey: ObsidianHotkey): string {
  const isMac = Platform.isMacOS;
  const modMap: Record<string, string> = isMac
    ? { Mod: '⌘', Ctrl: '⌃', Alt: '⌥', Shift: '⇧', Meta: '⌘' }
    : { Mod: 'Ctrl', Ctrl: 'Ctrl', Alt: 'Alt', Shift: 'Shift', Meta: 'Win' };

  const mods = hotkey.modifiers.map((modifier) => modMap[modifier] || modifier);
  const key = hotkey.key.length === 1 ? hotkey.key.toUpperCase() : hotkey.key;

  return isMac ? [...mods, key].join('') : [...mods, key].join('+');
}

function openHotkeySettings(app: App): void {
  const setting = (app as AppWithHotkeyInternals).setting;
  if (!setting) {
    return;
  }

  setting.open();
  setting.openTabById('hotkeys');
  window.setTimeout(() => {
    const tab = setting.activeTab;
    if (!tab) {
      return;
    }

    const searchEl = tab.searchInputEl ?? tab.searchComponent?.inputEl;
    if (!searchEl) {
      return;
    }

    searchEl.value = 'Codian';
    tab.updateHotkeyVisibility?.();
  }, 100);
}

function getHotkeyForCommand(app: App, commandId: string): string | null {
  const hotkeyManager = (app as AppWithHotkeyInternals).hotkeyManager;
  if (!hotkeyManager) return null;

  const customHotkeys = hotkeyManager.customKeys?.[commandId];
  const defaultHotkeys = hotkeyManager.defaultKeys?.[commandId];
  const hotkeys = customHotkeys && customHotkeys.length > 0 ? customHotkeys : defaultHotkeys;

  if (!hotkeys || hotkeys.length === 0) return null;

  return hotkeys.map(formatHotkey).join(', ');
}

function addHotkeySettingRow(
  containerEl: HTMLElement,
  app: App,
  commandId: string,
  translationPrefix: string,
): void {
  const hotkey = getHotkeyForCommand(app, commandId);
  const item = containerEl.createDiv({ cls: 'claudian-hotkey-item' });
  item.createSpan({
    cls: 'claudian-hotkey-name',
    text: t(`${translationPrefix}.name` as TranslationKey),
  });
  if (hotkey) {
    item.createSpan({ cls: 'claudian-hotkey-badge', text: hotkey });
  }
  item.addEventListener('click', () => openHotkeySettings(app));
}

export class ClaudianSettingTab extends PluginSettingTab {
  plugin: FeatureHost;
  private activeTab: SettingsTabId = 'general';
  private activeProviderId: ProviderId = 'codex';
  private activeWorkspaceProviderId: ProviderId = 'codex';
  private activeWorkspaceSection: WorkspaceSettingsSection = 'skills';
  private refreshTitleModelOptions: (() => void) | null = null;
  private displayGeneration = 0;
  private readonly agentSkillCoordinator: AgentSkillManagementCoordinator;

  constructor(app: App, plugin: FeatureHost & Plugin) {
    super(app, plugin);
    this.plugin = plugin;
    this.agentSkillCoordinator = new AgentSkillManagementCoordinator(
      new AgentSkillRepository(plugin.storage.getAdapter()),
      () => plugin.notifyAgentSkillsChanged(),
    );
  }

  display(): void {
    const displayGeneration = ++this.displayGeneration;
    this.agentSkillCoordinator.resetSubscriptions();
    const { containerEl } = this;
    containerEl.empty();
    containerEl.addClass('claudian-settings');
    this.refreshTitleModelOptions = null;

    syncLocaleWithObsidian();

    const registeredProviderIds = getOrderedProviderIds(ProviderRegistry.getRegisteredProviderIds());
    const tabIds = getSettingsTabIds(registeredProviderIds);
    if (!tabIds.includes(this.activeTab)) {
      this.activeTab = 'general';
    }
    if (!registeredProviderIds.includes(this.activeProviderId)) {
      this.activeProviderId = registeredProviderIds[0] ?? 'claude';
    }
    if (!registeredProviderIds.includes(this.activeWorkspaceProviderId)) {
      this.activeWorkspaceProviderId = registeredProviderIds[0] ?? 'claude';
    }

    const tabBar = containerEl.createDiv({ cls: 'claudian-settings-tabs' });
    const tabButtons = new Map<SettingsTabId, HTMLButtonElement>();
    const tabContents = new Map<SettingsTabId, HTMLDivElement>();

    for (const id of tabIds) {
      const label = this.getTabLabel(id);
      const button = tabBar.createEl('button', {
        cls: `claudian-settings-tab${id === this.activeTab ? ' claudian-settings-tab--active' : ''}`,
        text: label,
        attr: {
          role: 'tab',
          'aria-selected': String(id === this.activeTab),
        },
      });
      button.addEventListener('click', () => {
        this.activeTab = id;
        this.display();
      });
      tabButtons.set(id, button);
    }
    tabBar.setAttribute('role', 'tablist');

    for (const id of tabIds) {
      const content = containerEl.createDiv({
        cls: `claudian-settings-tab-content${id === this.activeTab ? ' claudian-settings-tab-content--active' : ''}`,
      });
      tabContents.set(id, content);
    }

    const activeContent = tabContents.get(this.activeTab);
    if (!activeContent) return;
    switch (this.activeTab) {
      case 'general':
        this.renderGeneralTab(activeContent);
        break;
      case 'providers':
        void this.renderProvidersTab(activeContent, registeredProviderIds, displayGeneration);
        break;
      case 'workspace':
        void this.renderWorkspaceTab(activeContent, registeredProviderIds, displayGeneration);
        break;
      default:
        break;
    }
  }

  private async prepareProviderSettings(
    container: HTMLElement,
    providerIds: readonly ProviderId[],
    displayGeneration: number,
    prepare = true,
  ): Promise<boolean> {
    container.empty();
    container.createDiv({
      cls: 'claudian-settings-provider-loading',
      text: t('settings.settingsHub.loadingResources'),
    });
    try {
      await Promise.all(providerIds.map(async providerId => {
        await ProviderWorkspaceRegistry.ensureInitialized(
          this.plugin.providerHost,
          providerId,
          'settings-tab',
        );
        if (prepare) {
          await ProviderWorkspaceRegistry.prepareSettings(providerId);
        }
      }));
      if (displayGeneration !== this.displayGeneration) return false;
      container.empty();
      return true;
    } catch (error) {
      if (displayGeneration !== this.displayGeneration) return false;
      container.empty();
      container.createDiv({
        cls: 'claudian-setting-validation claudian-setting-validation-error',
        text: `Could not load provider settings: ${
          error instanceof Error ? error.message : 'Unknown error'
        }`,
      });
      return false;
    }
  }

  private getTabLabel(id: SettingsTabId): string {
    const labels: Record<string, TranslationKey> = {
      general: 'settings.tabs.general',
      providers: 'settings.tabs.providers',
      workspace: 'settings.tabs.workspace',
    };
    const key = labels[id];
    return key ? t(key) : id;
  }

  private createProviderSettingsContext(): ProviderSettingsTabRendererContext {
    return {
      plugin: this.plugin.providerHost,
      getConversationModelSelections: async () => {
        const conversations = await Promise.all(
          this.plugin.getConversationList().map(item => this.plugin.getConversationById(item.id)),
        );
        return conversations
          .map(conversation => conversation?.selectedModel)
          .filter((model): model is string => typeof model === 'string');
      },
      renderAgentSkillSettings: (target) => {
        new AgentSkillSettings(target, this.agentSkillCoordinator, this.app);
      },
      renderHiddenProviderCommandSetting: (
        target,
        targetProviderId,
        copy,
      ) => this.renderHiddenProviderCommandSetting(target, targetProviderId, copy),
      refreshModelSelectors: () => {
        for (const view of this.plugin.getAllViews()) {
          view.refreshModelSelector();
        }
      },
      refreshTitleGenerationModelOptions: () => this.refreshTitleModelOptions?.(),
      renderCustomContextLimits: (target, providerId) => this.renderCustomContextLimits(target, providerId),
    };
  }

  private async renderProviderPicker(
    container: HTMLElement,
    providerIds: readonly ProviderId[],
    selectedProviderId: ProviderId,
    onSelect: (providerId: ProviderId) => void,
  ): Promise<void> {
    const picker = container.createDiv({ cls: 'claudian-settings-provider-grid' });
    const settingsBag = this.plugin.settings as unknown as Record<string, unknown>;
    const defaultProviderId = ProviderRegistry.resolveDefaultChatProviderId(settingsBag);

    for (const providerId of providerIds) {
      const enabled = ProviderRegistry.isEnabled(providerId, settingsBag);
      const modelState = getProviderCardModelState(providerId, settingsBag);
      const cliPath = await ProviderWorkspaceRegistry.getCliResolver(providerId)
        ?.resolveFromSettings(settingsBag);
      const card = picker.createDiv({
        cls: `claudian-settings-provider-card${
          providerId === selectedProviderId ? ' claudian-settings-provider-card--active' : ''
        }`,
        attr: {
          role: 'button',
          tabindex: '0',
          'aria-pressed': String(providerId === selectedProviderId),
        },
      });
      const header = card.createDiv({ cls: 'claudian-settings-provider-card-header' });
      const identity = header.createDiv({ cls: 'claudian-settings-provider-card-identity' });
      identity.createSpan({
        cls: 'claudian-settings-provider-card-name',
        text: ProviderRegistry.getProviderDisplayName(providerId),
      });
      if (defaultProviderId === providerId) {
        identity.createSpan({
          cls: 'claudian-settings-provider-default-badge',
          text: t('settings.settingsHub.defaultBadge'),
        });
      }
      const status = header.createEl('button', {
        cls: `claudian-settings-provider-status${enabled ? ' is-enabled' : ''}`,
        text: enabled
          ? t('settings.settingsHub.providerEnabled')
          : t('settings.settingsHub.providerDisabled'),
        attr: {
          type: 'button',
          role: 'switch',
          'aria-checked': String(enabled),
          'aria-label': `${ProviderRegistry.getProviderDisplayName(providerId)}: ${
            enabled ? t('settings.settingsHub.providerEnabled') : t('settings.settingsHub.providerDisabled')
          }`,
        },
      });
      status.addEventListener('click', (event) => {
        event.stopPropagation();
        void (async (): Promise<void> => {
          const applied = await applyProviderEnablement(
            this.createProviderSettingsContext(),
            providerId,
            !enabled,
          );
          if (applied && !enabled) {
            await ProviderWorkspaceRegistry.ensureInitialized(
              this.plugin.providerHost,
              providerId,
              'settings-enable-provider',
            );
            await ProviderWorkspaceRegistry.refreshModelCatalog(providerId);
          }
          this.display();
        })();
      });
      const metadata = card.createDiv({ cls: 'claudian-settings-provider-card-meta' });
      metadata.setText(getProviderCardMetadata(modelState, Boolean(cliPath)));
      card.addEventListener('click', () => onSelect(providerId));
      card.addEventListener('keydown', (event) => {
        if (event.target !== card || (event.key !== 'Enter' && event.key !== ' ')) return;
        event.preventDefault();
        onSelect(providerId);
      });
    }
  }

  private renderProviderSettingsSection(
    container: HTMLElement,
    providerId: ProviderId,
    section: ProviderSettingsSectionId,
  ): void {
    const renderer = ProviderWorkspaceRegistry.getSettingsTabRenderer(providerId);
    if (!renderer?.sections?.includes(section)) {
      const empty = container.createDiv({ cls: 'claudian-settings-empty-state' });
      empty.setText(t('settings.settingsHub.unsupported'));
      return;
    }

    renderer.render(container, this.createProviderSettingsContext(), section);
  }

  private async renderProvidersTab(
    container: HTMLElement,
    providerIds: readonly ProviderId[],
    displayGeneration: number,
  ): Promise<void> {
    if (!await this.prepareProviderSettings(
      container,
      providerIds,
      displayGeneration,
      false,
    )) return;
    if (!await this.prepareProviderSettings(
      container,
      [this.activeProviderId],
      displayGeneration,
    )) return;
    const defaultProviderSetting = new Setting(container)
      .setName(t('settings.settingsHub.defaultProvider'))
      .setDesc(t('settings.defaultChatProvider.desc'))
      .addDropdown((dropdown) => {
        dropdown.addOption('', t('settings.defaultChatProvider.followModel'));
        for (const providerId of providerIds) {
          if (ProviderRegistry.isEnabled(providerId, this.plugin.settings)) {
            dropdown.addOption(providerId, ProviderRegistry.getProviderDisplayName(providerId));
          }
        }
        dropdown
          .setValue(this.plugin.settings.defaultChatProviderId || '')
          .onChange(async (value) => {
            await this.plugin.mutateSettings((settings) => {
              settings.defaultChatProviderId = value;
            });
            for (const view of this.plugin.getAllViews()) {
              view.refreshModelSelector();
            }
            this.display();
          });
      });
    defaultProviderSetting.settingEl.addClass('claudian-settings-default-provider');

    await this.renderProviderPicker(container, providerIds, this.activeProviderId, (providerId) => {
      this.activeProviderId = providerId;
      this.display();
    });
    if (displayGeneration !== this.displayGeneration) return;

    const details = container.createDiv({ cls: 'claudian-settings-provider-details' });
    new Setting(details)
      .setName(t('settings.settingsHub.providerDetails').replace(
        '{provider}',
        ProviderRegistry.getProviderDisplayName(this.activeProviderId),
      ))
      .setHeading();
    this.renderProviderSettingsSection(details, this.activeProviderId, 'provider');
  }

  private async renderWorkspaceTab(
    container: HTMLElement,
    providerIds: readonly ProviderId[],
    displayGeneration: number,
  ): Promise<void> {
    if (!await this.prepareProviderSettings(
      container,
      providerIds,
      displayGeneration,
    )) return;
    const supportingProviderIds = providerIds.filter(providerId => (
      ProviderWorkspaceRegistry.supportsSettingsSection(providerId, this.activeWorkspaceSection)
    ));
    const sectionNav = container.createDiv({ cls: 'claudian-settings-segmented-nav' });
    for (const section of WORKSPACE_SETTINGS_SECTIONS) {
      const button = sectionNav.createEl('button', {
        cls: section === this.activeWorkspaceSection ? 'is-active' : '',
        text: t(`settings.settingsHub.workspaceSections.${section}`),
        attr: {
          type: 'button',
          'aria-pressed': String(section === this.activeWorkspaceSection),
        },
      });
      button.addEventListener('click', () => {
        this.activeWorkspaceSection = section;
        this.display();
      });
    }

    if (supportingProviderIds.length === 0) {
      this.renderProviderSettingsSection(
        container,
        this.activeWorkspaceProviderId,
        this.activeWorkspaceSection,
      );
      return;
    }
    if (!supportingProviderIds.includes(this.activeWorkspaceProviderId)) {
      this.activeWorkspaceProviderId = supportingProviderIds[0];
    }

    const toolbar = container.createDiv({ cls: 'claudian-settings-resource-toolbar' });
    const copy = toolbar.createDiv({ cls: 'claudian-settings-resource-copy' });
    copy.createEl('strong', {
      cls: 'claudian-settings-resource-title',
      text: t(`settings.settingsHub.workspaceSections.${this.activeWorkspaceSection}`),
    });
    copy.createEl('p', { text: t('settings.settingsHub.resourceDesc') });
    const actions = toolbar.createDiv({ cls: 'claudian-settings-resource-actions' });
    const search = actions.createEl('input', {
      cls: 'claudian-settings-resource-search',
      attr: {
        type: 'search',
        placeholder: t('settings.settingsHub.searchResources'),
        'aria-label': t('settings.settingsHub.searchResources'),
      },
    });
    const manageButton = actions.createEl('button', {
      cls: 'mod-cta',
      text: t('settings.settingsHub.newResource'),
      attr: { type: 'button' },
    });
    manageButton.addEventListener('click', () => {
      new WorkspaceSettingsModal(
        this.app,
        t('settings.settingsHub.manageResources').replace(
          '{section}',
          t(`settings.settingsHub.workspaceSections.${this.activeWorkspaceSection}`),
        ),
        supportingProviderIds,
        this.activeWorkspaceProviderId,
        (target, providerId) => this.renderProviderSettingsSection(
          target,
          providerId,
          this.activeWorkspaceSection,
        ),
      ).open();
    });

    const list = container.createDiv({ cls: 'claudian-settings-resource-list' });
    list.setText(t('settings.settingsHub.loadingResources'));
    let resources: WorkspaceResourceRow[] = [];
    const renderRows = (): void => this.renderWorkspaceResourceRows(
      list,
      resources,
      search.value,
    );
    search.addEventListener('input', renderRows);
    void loadWorkspaceResources(providerIds, this.activeWorkspaceSection).then((loaded) => {
      if (!list.isConnected) return;
      resources = loaded;
      renderRows();
    });
  }

  private renderWorkspaceResourceRows(
    container: HTMLElement,
    resources: readonly WorkspaceResourceRow[],
    query: string,
  ): void {
    container.empty();
    const normalizedQuery = query.trim().toLowerCase();
    const filtered = resources.filter(resource => (
      !normalizedQuery
      || resource.name.toLowerCase().includes(normalizedQuery)
      || resource.source.toLowerCase().includes(normalizedQuery)
      || resource.providerIds.some(providerId => (
        ProviderRegistry.getProviderDisplayName(providerId).toLowerCase().includes(normalizedQuery)
      ))
    ));

    if (filtered.length === 0) {
      container.createDiv({
        cls: 'claudian-settings-empty-state',
        text: t('settings.settingsHub.noResources'),
      });
      return;
    }

    const header = container.createDiv({ cls: 'claudian-settings-resource-row is-header' });
    for (const label of [
      t('settings.settingsHub.resourceColumns.name'),
      t('settings.settingsHub.resourceColumns.provider'),
      t('settings.settingsHub.resourceColumns.source'),
      t('settings.settingsHub.resourceColumns.status'),
    ]) {
      header.createSpan({ text: label });
    }

    for (const resource of filtered) {
      const row = container.createDiv({ cls: 'claudian-settings-resource-row' });
      row.createEl('strong', { cls: 'claudian-settings-resource-name', text: resource.name });
      row.createSpan({
        text: resource.providerIds
          .map(providerId => ProviderRegistry.getProviderDisplayName(providerId))
          .join(' · '),
      });
      row.createSpan({ cls: 'claudian-settings-resource-source', text: resource.source });
      row.createSpan({
        cls: `claudian-settings-resource-status is-${resource.status}`,
        text: this.getWorkspaceResourceStatusLabel(resource.status),
      });
    }
  }

  private getWorkspaceResourceStatusLabel(status: WorkspaceResourceStatus): string {
    return t(`settings.settingsHub.resourceStatus.${status}`);
  }

  private renderGeneralTab(container: HTMLElement): void {
    // --- Display ---

    new Setting(container).setName(t('settings.display')).setHeading();

    const maxTabsSetting = new Setting(container)
      .setName(t('settings.maxTabs.name'))
      .setDesc(t('settings.maxTabs.desc'));

    const maxTabsWarningEl = container.createDiv({
      cls: 'claudian-max-tabs-warning claudian-setting-validation claudian-setting-validation-warning claudian-hidden',
    });
    maxTabsWarningEl.setText(t('settings.maxTabs.warning'));

    const updateMaxTabsWarning = (value: number): void => {
      maxTabsWarningEl.toggleClass('claudian-hidden', value <= 5);
    };

    maxTabsSetting.addSlider((slider) => {
      slider
        .setLimits(3, 10, 1)
        .setValue(this.plugin.settings.maxTabs ?? 3)
        .setDynamicTooltip()
        .onChange(async (value) => {
          await this.plugin.mutateSettings((settings) => {
            settings.maxTabs = value;
          });
          updateMaxTabsWarning(value);
          for (const view of this.plugin.getAllViews()) {
            view.refreshTabControls();
          }
        });
      updateMaxTabsWarning(this.plugin.settings.maxTabs ?? 3);
    });

    new Setting(container)
      .setName(t('settings.chatViewPlacement.name'))
      .setDesc(t('settings.chatViewPlacement.desc'))
      .addDropdown((dropdown) => {
        dropdown
          .addOption('right-sidebar', t('settings.chatViewPlacement.rightSidebar'))
          .addOption('left-sidebar', t('settings.chatViewPlacement.leftSidebar'))
          .addOption('main-tab', t('settings.chatViewPlacement.mainTab'))
          .setValue(this.plugin.settings.chatViewPlacement)
          .onChange(async (value) => {
            await this.plugin.mutateSettings((settings) => {
              settings.chatViewPlacement = value as ChatViewPlacement;
            });
          });
      });

    new Setting(container)
      .setName(t('settings.enableAutoScroll.name'))
      .setDesc(t('settings.enableAutoScroll.desc'))
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.enableAutoScroll ?? true)
          .onChange(async (value) => {
            await this.plugin.mutateSettings((settings) => {
              settings.enableAutoScroll = value;
            });
          })
      );

    new Setting(container)
      .setName(t('settings.deferMathRenderingDuringStreaming.name'))
      .setDesc(t('settings.deferMathRenderingDuringStreaming.desc'))
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.deferMathRenderingDuringStreaming ?? true)
          .onChange(async (value) => {
            await this.plugin.mutateSettings((settings) => {
              settings.deferMathRenderingDuringStreaming = value;
            });
          })
      );

    new Setting(container)
      .setName(t('settings.expandFileEditsByDefault.name'))
      .setDesc(t('settings.expandFileEditsByDefault.desc'))
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.expandFileEditsByDefault ?? false)
          .onChange(async (value) => {
            await this.plugin.mutateSettings((settings) => {
              settings.expandFileEditsByDefault = value;
            });
          })
      );

    // --- Conversations ---

    new Setting(container).setName(t('settings.conversations')).setHeading();

    new Setting(container)
      .setName(t('settings.autoTitle.name'))
      .setDesc(t('settings.autoTitle.desc'))
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.enableAutoTitleGeneration)
          .onChange(async (value) => {
            await this.plugin.mutateSettings((settings) => {
              settings.enableAutoTitleGeneration = value;
            });
            this.display();
          })
      );

    if (this.plugin.settings.enableAutoTitleGeneration) {
      new Setting(container)
        .setName(t('settings.titleModel.name'))
        .setDesc(t('settings.titleModel.desc'))
        .addDropdown((dropdown) => {
          const refreshOptions = (): void => {
            dropdown.selectEl.replaceChildren();
            dropdown.addOption('', t('settings.titleModel.auto'));

            const settingsBag = this.plugin.settings as unknown as Record<string, unknown>;
            for (const model of ProviderRegistry.getTitleGenerationModelOptions(settingsBag)) {
              dropdown.addOption(model.value, model.label);
            }
            dropdown.setValue(this.plugin.settings.titleGenerationModel || '');
          };

          this.refreshTitleModelOptions = refreshOptions;
          refreshOptions();
          dropdown.onChange(async (value) => {
            await this.plugin.mutateSettings((settings) => {
              ProviderSettingsCoordinator.applyTitleGenerationModelSelection(settings, value);
            });
          });
        });
    }

    // --- Content ---

    new Setting(container).setName(t('settings.content')).setHeading();

    new Setting(container)
      .setName(t('settings.userName.name'))
      .setDesc(t('settings.userName.desc'))
      .addText((text) => {
        text
          .setPlaceholder(t('settings.userName.name'))
          .setValue(this.plugin.settings.userName)
          .onChange(async (value) => {
            await this.plugin.mutateSettings((settings) => {
              settings.userName = value;
            });
          });
        text.inputEl.addEventListener('blur', () => {
          void this.restartServiceForPromptChange();
        });
      });

    new Setting(container)
      .setName(t('settings.systemPrompt.name'))
      .setDesc(t('settings.systemPrompt.desc'))
      .addTextArea((text) => {
        text
          .setPlaceholder(t('settings.systemPrompt.name'))
          .setValue(this.plugin.settings.systemPrompt)
          .onChange(async (value) => {
            await this.plugin.mutateSettings((settings) => {
              settings.systemPrompt = value;
            });
          });
        text.inputEl.rows = 6;
        text.inputEl.cols = 50;
        text.inputEl.addEventListener('blur', () => {
          void this.restartServiceForPromptChange();
        });
      });

    new Setting(container)
      .setName(t('settings.excludedTags.name'))
      .setDesc(t('settings.excludedTags.desc'))
      .addTextArea((text) => {
        text
          .setPlaceholder('System\nprivate\ndraft')
          .setValue(this.plugin.settings.excludedTags.join('\n'))
          .onChange(async (value) => {
            await this.plugin.mutateSettings((settings) => {
              settings.excludedTags = value
                .split(/\r?\n/)
                .map((entry) => entry.trim().replace(/^#/, ''))
                .filter((entry) => entry.length > 0);
            });
          });
        text.inputEl.rows = 4;
        text.inputEl.cols = 30;
      });

    new Setting(container)
      .setName(t('settings.mediaFolder.name'))
      .setDesc(t('settings.mediaFolder.desc'))
      .addText((text) => {
        text
          .setPlaceholder('Attachments')
          .setValue(this.plugin.settings.mediaFolder)
          .onChange(async (value) => {
            await this.plugin.mutateSettings((settings) => {
              settings.mediaFolder = value.trim();
            });
          });
        text.inputEl.addClass('claudian-settings-media-input');
        text.inputEl.addEventListener('blur', () => {
          void this.restartServiceForPromptChange();
        });
      });

    // --- Input ---

    new Setting(container).setName(t('settings.input')).setHeading();

    new Setting(container)
      .setName(t('settings.requireCommandOrControlEnterToSend.name'))
      .setDesc(t('settings.requireCommandOrControlEnterToSend.desc'))
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.settings.requireCommandOrControlEnterToSend ?? false)
          .onChange(async (value) => {
            await this.plugin.mutateSettings((settings) => {
              settings.requireCommandOrControlEnterToSend = value;
            });
          });
      });

    if (this.plugin.getComposerEnhancement?.()) {
      new Setting(container)
        .setName(t('settings.livePreviewComposer.name'))
        .setDesc(t('settings.livePreviewComposer.desc'))
        .addToggle((toggle) => {
          toggle
            .setValue(this.plugin.settings.enableLivePreviewComposer ?? true)
            .onChange(async (value) => {
              await this.plugin.mutateSettings((settings) => {
                settings.enableLivePreviewComposer = value;
              });
            });
        });
    }

    new Setting(container)
      .setName(t('settings.navMappings.name'))
      .setDesc(t('settings.navMappings.desc'))
      .addTextArea((text) => {
        let pendingValue = buildNavMappingText(this.plugin.settings.keyboardNavigation);
        let saveTimeout: number | null = null;

        const commitValue = async (showError: boolean): Promise<void> => {
          if (saveTimeout !== null) {
            window.clearTimeout(saveTimeout);
            saveTimeout = null;
          }

          const result = parseNavMappings(pendingValue);
          if (!result.settings) {
            if (showError) {
              new Notice(`${t('common.error')}: ${result.error}`);
              pendingValue = buildNavMappingText(this.plugin.settings.keyboardNavigation);
              text.setValue(pendingValue);
            }
            return;
          }

          await this.plugin.mutateSettings((settings) => {
            settings.keyboardNavigation.scrollUpKey = result.settings!.scrollUp;
            settings.keyboardNavigation.scrollDownKey = result.settings!.scrollDown;
            settings.keyboardNavigation.focusInputKey = result.settings!.focusInput;
          });
          pendingValue = buildNavMappingText(this.plugin.settings.keyboardNavigation);
          text.setValue(pendingValue);
        };

        const scheduleSave = (): void => {
          if (saveTimeout !== null) {
            window.clearTimeout(saveTimeout);
          }
          saveTimeout = window.setTimeout(() => {
            void commitValue(false);
          }, 500);
        };

        text
          .setPlaceholder('Map w scrollup\nmap s scrolldown\nmap i focusinput')
          .setValue(pendingValue)
          .onChange((value) => {
            pendingValue = value;
            scheduleSave();
          });

        text.inputEl.rows = 3;
        text.inputEl.addEventListener('blur', () => {
          void commitValue(true);
        });
      });

    // --- Hotkeys ---

    new Setting(container).setName(t('settings.hotkeys')).setHeading();

    const hotkeyGrid = container.createDiv({ cls: 'claudian-hotkey-grid' });
    addHotkeySettingRow(hotkeyGrid, this.app, 'claudian:inline-edit', 'settings.inlineEditHotkey');
    addHotkeySettingRow(hotkeyGrid, this.app, 'claudian:open-view', 'settings.openChatHotkey');
    addHotkeySettingRow(hotkeyGrid, this.app, 'claudian:new-session', 'settings.newSessionHotkey');
    addHotkeySettingRow(hotkeyGrid, this.app, 'claudian:new-tab', 'settings.newTabHotkey');
    addHotkeySettingRow(hotkeyGrid, this.app, 'claudian:close-current-tab', 'settings.closeTabHotkey');

  }

  private renderHiddenProviderCommandSetting(
    container: HTMLElement,
    providerId: ProviderId,
    copy: { name: string; desc: string; placeholder: string },
  ): void {
    new Setting(container)
      .setName(copy.name)
      .setDesc(copy.desc)
      .addTextArea((text) => {
        text
          .setPlaceholder(copy.placeholder)
          .setValue(getHiddenProviderCommands(this.plugin.settings, providerId).join('\n'))
          .onChange(async (value) => {
            await this.plugin.mutateSettings((settings) => {
              settings.hiddenProviderCommands = {
                ...settings.hiddenProviderCommands,
                [providerId]: normalizeHiddenCommandList(value.split(/\r?\n/)),
              };
            });
            this.plugin.getView()?.updateHiddenProviderCommands();
          });
        text.inputEl.rows = 4;
        text.inputEl.cols = 30;
      });
  }

  private renderCustomContextLimits(container: HTMLElement, providerId?: ProviderId): void {
    container.empty();

    const uniqueModelIds = new Set<string>();
    const providerIds = providerId
      ? [providerId]
      : ProviderRegistry.getRegisteredProviderIds();

    for (const targetProviderId of providerIds) {
      const envVars = parseEnvironmentVariables(
        this.plugin.getActiveEnvironmentVariables(targetProviderId),
      );
      for (const modelId of ProviderRegistry.getChatUIConfig(targetProviderId).getCustomModelIds(envVars)) {
        uniqueModelIds.add(modelId);
      }
    }

    if (uniqueModelIds.size === 0) {
      return;
    }

    const headerEl = container.createDiv({ cls: 'claudian-context-limits-header' });
    headerEl.createSpan({
      text: t('settings.customModelOverrides.name'),
      cls: 'claudian-context-limits-label',
    });

    const descEl = container.createDiv({ cls: 'claudian-context-limits-desc' });
    descEl.setText(t('settings.customModelOverrides.desc'));

    const listEl = container.createDiv({ cls: 'claudian-context-limits-list' });

    for (const modelId of uniqueModelIds) {
      const currentValue = this.plugin.settings.customContextLimits?.[modelId];
      const currentAlias = this.plugin.settings.customModelAliases?.[modelId] ?? '';

      const itemEl = listEl.createDiv({ cls: 'claudian-context-limits-item' });
      const nameEl = itemEl.createDiv({ cls: 'claudian-context-limits-model' });
      nameEl.setText(modelId);

      const inputWrapper = itemEl.createDiv({ cls: 'claudian-context-limits-input-wrapper' });
      const aliasInputEl = inputWrapper.createEl('input', {
        type: 'text',
        placeholder: t('settings.customModelAliases.placeholder'),
        cls: 'claudian-context-alias-input',
        value: currentAlias,
      });
      aliasInputEl.setAttribute('aria-label', `Alias for ${modelId}`);
      aliasInputEl.title = 'Custom label shown in the model selector. Leave empty to use the default.';

      const inputEl = inputWrapper.createEl('input', {
        type: 'text',
        placeholder: '200k',
        cls: 'claudian-context-limits-input',
        value: currentValue ? formatContextLimit(currentValue) : '',
      });
      inputEl.setAttribute('aria-label', `Context window for ${modelId}`);

      const validationEl = inputWrapper.createDiv({ cls: 'claudian-context-limit-validation claudian-hidden' });

      const saveAlias = async (): Promise<void> => {
        const existing = this.plugin.settings.customModelAliases[modelId] ?? '';
        const trimmed = aliasInputEl.value.trim();
        if (trimmed === existing) {
          aliasInputEl.value = existing;
          return;
        }

        await this.plugin.mutateSettings((settings) => {
          settings.customModelAliases ??= {};
          if (trimmed) {
            settings.customModelAliases[modelId] = trimmed;
          } else {
            delete settings.customModelAliases[modelId];
          }
        });
        for (const view of this.plugin.getAllViews()) {
          view.refreshModelSelector();
        }
      };

      const saveContextLimit = async (): Promise<void> => {
        const trimmed = inputEl.value.trim();

        if (!trimmed) {
          validationEl.toggleClass('claudian-hidden', true);
          inputEl.classList.remove('claudian-input-error');
        } else {
          const parsed = parseContextLimit(trimmed);
          if (parsed === null) {
            validationEl.setText(t('settings.customContextLimits.invalid'));
            validationEl.toggleClass('claudian-hidden', false);
            inputEl.classList.add('claudian-input-error');
            return;
          }

          validationEl.toggleClass('claudian-hidden', true);
          inputEl.classList.remove('claudian-input-error');
        }
        await this.plugin.mutateSettings((settings) => {
          settings.customContextLimits ??= {};
          if (!trimmed) {
            delete settings.customContextLimits[modelId];
          } else {
            settings.customContextLimits[modelId] = parseContextLimit(trimmed)!;
          }
        });
      };

      inputEl.addEventListener('input', () => {
        void saveContextLimit();
      });
      aliasInputEl.addEventListener('blur', () => {
        void saveAlias();
      });
      aliasInputEl.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          aliasInputEl.blur();
        } else if (event.key === 'Escape') {
          event.preventDefault();
          aliasInputEl.value = this.plugin.settings.customModelAliases?.[modelId] ?? '';
          aliasInputEl.blur();
        }
      });
    }
  }

  private async restartServiceForPromptChange(): Promise<void> {
    const view = this.plugin.getView();
    const tabManager = view?.getTabManager();
    if (!tabManager) return;

    try {
      await tabManager.broadcastToAllTabs(
        async (service) => { await service.ensureReady({ force: true }); }
      );
    } catch {
      // Changes will apply on the next conversation if the restart fails.
    }
  }
}
