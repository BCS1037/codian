import { Notice } from 'obsidian';

import { StartupProfiler } from '../../../core/performance/StartupProfiler';
import type { ProviderCommandDiscoveryResult } from '../../../core/providers/commands/ProviderCommandDiscoveryResult';
import { normalizeProviderCommandDiscoveryItems } from '../../../core/providers/commands/ProviderCommandDiscoveryResult';
import { ProviderCommandDiscoveryStore } from '../../../core/providers/commands/ProviderCommandDiscoveryStore';
import type { ProviderCommandEntry } from '../../../core/providers/commands/ProviderCommandEntry';
import { ProviderRegistry } from '../../../core/providers/ProviderRegistry';
import { ProviderWorkspaceRegistry } from '../../../core/providers/ProviderWorkspaceRegistry';
import type {
  ProviderId,
  ProviderTabWarmupContext,
  ProviderTabWarmupMode,
} from '../../../core/providers/types';
import type { ChatRuntime } from '../../../core/runtime/ChatRuntime';
import type { Conversation, SlashCommand } from '../../../core/types';
import { t } from '../../../i18n/i18n';
import { chooseForkTarget } from '../../../shared/modals/ForkTargetModal';
import {
  cancelScheduledAnimationFrame,
  scheduleAnimationFrame,
  type ScheduledAnimationFrame,
} from '../../../utils/animationFrame';
import { revealWorkspaceLeaf } from '../../../utils/obsidianCompat';
import type { FeatureHost } from '../../FeatureHost';
import { getTabProviderId } from './providerResolution';
import { hasActiveSessionWork } from './SessionRuntimePool';
import {
  activateTab,
  createTab,
  deactivateTab,
  destroyTab,
  type ForkContext,
  getTabTitle,
  initializeTabControllers,
  initializeTabService,
  initializeTabUI,
  recycleTabRuntime,
  refreshTabWorkspaceServices,
  setupServiceCallbacks,
  wireTabInputEvents,
} from './Tab';
import {
  DEFAULT_MAX_TABS,
  MAX_TABS,
  MIN_TABS,
  type PersistedTabManagerState,
  type PersistedTabState,
  type TabBarItem,
  type TabData,
  type TabId,
  type TabManagerCallbacks,
  type TabManagerInterface,
  type TabManagerViewHost,
} from './types';
import { generateTabId } from './types';

function isTabManagerViewHost(value: unknown): value is TabManagerViewHost {
  return !!value
    && typeof value === 'object'
    && 'getTabManager' in (value as Record<string, unknown>);
}

type CreateTabOptions = {
  activate?: boolean;
  draftModel?: string;
};

type OpenConversationOptions = {
  preferNewTab?: boolean;
  activate?: boolean;
};

type ProviderCommandCacheEntry = {
  result: ProviderCommandDiscoveryResult<SlashCommand>;
  key: string;
};

type ProviderWarmupContext = {
  conversation: Conversation | null;
  externalContextPaths: string[];
  runtime: ChatRuntime | null;
  tab: ProviderTabWarmupContext['tab'];
  warmupMode: ProviderTabWarmupMode;
};

type ProviderCommandContext = ProviderWarmupContext & {
  cacheKey: string;
  commandContextRevision: number;
  resourceGeneration: number;
};

type ProviderCommandWarmupEntry = {
  key: string;
  promise: Promise<ProviderCommandDiscoveryResult<SlashCommand>>;
};

type SdkCommandDiscovery = {
  result: ProviderCommandDiscoveryResult<SlashCommand>;
  runtimeCommands?: readonly SlashCommand[];
};

type RuntimeCommandSubscription = {
  runtime: ChatRuntime;
  unsubscribe: () => void;
};

export const PROVIDER_WORKSPACE_INITIALIZATION_TIMEOUT_MS = 15_000;

function waitForProviderWorkspaceInitialization(
  initialization: Promise<void>,
  providerId: ProviderId,
): Promise<void> {
  let timeoutId: number | null = null;
  const timeout = new Promise<void>((_, reject) => {
    timeoutId = window.setTimeout(() => {
      reject(new Error(t('chat.providerWorkspaceInitializationTimeout', {
        provider: providerId,
        seconds: PROVIDER_WORKSPACE_INITIALIZATION_TIMEOUT_MS / 1000,
      })));
    }, PROVIDER_WORKSPACE_INITIALIZATION_TIMEOUT_MS);
  });

  return Promise.race([initialization, timeout]).finally(() => {
    if (timeoutId !== null) {
      window.clearTimeout(timeoutId);
    }
  });
}

/**
 * TabManager coordinates multiple chat tabs.
 */
export class TabManager implements TabManagerInterface {
  private plugin: FeatureHost;
  private containerEl: HTMLElement;
  private view: TabManagerViewHost;

  private tabs: Map<TabId, TabData> = new Map();
  private activeTabId: TabId | null = null;
  private lastAccessedAt: Map<TabId, number> = new Map();
  private callbacks: TabManagerCallbacks;
  private providerCommandWarmups = new Map<TabId, ProviderCommandWarmupEntry>();
  private providerCommandCache = new Map<TabId, ProviderCommandCacheEntry>();
  private providerResourceGenerations = new Map<ProviderId, number>();
  private tabCommandContextRevisions = new Map<TabId, number>();
  private runtimeCommandSubscriptions = new Map<TabId, RuntimeCommandSubscription>();
  private isRestoringState = false;

  /** Guard to prevent concurrent tab switches. */
  private isSwitchingTab = false;
  private pendingSwitchTabId: TabId | null = null;
  private pendingTabCreations = 0;
  private profiledFirstHydration = false;
  private teardownPromise: Promise<void> | null = null;

  /**
   * Gets the current max tabs limit from settings.
   * Clamps to MIN_TABS and MAX_TABS bounds.
   */
  private getMaxTabs(): number {
    const settingsValue = this.plugin.settings.maxTabs ?? DEFAULT_MAX_TABS;
    return Math.max(MIN_TABS, Math.min(MAX_TABS, settingsValue));
  }

  constructor(
    plugin: FeatureHost,
    containerEl: HTMLElement,
    view: TabManagerViewHost,
    callbacks?: TabManagerCallbacks,
  );
  constructor(
    plugin: FeatureHost,
    legacyArg: unknown,
    containerEl: HTMLElement,
    view: TabManagerViewHost,
    callbacks?: TabManagerCallbacks,
  );
  constructor(
    plugin: FeatureHost,
    arg2: unknown,
    arg3: HTMLElement | TabManagerViewHost,
    arg4?: TabManagerViewHost | TabManagerCallbacks,
    arg5: TabManagerCallbacks = {},
  ) {
    this.plugin = plugin;

    if (isTabManagerViewHost(arg3)) {
      this.containerEl = arg2 as HTMLElement;
      this.view = arg3;
      this.callbacks = (arg4 as TabManagerCallbacks | undefined) ?? {};
      return;
    }

    this.containerEl = arg3;
    this.view = arg4 as TabManagerViewHost;
    this.callbacks = arg5;
  }

  // ============================================
  // Tab Lifecycle
  // ============================================

  /**
   * Creates a new tab.
   * @param conversationId Optional conversation to load into the tab.
   * @param tabId Optional tab ID (for restoration).
   * @param options Controls whether the new tab becomes active immediately.
   * @returns The created tab, or null if max tabs reached.
   */
  async createTab(
    conversationId?: string | null,
    tabId?: TabId,
    options: CreateTabOptions = {},
  ): Promise<TabData | null> {
    const maxTabs = this.getMaxTabs();
    if (this.tabs.size + this.pendingTabCreations >= maxTabs) {
      return null;
    }
    this.pendingTabCreations += 1;
    let reservationHeld = true;

    try {
      const { activate = true, draftModel } = options;
      const detachedSession = conversationId
        ? this.plugin.sessionRuntimePool?.takeByConversation(conversationId)
        : null;
      if (detachedSession) {
        await this.attachDetachedSession(detachedSession, activate);
        return detachedSession;
      }

      const conversation = conversationId
        ? this.plugin.getCachedConversation(conversationId)
        : undefined;

      let createdTab: TabData | null = null;
      const tab = createTab({
        plugin: this.plugin,
        containerEl: this.containerEl,
        conversation: conversation ?? undefined,
        tabId,
        ...(typeof draftModel === 'string' ? { draftModel } : {}),
        onStreamingChanged: (isStreaming) => {
          createdTab?.owner?.onStreamingChanged(isStreaming);
        },
        onRewindingChanged: (isRewinding) => {
          createdTab?.owner?.onRewindingChanged(isRewinding);
        },
        onTitleChanged: (title) => {
          createdTab?.owner?.onTitleChanged(title);
        },
        onAttentionChanged: (attention) => {
          const conversationId = createdTab?.conversationId;
          if (conversationId) {
            this.plugin.sessionRuntimePool?.setConversationAttention?.(conversationId, attention);
          }
          createdTab?.owner?.onAttentionChanged(attention);
        },
        onConversationIdChanged: (conversationId) => {
          createdTab?.owner?.onConversationIdChanged(conversationId);
        },
        onRuntimeInstalled: (runtime) => createdTab?.owner?.onRuntimeInstalled(runtime),
      });
      createdTab = tab;
      this.bindTabToManager(tab);

      this.tabCommandContextRevisions.set(tab.id, 0);

      // Initialize UI components with provider catalog
      initializeTabUI(tab, this.plugin, {
        getProviderCatalogConfig: () => tab.owner?.getProviderCatalogConfig() ?? null,
        onCommandContextChanged: () => tab.owner?.onCommandContextChanged(),
        onProviderChanged: async (providerId) => tab.owner?.onProviderChanged(providerId),
      });

      initializeTabControllers(
        tab,
        this.plugin,
        this.view,
        (forkContext) => tab.owner?.handleForkRequest(forkContext) ?? Promise.resolve(),
        (conversationId) => tab.owner?.openConversation(conversationId) ?? Promise.resolve(),
        () => tab.owner?.getProviderCatalogConfig() ?? null,
      );

      // Wire input event handlers
      wireTabInputEvents(tab, this.plugin);

      this.tabs.set(tab.id, tab);
      this.lastAccessedAt.set(tab.id, Date.now());
      this.pendingTabCreations -= 1;
      reservationHeld = false;
      this.callbacks.onTabCreated?.(tab);

      if (!this.isRestoringState && (activate || !this.activeTabId)) {
        await this.switchToTab(tab.id);
      }

      return tab;
    } finally {
      if (reservationHeld) {
        this.pendingTabCreations -= 1;
      }
    }
  }

  private bindTabToManager(tab: TabData): void {
    tab.owner = {
      onStreamingChanged: isStreaming => this.callbacks.onTabStreamingChanged?.(tab.id, isStreaming),
      onRewindingChanged: isRewinding => this.callbacks.onTabRewindingChanged?.(tab.id, isRewinding),
      onTitleChanged: title => this.callbacks.onTabTitleChanged?.(tab.id, title),
      onAttentionChanged: attention => this.callbacks.onTabAttentionChanged?.(tab.id, attention),
      onConversationIdChanged: conversationId => {
        this.bumpTabCommandContextRevision(tab.id);
        tab.ui?.slashCommandDropdown?.resetProviderViewState?.();
        tab.ui?.slashCommandDropdown?.resetSdkSkillsCache?.();
        tab.conversationId = conversationId;
        this.callbacks.onTabConversationChanged?.(tab.id, conversationId);
        tab.session?.notifyWorkStateChanged?.();
      },
      onCommandContextChanged: () => {
        this.bumpTabCommandContextRevision(tab.id);
        tab.ui?.slashCommandDropdown?.resetProviderViewState?.();
        tab.ui?.slashCommandDropdown?.resetSdkSkillsCache?.();
      },
      onProviderChanged: async providerId => {
        this.bumpTabCommandContextRevision(tab.id);
        await this.ensureTabWorkspaceServices(tab, providerId, 'provider-selection');
        this.callbacks.onTabProviderChanged?.(tab.id, providerId);
      },
      onRuntimeInstalled: runtime => this.bindRuntimeCommandSubscription(tab, runtime),
      onPersistedStateChanged: () => this.callbacks.onPersistedStateChanged?.(),
      getProviderCatalogConfig: () => this.getProviderCatalogConfig(tab),
      handleForkRequest: forkContext => this.handleForkRequest(forkContext),
      openConversation: conversationId => this.openConversation(conversationId),
    };
    tab.onRuntimeInstalled = runtime => tab.owner?.onRuntimeInstalled(runtime);
    tab.onPersistedStateChanged = () => tab.owner?.onPersistedStateChanged();
    tab.providerCatalogResolver = () => tab.owner?.getProviderCatalogConfig() ?? null;
  }

  private clearTabManagerOwner(tab: TabData): void {
    tab.owner = null;
    tab.onRuntimeInstalled = undefined;
    tab.onPersistedStateChanged = undefined;
    tab.providerCatalogResolver = null;
  }

  /**
   * Switches to a different tab.
   * @param tabId The tab to switch to.
   */
  async switchToTab(tabId: TabId): Promise<void> {
    const tab = this.tabs.get(tabId);
    if (!tab) {
      return;
    }

    // Guard against concurrent tab switches
    if (this.isSwitchingTab) {
      this.pendingSwitchTabId = tabId;
      return;
    }

    this.isSwitchingTab = true;
    const previousTabId = this.activeTabId;

    try {
      // Deactivate current tab
      if (previousTabId && previousTabId !== tabId) {
        const currentTab = this.tabs.get(previousTabId);
        if (currentTab) {
          deactivateTab(currentTab);
        }
      }

      // Activate new tab
      this.activeTabId = tabId;
      this.lastAccessedAt.set(tabId, Date.now());
      activateTab(tab);
      this.callbacks.onActiveTabChanged?.(previousTabId, tabId);

      const providerId = tab.service?.providerId ?? tab.providerId;
      const needsHydration = !!tab.conversationId && tab.hydrationState !== 'ready';
      if (needsHydration) {
        tab.hydrationState = 'loading';
        this.renderTabHydrationState(tab);
        await this.waitForTabPaint(tab);
        if (!this.isTabAlive(tab)) return;
      }

      try {
        if (!await this.ensureTabWorkspaceServices(tab, providerId, 'tab-activation')) {
          return;
        }

        // Load conversation if not already loaded
        if (needsHydration && tab.conversationId) {
          const span = this.profiledFirstHydration ? null : StartupProfiler.start('active-hydration');
          this.profiledFirstHydration = true;
          try {
            await tab.controllers.conversationController?.switchTo(tab.conversationId);
          } finally {
            if (span) {
              StartupProfiler.finish(span);
            }
          }
          if (!this.isTabAlive(tab)) return;
          tab.hydrationState = 'ready';
        } else if (
          tab.conversationId
          && tab.state.messages.length > 0
          && tab.service
          && !tab.state.isStreaming
          && !tab.state.isSwitchingConversation
          && !tab.state.hasPendingConversationSave
        ) {
          // Passive sync is only safe once local tab state has been persisted.
          const conversation = this.plugin.getConversationSync(tab.conversationId);
          if (conversation) {
            const hasMessages = conversation.messages.length > 0;
            const externalContextPaths = hasMessages
              ? conversation.externalContextPaths || []
              : (this.plugin.settings.persistentExternalContextPaths || []);

            tab.service.syncConversationState(conversation, externalContextPaths);
          }
          tab.hydrationState = 'ready';
        } else if (!tab.conversationId && tab.state.messages.length === 0) {
          // New tab with no conversation - initialize welcome greeting
          tab.controllers.conversationController?.initializeWelcome();
          tab.hydrationState = 'ready';
        }
      } catch (error) {
        if (!this.isTabAlive(tab)) return;
        tab.hydrationState = 'failed';
        this.renderTabHydrationState(tab, error);
        return;
      }

      if (!this.isTabAlive(tab)) return;
      const conversationAttention = tab.conversationId
        ? this.plugin.sessionRuntimePool?.getConversationAttention?.(tab.conversationId)
        : undefined;
      if (conversationAttention?.kind === 'review' && tab.state.attention === null) {
        tab.state.markReviewRequired(conversationAttention.outcome, conversationAttention.since);
      }
      if (tab.state.attention?.kind === 'review') tab.state.acknowledgeReview();
      this.callbacks.onTabSwitched?.(previousTabId, tabId);
    } finally {
      this.isSwitchingTab = false;
      const pendingTabId = this.pendingSwitchTabId;
      this.pendingSwitchTabId = null;
      if (pendingTabId && pendingTabId !== this.activeTabId) {
        await this.switchToTab(pendingTabId);
      }
    }
  }

  /**
   * Closes a tab.
   * @param tabId The tab to close.
   * @param force If true, close even if streaming.
   * @returns True if the tab was closed.
   */
  async closeTab(tabId: TabId, force = false): Promise<boolean> {
    const tab = this.tabs.get(tabId);
    if (!tab) {
      return false;
    }

    // Rewind is a provider/local-state transaction and cannot be interrupted by teardown.
    if (tab.state.isRewinding) {
      return false;
    }

    // If this is the last tab and it's already empty (no conversation),
    // don't close it - it's already a blank draft container.
    if (this.tabs.size === 1 && !tab.conversationId && tab.state.messages.length === 0) {
      return false;
    }

    const retained = this.plugin.sessionRuntimePool?.detach(tab) ?? false;
    if (tab.state.isStreaming && !force && !retained) return false;

    // Prevent in-flight hydration only when execution will be permanently disposed.
    if (!retained) tab.lifecycleState = 'closing';

    // Save conversation before closing. Cleanup remains mandatory if save fails.
    let saveError: unknown;
    let didSaveFail = false;
    if (!retained) {
      try {
        await tab.controllers.conversationController?.save();
      } catch (error) {
        didSaveFail = true;
        saveError = error;
      }
    }

    // Capture tab order BEFORE deletion for fallback calculation
    const tabIdsBefore = Array.from(this.tabs.keys());
    const closingIndex = tabIdsBefore.indexOf(tabId);

    if (retained) this.detachTabViewResources(tab);
    else await destroyTab(tab);
    this.unbindRuntimeCommandSubscription(tabId);
    this.providerCommandWarmups.delete(tabId);
    this.providerCommandCache.delete(tabId);
    this.tabCommandContextRevisions.delete(tabId);
    this.tabs.delete(tabId);
    this.lastAccessedAt.delete(tabId);
    this.callbacks.onTabClosed?.(tabId);

    // If we closed the active tab, switch to another
    if (this.activeTabId === tabId) {
      this.activeTabId = null;

      if (this.tabs.size > 0) {
        // Fallback strategy: prefer previous tab, except for first tab (go to next)
        const fallbackTabId = closingIndex === 0
          ? tabIdsBefore[1]  // First tab: go to next
          : tabIdsBefore[closingIndex - 1];  // Others: go to previous

        if (fallbackTabId && this.tabs.has(fallbackTabId)) {
          await this.switchToTab(fallbackTabId);
        }
      } else {
        // Create a replacement blank tab.
        await this.createTab();
      }
    }

    if (didSaveFail) {
      throw saveError;
    }
    return true;
  }

  private isTabAlive(tab: TabData): boolean {
    return tab.lifecycleState !== 'closing' && this.tabs.get(tab.id) === tab;
  }

  private detachTabViewResources(tab: TabData): void {
    if (this.activeTabId === tab.id) {
      tab.dom.contentEl.appendChild(tab.dom.inputComposerEl);
    }
    deactivateTab(tab);
    this.clearTabManagerOwner(tab);
    this.unbindRuntimeCommandSubscription(tab.id);
    tab.dom.contentEl.remove();
  }

  private waitForTabPaint(tab: TabData): Promise<void> {
    return new Promise(resolve => {
      const ownerWindow = tab.dom.contentEl.ownerDocument?.defaultView
        ?? (typeof window !== 'undefined' ? window : null);
      if (!ownerWindow) {
        resolve();
        return;
      }

      let settled = false;
      let frame: ScheduledAnimationFrame | null = null;
      let timer: number | null = null;

      const done = () => {
        if (settled) return;
        settled = true;
        if (timer !== null) ownerWindow.clearTimeout(timer);
        if (frame) cancelScheduledAnimationFrame(frame);
        resolve();
      };

      timer = ownerWindow.setTimeout(done, 100);
      frame = scheduleAnimationFrame(done, ownerWindow);
    });
  }

  private renderTabHydrationState(tab: TabData, error?: unknown): void {
    const messagesEl = tab.dom.messagesEl;
    messagesEl.empty();

    const statusEl = messagesEl.createDiv({ cls: 'codian-tab-hydration' });
    if (!error) {
      statusEl.createDiv({
        cls: 'codian-tab-hydration-loading',
        text: 'Loading conversation…',
      });
      return;
    }

    statusEl.createDiv({
      cls: 'codian-tab-hydration-error',
      text: error instanceof Error ? error.message : 'Failed to load conversation',
    });
    const retryButton = statusEl.createEl('button', {
      cls: 'mod-cta codian-tab-hydration-retry',
      text: 'Retry',
    });
    retryButton.addEventListener('click', () => {
      if (!this.isTabAlive(tab)) return;
      void this.switchToTab(tab.id);
    });
  }

  // ============================================
  // Tab Queries
  // ============================================

  /** Gets the currently active tab. */
  getActiveTab(): TabData | null {
    return this.activeTabId ? this.tabs.get(this.activeTabId) ?? null : null;
  }

  /** Gets the active tab ID. */
  getActiveTabId(): TabId | null {
    return this.activeTabId;
  }

  /** Gets a tab by ID. */
  getTab(tabId: TabId): TabData | null {
    return this.tabs.get(tabId) ?? null;
  }

  /** Gets all tabs. */
  getAllTabs(): TabData[] {
    return Array.from(this.tabs.values());
  }

  /** Gets the number of tabs. */
  getTabCount(): number {
    return this.tabs.size;
  }

  /** Checks if more tabs can be created. */
  canCreateTab(): boolean {
    return this.tabs.size < this.getMaxTabs();
  }

  /**
   * Finds the least recently used idle tab as a candidate for LRU eviction.
   * Never selects tabs with active session work (streaming, rewinding, background work, etc.).
   * Prefers non-active tabs.
   */
  findLruEvictionCandidate(excludedTabIds?: Set<TabId> | TabId[]): TabData | null {
    const excluded = new Set(
      Array.isArray(excludedTabIds)
        ? excludedTabIds
        : (excludedTabIds ? Array.from(excludedTabIds) : [])
    );

    const eligibleTabs: TabData[] = [];
    for (const tab of this.tabs.values()) {
      if (excluded.has(tab.id)) continue;
      if (hasActiveSessionWork(tab)) continue;
      eligibleTabs.push(tab);
    }

    if (eligibleTabs.length === 0) return null;

    const nonActive = eligibleTabs.filter(tab => tab.id !== this.activeTabId);
    const pool = nonActive.length > 0 ? nonActive : eligibleTabs;

    pool.sort((a, b) => {
      const timeA = this.lastAccessedAt.get(a.id) ?? 0;
      const timeB = this.lastAccessedAt.get(b.id) ?? 0;
      return timeA - timeB;
    });

    return pool[0] ?? null;
  }

  // ============================================
  // Tab Bar Data
  // ============================================

  /** Gets data for rendering the tab bar. */
  getTabBarItems(): TabBarItem[] {
    const items: TabBarItem[] = [];
    let index = 1;

    for (const tab of this.tabs.values()) {
      items.push({
        id: tab.id,
        index: index++,
        title: getTabTitle(tab, this.plugin),
        providerId: getTabProviderId(tab, this.plugin),
        isActive: tab.id === this.activeTabId,
        isStreaming: tab.state.isStreaming,
        attention: tab.state.attention,
        canClose: !tab.state.isRewinding && (
          this.tabs.size > 1
          || !tab.state.isStreaming
          || !!this.plugin.sessionRuntimePool
        ),
      });
    }

    return items;
  }

  // ============================================
  // Conversation Management
  // ============================================

  /**
   * Opens a conversation in a new tab or existing tab.
   * @param conversationId The conversation to open.
   * @param options Controls tab creation behavior (backward-compatible with boolean).
   */
  async openConversation(
    conversationId: string,
    options: boolean | OpenConversationOptions = false,
  ): Promise<void> {
    const preferNewTab = typeof options === 'boolean'
      ? options
      : options.preferNewTab ?? false;
    const activate = typeof options === 'boolean'
      ? true
      : options.activate ?? true;

    // Check if conversation is already open in this view's tabs
    for (const tab of this.tabs.values()) {
      if (tab.conversationId === conversationId) {
        const shouldReloadEmptyConversation = (
          tab.hydrationState === 'ready'
          && tab.conversationId === conversationId
          && tab.state.currentConversationId === conversationId
          && tab.state.messages.length === 0
        );
        const shouldSwitchEmptyConversation = (
          tab.hydrationState === 'ready'
          && tab.conversationId === conversationId
          && tab.state.currentConversationId !== conversationId
          && tab.state.messages.length === 0
        );
        const reload = shouldReloadEmptyConversation
          ? tab.controllers.conversationController?.loadActive() ?? Promise.resolve()
          : (shouldSwitchEmptyConversation
              ? tab.controllers.conversationController?.switchTo(conversationId) ?? Promise.resolve()
              : Promise.resolve());

        await Promise.all([this.switchToTab(tab.id), reload]);
        return;
      }
    }

    // Check if conversation is open in another view (split workspace scenario)
    // Compare view references directly (more robust than leaf comparison)
    const crossViewResult = this.plugin.findConversationAcrossViews(conversationId);
    const isSameView = crossViewResult?.view === this.view;
    if (crossViewResult && !isSameView) {
      // Focus the other view and switch to its tab instead of opening duplicate
      await revealWorkspaceLeaf(this.plugin.app.workspace, crossViewResult.view.leaf);
      await crossViewResult.view.getTabManager()?.switchToTab(crossViewResult.tabId);
      return;
    }

    const detachedSession = this.plugin.sessionRuntimePool?.takeByConversation(conversationId);
    if (detachedSession) {
      await this.attachDetachedSession(detachedSession, activate);
      return;
    }

    // Open in current tab or new tab
    if (preferNewTab) {
      if (this.canCreateTab()) {
        await this.createTab(conversationId, undefined, { activate });
        return;
      }

      const behavior = this.plugin.settings.tabLimitBehavior ?? 'temporary';

      if (behavior === 'lru') {
        const blankTab = Array.from(this.tabs.values()).find(
          tab => !tab.conversationId && tab.state.messages.length === 0,
        );
        if (blankTab) {
          await this.switchToTab(blankTab.id);
          await blankTab.controllers.conversationController?.switchTo(conversationId);
          return;
        }

        const candidate = this.findLruEvictionCandidate();
        if (candidate) {
          await this.closeTab(candidate.id);
          await this.createTab(conversationId, undefined, { activate });
          return;
        }

        const activeTab = this.getActiveTab();
        if (activeTab && !hasActiveSessionWork(activeTab)) {
          await activeTab.controllers.conversationController?.switchTo(conversationId);
          return;
        }

        new Notice(t('chat.tabs.allTabsBusy'));
        return;
      }

      if (behavior === 'in-place' || behavior === 'temporary') {
        const activeTab = this.getActiveTab();
        if (activeTab && !hasActiveSessionWork(activeTab)) {
          await activeTab.controllers.conversationController?.switchTo(conversationId);
          return;
        }
        const idleTab = Array.from(this.tabs.values()).find(tab => !hasActiveSessionWork(tab));
        if (idleTab) {
          await this.switchToTab(idleTab.id);
          await idleTab.controllers.conversationController?.switchTo(conversationId);
          return;
        }
        new Notice(t('chat.tabs.allTabsBusy'));
        return;
      }

      // behavior === 'strict'
      const blankTab = Array.from(this.tabs.values()).find(
        tab => !tab.conversationId && tab.state.messages.length === 0,
      );
      if (blankTab) {
        await this.switchToTab(blankTab.id);
        await blankTab.controllers.conversationController?.switchTo(conversationId);
        return;
      }
      const maxTabs = this.getMaxTabs();
      new Notice(`Maximum ${maxTabs} tabs allowed`);
      return;
    }

    // Open in current tab
    // Note: Don't set tab.conversationId here - the onConversationIdChanged callback
    // will sync it after successful switch. Setting it before switchTo() would cause
    // incorrect tab metadata if switchTo() returns early (streaming/switching/creating).
    const activeTab = this.getActiveTab();
    if (activeTab) {
      await activeTab.controllers.conversationController?.switchTo(conversationId);
    }
  }

  private async attachDetachedSession(tab: TabData, activate: boolean): Promise<void> {
    if (this.tabs.has(tab.id)) {
      tab.session.id = generateTabId();
    }

    tab.dom.contentEl.removeClass('codian-hidden');
    this.containerEl.appendChild(tab.dom.contentEl);
    this.bindTabToManager(tab);
    tab.controllers.selectionController?.setFocusScopeEls([
      tab.dom.contentEl,
      tab.dom.inputComposerEl,
      ...(this.view.getSharedSelectionFocusScopeEls?.() ?? []),
    ]);
    this.tabs.set(tab.id, tab);
    this.tabCommandContextRevisions.set(tab.id, 0);
    if (tab.service) this.bindRuntimeCommandSubscription(tab, tab.service);
    this.callbacks.onTabCreated?.(tab);

    if (!this.isRestoringState && (activate || !this.activeTabId)) {
      await this.switchToTab(tab.id);
    }
  }

  resetDeletedConversation(conversationId: string): void {
    for (const tab of this.tabs.values()) {
      if (tab.conversationId !== conversationId) continue;
      this.plugin.sessionRuntimePool?.markForRetirementOnDetach(tab);
      void this.resetDeletedTabAfterWork(tab, conversationId).catch(() => {
        new Notice(t('chat.deletedConversationResetFailed'));
      });
    }
  }

  private async resetDeletedTabAfterWork(tab: TabData, conversationId: string): Promise<void> {
    if (hasActiveSessionWork(tab)) {
      await new Promise<void>(resolve => {
        const unsubscribe = tab.session.subscribeToWorkState(() => {
          if (hasActiveSessionWork(tab)) return;
          unsubscribe();
          resolve();
        });
      });
    }

    if (this.tabs.get(tab.id) !== tab || tab.conversationId !== conversationId) return;
    const inputController = tab.controllers.inputController;
    const unsentInput = inputController?.captureUnsentInput() ?? null;
    try {
      await tab.controllers.conversationController?.createNew({
        force: true,
        skipSave: true,
      });
      inputController?.restoreUnsentInput(unsentInput);
      this.plugin.sessionRuntimePool?.clearRetirementMark(tab);
    } catch (error) {
      inputController?.restoreUnsentInput(unsentInput);
      throw error;
    }
  }

  /**
   * Creates a new conversation in the active tab.
   */
  async createNewConversation(): Promise<void> {
    const activeTab = this.getActiveTab();
    if (activeTab) {
      await activeTab.controllers.conversationController?.createNew();
      // Sync tab.conversationId with the newly created conversation
      activeTab.conversationId = activeTab.state.currentConversationId;
    }
  }

  invalidateProviderCommandCaches(providerIds?: ProviderId | ProviderId[]): void {
    for (const tab of this.filterTabsByProvider(providerIds, (tab) => getTabProviderId(tab, this.plugin))) {
      this.bumpTabCommandContextRevision(tab.id);
      tab.ui?.slashCommandDropdown?.resetProviderViewState?.();
      tab.ui?.slashCommandDropdown?.resetSdkSkillsCache?.();
    }
  }

  invalidateProviderResources(
    providerIds: ProviderId | ProviderId[],
    generation: number,
  ): void {
    const ids = Array.isArray(providerIds) ? providerIds : [providerIds];
    for (const providerId of ids) {
      this.providerResourceGenerations.set(
        providerId,
        Math.max(this.getProviderResourceGeneration(providerId), generation),
      );
      ProviderWorkspaceRegistry.getCommandCatalog(providerId)?.setRuntimeCommands([]);
    }

    const filter = new Set(ids);
    for (const tab of this.tabs.values()) {
      const providerId = tab.service?.providerId ?? getTabProviderId(tab, this.plugin);
      if (!filter.has(providerId)) continue;
      this.bumpTabCommandContextRevision(tab.id);
      tab.runtimeSupervisor.invalidate(generation);
      tab.ui?.slashCommandDropdown?.resetProviderViewState?.();
      tab.ui?.slashCommandDropdown?.resetSdkSkillsCache?.();
    }
  }

  primeProviderRuntime(providerIds?: ProviderId | ProviderId[]): void {
    for (const tab of this.filterTabsByProvider(providerIds, (tab) => tab.service?.providerId ?? tab.providerId)) {
      this.maybePrimeProviderRuntime(tab);
    }
  }

  private *filterTabsByProvider(
    providerIds: ProviderId | ProviderId[] | undefined,
    resolve: (tab: TabData) => ProviderId,
  ): Iterable<TabData> {
    const filter = providerIds
      ? new Set(Array.isArray(providerIds) ? providerIds : [providerIds])
      : null;

    for (const tab of this.tabs.values()) {
      if (filter && !filter.has(resolve(tab))) {
        continue;
      }
      yield tab;
    }
  }

  // ============================================
  // Fork
  // ============================================

  private async handleForkRequest(context: ForkContext): Promise<void> {
    const target = this.view.isWideLayout?.() ? 'new-tab' : await chooseForkTarget(this.plugin.app);
    if (!target) return;

    if (target === 'new-tab') {
      const tab = await this.forkToNewTab(context);
      if (!tab) {
        const maxTabs = this.getMaxTabs();
        new Notice(t('chat.fork.maxTabsReached', { count: String(maxTabs) }));
        return;
      }
      new Notice(t('chat.fork.notice'));
    } else {
      const success = await this.forkInCurrentTab(context);
      if (!success) {
        new Notice(t('chat.fork.failed', { error: t('chat.fork.errorNoActiveTab') }));
        return;
      }
      new Notice(t('chat.fork.noticeCurrentTab'));
    }
  }

  async forkToNewTab(context: ForkContext): Promise<TabData | null> {
    const maxTabs = this.getMaxTabs();
    if (this.tabs.size >= maxTabs) {
      return null;
    }

    const conversationId = await this.createForkConversation(context);
    try {
      return await this.createTab(conversationId);
    } catch (error) {
      await this.plugin.deleteConversation(conversationId).catch(() => {});
      throw error;
    }
  }

  async forkInCurrentTab(context: ForkContext): Promise<boolean> {
    const activeTab = this.getActiveTab();
    if (!activeTab?.controllers.conversationController) return false;

    const conversationId = await this.createForkConversation(context);
    try {
      await activeTab.controllers.conversationController.switchTo(conversationId);
    } catch (error) {
      await this.plugin.deleteConversation(conversationId).catch(() => {});
      throw error;
    }
    return true;
  }

  private async createForkConversation(context: ForkContext): Promise<string> {
    const conversation = await this.plugin.createConversation({
      providerId: context.providerId,
      ...(context.sourceSelectedModel ? { selectedModel: context.sourceSelectedModel } : {}),
    });

    const title = context.sourceTitle
      ? this.buildForkTitle(context.sourceTitle, context.forkAtUserMessage)
      : undefined;

    const forkProviderState = ProviderRegistry
      .getConversationHistoryService(conversation.providerId)
      .buildForkProviderState(
        context.sourceSessionId,
        context.resumeAt,
        context.sourceProviderState,
      );

    await this.plugin.updateConversation(conversation.id, {
      messages: context.messages,
      providerState: forkProviderState,
      ...(title && { title }),
      ...(context.currentNote && { currentNote: context.currentNote }),
    });

    return conversation.id;
  }

  private buildForkTitle(sourceTitle: string, forkAtUserMessage?: number): string {
    const MAX_TITLE_LENGTH = 50;
    const forkSuffix = forkAtUserMessage ? ` (#${forkAtUserMessage})` : '';
    const forkPrefix = 'Fork: ';
    const maxSourceLength = MAX_TITLE_LENGTH - forkPrefix.length - forkSuffix.length;
    const truncatedSource = sourceTitle.length > maxSourceLength
      ? sourceTitle.slice(0, maxSourceLength - 1) + '…'
      : sourceTitle;
    let title = forkPrefix + truncatedSource + forkSuffix;

    const existingTitles = new Set(this.plugin.getConversationList().map(c => c.title));
    if (existingTitles.has(title)) {
      let n = 2;
      while (existingTitles.has(`${title} ${n}`)) n++;
      title = `${title} ${n}`;
    }

    return title;
  }

  // ============================================
  // Persistence
  // ============================================

  /** Gets the state to persist. */
  getPersistedState(): PersistedTabManagerState {
    const openTabs: PersistedTabState[] = [];

    for (const tab of this.tabs.values()) {
      openTabs.push({
        ...(tab.lifecycleState === 'blank' && tab.draftModel
          ? { draftModel: tab.draftModel }
          : {}),
        tabId: tab.id,
        conversationId: tab.conversationId,
      });
    }

    return {
      openTabs,
      activeTabId: this.activeTabId,
    };
  }

  /** Restores state from persisted data. */
  async restoreState(state: PersistedTabManagerState): Promise<void> {
    this.isRestoringState = true;
    try {
      // Create tabs from persisted state with error handling.
      for (const tabState of state.openTabs) {
        try {
          await this.createTab(tabState.conversationId, tabState.tabId, {
            activate: false,
            ...(typeof tabState.draftModel === 'string' ? { draftModel: tabState.draftModel } : {}),
          });
        } catch {
          // Continue restoring other tabs
        }
      }
    } finally {
      this.isRestoringState = false;
    }

    const fallbackTabId = state.openTabs.find((tabState) => this.tabs.has(tabState.tabId))?.tabId
      ?? Array.from(this.tabs.keys())[0]
      ?? null;
    const targetTabId = state.activeTabId && this.tabs.has(state.activeTabId)
      ? state.activeTabId
      : fallbackTabId;

    // Switch to the previously active tab after all tabs are restored so background
    // restore does not warm the first restored tab by accident.
    if (targetTabId) {
      try {
        await this.switchToTab(targetTabId);
      } catch {
        // Ignore switch errors
      }
    }

    // If no tabs were restored, create a default one
    if (this.tabs.size === 0) {
      await this.createTab();
    }
  }

  // ============================================
  // SDK Commands (Shared)
  // ============================================

  /**
   * Gets provider-scoped SDK supported commands for a tab.
   * @returns Array of SDK commands, or empty array if no service is ready.
   */
  async getSdkCommands(tabId?: TabId): Promise<SlashCommand[]> {
    const { result } = await this.getSdkCommandDiscovery(tabId);
    return result.status === 'ready' ? [...result.items] : [];
  }

  async getProviderCommandDiscovery(
    tabId?: TabId,
  ): Promise<ProviderCommandDiscoveryResult<ProviderCommandEntry>> {
    const targetTab = (tabId ? this.tabs.get(tabId) : this.getActiveTab()) ?? null;
    if (!targetTab) return { status: 'empty' };

    const providerId = getTabProviderId(targetTab, this.plugin);
    const discovery = await this.getSdkCommandDiscovery(targetTab.id);
    const { result } = discovery;
    if (result.status === 'error' || result.status === 'requires-session') {
      return result;
    }

    const catalog = ProviderWorkspaceRegistry.getCommandCatalog(providerId);
    if (!catalog) return { status: 'empty' };
    const entries = await catalog.listDropdownEntries({
      includeBuiltIns: false,
      allowCachedRuntimeCommands: discovery.runtimeCommands !== undefined,
      ...(discovery.runtimeCommands !== undefined
        ? { runtimeCommands: discovery.runtimeCommands }
        : {}),
    });
    return normalizeProviderCommandDiscoveryItems(entries);
  }

  private async getSdkCommandDiscovery(
    tabId?: TabId,
  ): Promise<SdkCommandDiscovery> {
    const targetTab = (tabId ? this.tabs.get(tabId) : this.getActiveTab()) ?? null;
    if (!targetTab) {
      return { result: { status: 'empty' } };
    }

    const providerId = getTabProviderId(targetTab, this.plugin);
    if (!ProviderWorkspaceRegistry.getIfInitialized(providerId)) {
      await ProviderWorkspaceRegistry.ensureInitialized(this.plugin.providerHost, providerId, 'command-picker');
    }

    const staticCapabilities = ProviderRegistry.getCapabilities(providerId);
    if (!staticCapabilities.supportsProviderCommands) {
      return { result: { status: 'empty' } };
    }

    const catalog = ProviderWorkspaceRegistry.getCommandCatalog(providerId);
    const runtimeCommandLoader = ProviderWorkspaceRegistry.getRuntimeCommandLoader(providerId);
    const context = await this.buildProviderWarmupContext(targetTab, providerId);
    const commandContext = this.buildProviderCommandContext(targetTab, providerId, context);
    if (
      targetTab.lifecycleState === 'blank'
      && runtimeCommandLoader
      && targetTab.id !== this.activeTabId
    ) {
      return { result: { status: 'empty' }, runtimeCommands: [] };
    }
    let result: ProviderCommandDiscoveryResult<SlashCommand> = { status: 'empty' };
    let hasRuntimeSnapshot = false;

    const targetService = targetTab.service;
    if (runtimeCommandLoader) {
      hasRuntimeSnapshot = true;
      result = await this.ensureProviderCommandRuntime(targetTab, providerId, context);
    } else if (
      targetService?.providerId === providerId
      && targetService.isReady()
      && !targetTab.runtimeSupervisor.isInvalidated
    ) {
      hasRuntimeSnapshot = true;
      result = normalizeProviderCommandDiscoveryItems(
        await targetService.getSupportedCommands(),
      );
    }

    if (
      catalog
      && targetTab.id === this.activeTabId
      && this.isCommandContextCurrent(targetTab, providerId, commandContext)
      && (result.status === 'ready' || result.status === 'empty')
    ) {
      catalog.setRuntimeCommands(result.status === 'ready' ? [...result.items] : []);
    }
    return {
      result,
      ...(hasRuntimeSnapshot && (result.status === 'ready' || result.status === 'empty')
        ? { runtimeCommands: result.status === 'ready' ? result.items : [] }
        : {}),
    };
  }

  private async ensureProviderCommandRuntime(
    tab: TabData,
    providerId: ProviderId,
    warmupContext?: ProviderWarmupContext,
  ): Promise<ProviderCommandDiscoveryResult<SlashCommand>> {
    if (!this.isProviderCommandLoaderAvailable(providerId)) {
      return { status: 'empty' };
    }

    const resolvedWarmupContext = warmupContext
      ?? await this.buildProviderWarmupContext(tab, providerId);
    const context = this.buildProviderCommandContext(
      tab,
      providerId,
      resolvedWarmupContext,
    );
    const cached = this.providerCommandCache.get(tab.id);
    if (
      (!context.runtime || !context.runtime.isReady())
      && cached
      && cached.key === context.cacheKey
    ) {
      return cached.result.status === 'ready'
        ? { status: 'ready', items: cached.result.items.map(command => ({ ...command })) as [SlashCommand, ...SlashCommand[]] }
        : cached.result;
    }

    const existing = this.providerCommandWarmups.get(tab.id);
    if (existing?.key === context.cacheKey) {
      return await existing.promise;
    }
    this.providerCommandWarmups.delete(tab.id);

    const warmup = this.warmProviderCommandRuntime(tab, providerId, context).finally(() => {
      if (this.providerCommandWarmups.get(tab.id)?.promise === warmup) {
        this.providerCommandWarmups.delete(tab.id);
      }
    });
    this.providerCommandWarmups.set(tab.id, {
      key: context.cacheKey,
      promise: warmup,
    });
    return await warmup;
  }

  private maybePrimeProviderRuntime(tab: TabData): void {
    if (tab.state.isSwitchingConversation) return;
    void this.prewarmProviderTab(tab).catch(() => {});
  }

  private async ensureTabWorkspaceServices(
    tab: TabData,
    providerId: ProviderId,
    reason: string,
  ): Promise<boolean> {
    if (!ProviderWorkspaceRegistry.getIfInitialized(providerId)) {
      await waitForProviderWorkspaceInitialization(
        ProviderWorkspaceRegistry.ensureInitialized(
          this.plugin.providerHost,
          providerId,
          reason,
        ),
        providerId,
      );
    }
    if (!this.isTabAlive(tab)) {
      return false;
    }
    refreshTabWorkspaceServices(tab, this.plugin);
    return true;
  }

  private isProviderCommandLoaderAvailable(providerId: ProviderId): boolean {
    const loader = ProviderWorkspaceRegistry.getRuntimeCommandLoader(providerId);
    if (!loader) return false;
    return loader.isAvailable(this.plugin.settings);
  }

  private async prewarmProviderTab(tab: TabData): Promise<void> {
    const providerId = tab.service?.providerId ?? tab.providerId;
    const hasReadyRuntime = tab.service?.providerId === providerId && tab.service.isReady();
    if (!hasReadyRuntime && tab.id !== this.activeTabId) {
      return;
    }
    const context = await this.buildProviderWarmupContext(tab, providerId);

    switch (context.warmupMode) {
      case 'commands':
        await this.getSdkCommands(tab.id);
        return;
      case 'runtime':
        await this.ensureProviderTabRuntimeReady(tab, providerId, context);
        return;
      default:
        return;
    }
  }

  private async ensureProviderTabRuntimeReady(
    tab: TabData,
    providerId: ProviderId,
    context: ProviderWarmupContext,
  ): Promise<void> {
    if (!context.runtime || context.runtime.providerId !== providerId || !tab.serviceInitialized) {
      await initializeTabService(tab, this.plugin, context.conversation);
      if (!this.isTabAlive(tab)) {
        return;
      }
      setupServiceCallbacks(tab, this.plugin);
    }

    const runtime = tab.service?.providerId === providerId
      && !tab.runtimeSupervisor.isInvalidated
      ? tab.service
      : null;
    if (!runtime) {
      return;
    }

    runtime.syncConversationState(context.conversation, context.externalContextPaths);
    await runtime.ensureReady();
    if (ProviderRegistry.getCapabilities(providerId).supportsProviderCommands) {
      await this.getSdkCommands(tab.id);
    }
  }

  private async buildProviderWarmupContext(
    tab: TabData,
    providerId: ProviderId,
  ): Promise<ProviderWarmupContext> {
    const conversation = tab.conversationId
      ? await this.plugin.getConversationById(tab.conversationId)
      : null;
    const hasConversationContext = (conversation?.messages.length ?? 0) > 0;
    const externalContextPaths = tab.ui.externalContextSelector?.getExternalContexts()
      ?? (hasConversationContext
        ? conversation?.externalContextPaths ?? []
        : this.plugin.settings.persistentExternalContextPaths ?? []);
    const runtime = tab.service?.providerId === providerId
      && !tab.runtimeSupervisor.isInvalidated
      ? tab.service
      : null;
    const warmupMode = this.resolveProviderTabWarmupMode({
      conversation,
      externalContextPaths,
      plugin: this.plugin.providerHost,
      runtime,
      tab: {
        conversationId: tab.conversationId,
        draftModel: tab.draftModel,
        lifecycleState: tab.lifecycleState,
        providerId,
      },
    });

    return {
      conversation,
      externalContextPaths,
      runtime,
      tab: {
        conversationId: tab.conversationId,
        draftModel: tab.draftModel,
        lifecycleState: tab.lifecycleState,
        providerId,
      },
      warmupMode,
    };
  }

  private resolveProviderTabWarmupMode(context: ProviderTabWarmupContext): ProviderTabWarmupMode {
    return ProviderWorkspaceRegistry.getTabWarmupPolicy(context.tab.providerId)?.resolveMode(context) ?? 'none';
  }

  private getProviderResourceGeneration(providerId: ProviderId): number {
    return this.providerResourceGenerations.get(providerId)
      ?? this.plugin.getAgentSkillResourceGeneration?.()
      ?? 0;
  }

  private bumpTabCommandContextRevision(tabId: TabId): void {
    this.tabCommandContextRevisions.set(
      tabId,
      (this.tabCommandContextRevisions.get(tabId) ?? 0) + 1,
    );
    this.providerCommandWarmups.delete(tabId);
    this.providerCommandCache.delete(tabId);
  }

  private isCommandContextCurrent(
    tab: TabData,
    providerId: ProviderId,
    context: ProviderCommandContext,
  ): boolean {
    return this.isTabAlive(tab)
      && getTabProviderId(tab, this.plugin) === providerId
      && (this.tabCommandContextRevisions.get(tab.id) ?? 0) === context.commandContextRevision
      && this.getProviderResourceGeneration(providerId) === context.resourceGeneration;
  }

  private buildProviderCommandContext(
    tab: TabData,
    providerId: ProviderId,
    warmupContext: ProviderWarmupContext,
  ): ProviderCommandContext {
    const loader = ProviderWorkspaceRegistry.getRuntimeCommandLoader(providerId);
    const fingerprint = loader?.getCacheFingerprint(this.plugin.settings) ?? 'catalog';
    const commandContextRevision = this.tabCommandContextRevisions.get(tab.id) ?? 0;
    const resourceGeneration = this.getProviderResourceGeneration(providerId);
    const allowSessionCreation = warmupContext.warmupMode === 'commands'
      && tab.lifecycleState === 'blank'
      && tab.id === this.activeTabId;

    return {
      ...warmupContext,
      cacheKey: [providerId, commandContextRevision, resourceGeneration, fingerprint, allowSessionCreation ? 1 : 0].join('|'),
      commandContextRevision,
      resourceGeneration,
    };
  }

  private async warmProviderCommandRuntime(
    tab: TabData,
    providerId: ProviderId,
    context: ProviderCommandContext,
  ): Promise<ProviderCommandDiscoveryResult<SlashCommand>> {
    const loader = ProviderWorkspaceRegistry.getRuntimeCommandLoader(providerId);
    if (!loader) {
      return { status: 'empty' };
    }
    const result = await loader.loadCommands({
      allowSessionCreation: context.warmupMode === 'commands'
        && tab.lifecycleState === 'blank'
        && tab.id === this.activeTabId,
      conversation: context.conversation,
      externalContextPaths: context.externalContextPaths,
      plugin: this.plugin.providerHost,
      runtime: context.runtime,
    });

    if (
      this.isCommandContextCurrent(tab, providerId, context)
      && (!context.runtime || !context.runtime.isReady())
      && (result.status === 'ready' || result.status === 'empty')
    ) {
      this.providerCommandCache.set(tab.id, {
        key: context.cacheKey,
        result: result.status === 'ready'
          ? { status: 'ready', items: result.items.map(command => ({ ...command })) as [SlashCommand, ...SlashCommand[]] }
          : result,
      });
    } else if (this.isCommandContextCurrent(tab, providerId, context)) {
      this.providerCommandCache.delete(tab.id);
    }
    return result;
  }

  // ============================================
  // Provider Command Catalog
  // ============================================

  private getProviderCatalogConfig(tab: TabData) {
    const providerId = getTabProviderId(tab, this.plugin);
    const catalog = ProviderWorkspaceRegistry.getCommandCatalog(providerId);
    if (!catalog) return null;

    const getEntries = () => this.getProviderCommandDiscovery(tab.id);
    return {
      config: catalog.getDropdownConfig(),
      discovery: new ProviderCommandDiscoveryStore(getEntries),
      getEntries,
    };
  }

  private bindRuntimeCommandSubscription(tab: TabData, runtime: ChatRuntime): void {
    this.unbindRuntimeCommandSubscription(tab.id);
    if (!runtime.onSupportedCommandsChange) return;

    const providerId = runtime.providerId;
    const resourceGeneration = this.getProviderResourceGeneration(providerId);
    const unsubscribe = runtime.onSupportedCommandsChange((commands) => {
      if (
        !this.isTabAlive(tab)
        || tab.service !== runtime
        || tab.runtimeSupervisor.isInvalidated
        || this.getProviderResourceGeneration(providerId) !== resourceGeneration
      ) {
        return;
      }
      if (tab.id === this.activeTabId) {
        ProviderWorkspaceRegistry.getCommandCatalog(providerId)?.setRuntimeCommands(
          commands.map(command => ({ ...command })),
        );
      }
      this.providerCommandCache.delete(tab.id);
      tab.ui.slashCommandDropdown?.resetProviderViewState();
    });
    this.runtimeCommandSubscriptions.set(tab.id, { runtime, unsubscribe });
  }

  private unbindRuntimeCommandSubscription(tabId: TabId): void {
    const subscription = this.runtimeCommandSubscriptions.get(tabId);
    subscription?.unsubscribe();
    this.runtimeCommandSubscriptions.delete(tabId);
  }

  // ============================================
  // Broadcast
  // ============================================

  /**
   * Broadcasts a function call to all initialized tab runtimes.
   * Used by settings managers to apply configuration changes to all tabs.
   * @param fn Function to call on each runtime.
   */
  async broadcastToAllTabs(fn: (service: ChatRuntime) => Promise<void>): Promise<void> {
    await this.broadcastToTabs(this.tabs.values(), fn);
  }

  async broadcastToProviderTabs(
    providerIds: ProviderId | ProviderId[],
    fn: (service: ChatRuntime) => Promise<void>,
  ): Promise<void> {
    await this.broadcastToTabs(
      this.filterTabsByProvider(providerIds, (tab) => tab.service?.providerId ?? tab.providerId),
      fn,
    );
  }

  async recycleProviderRuntimes(providerIds: ProviderId | ProviderId[]): Promise<void> {
    const tabs = this.filterTabsByProvider(
      providerIds,
      (tab) => tab.service?.providerId ?? tab.providerId,
    );
    for (const tab of tabs) {
      await recycleTabRuntime(tab);
    }
  }

  private async broadcastToTabs(
    tabs: Iterable<TabData>,
    fn: (service: ChatRuntime) => Promise<void>,
  ): Promise<void> {
    const promises: Promise<void>[] = [];

    for (const tab of tabs) {
      if (tab.service && tab.serviceInitialized) {
        promises.push(
          fn(tab.service).catch(() => {
            // Silently ignore broadcast errors
          })
        );
      }
    }

    await Promise.all(promises);
  }

  // ============================================
  // Cleanup
  // ============================================

  /** Destroys all tabs and cleans up resources. */
  async destroy(): Promise<void> {
    if (this.teardownPromise) return this.teardownPromise;
    this.teardownPromise = this.destroyAttachedTabs();
    return this.teardownPromise;
  }

  /** Keeps active executions alive when an Obsidian view closes. */
  async detachRunningSessions(): Promise<void> {
    if (this.teardownPromise) return this.teardownPromise;
    this.teardownPromise = this.detachSessionsForViewClose();
    return this.teardownPromise;
  }

  private async destroyAttachedTabs(): Promise<void> {
    // Each tab drains background work and persists its final state during teardown.
    await Promise.all(Array.from(this.tabs.values()).map(tab => destroyTab(tab)));

    for (const tabId of this.runtimeCommandSubscriptions.keys()) {
      this.unbindRuntimeCommandSubscription(tabId);
    }

    this.tabs.clear();
    this.lastAccessedAt.clear();
    this.providerCommandWarmups.clear();
    this.providerCommandCache.clear();
    this.tabCommandContextRevisions.clear();
    this.activeTabId = null;
  }

  private async detachSessionsForViewClose(): Promise<void> {
    for (const tab of this.tabs.values()) {
      if (this.plugin.sessionRuntimePool?.detach(tab)) {
        this.detachTabViewResources(tab);
      } else {
        await destroyTab(tab);
      }
      this.unbindRuntimeCommandSubscription(tab.id);
      this.providerCommandWarmups.delete(tab.id);
      this.providerCommandCache.delete(tab.id);
      this.tabCommandContextRevisions.delete(tab.id);
    }

    this.tabs.clear();
    this.providerCommandWarmups.clear();
    this.providerCommandCache.clear();
    this.tabCommandContextRevisions.clear();
    this.activeTabId = null;
  }
}
