import { createMockEl } from '@test/helpers/mockElement';
import { Platform, Scope } from 'obsidian';

import { CodianView } from '@/features/chat/CodianView';
import { CODIAN_RIBBON_ICON_ID } from '@/shared/codianLogo';

const MockScope = Scope as typeof Scope & { instances: Scope[] };

function createViewHarness(options: {
  canCreateTab: boolean;
  tabCount?: number;
}): {
  newTabButtonEl: ReturnType<typeof createMockEl>;
  view: any;
} {
  const newTabButtonEl = createMockEl();
  const view = Object.create(CodianView.prototype) as any;

  view.plugin = {
    settings: {},
  };
  view.tabManager = {
    canCreateTab: jest.fn().mockReturnValue(options.canCreateTab),
    getTabCount: jest.fn().mockReturnValue(options.tabCount ?? 1),
  };
  view.tabBarContainerEl = createMockEl();
  view.logoEl = createMockEl();
  view.newTabButtonEl = newTabButtonEl;

  return { newTabButtonEl, view };
}

describe('CodianView tab controls', () => {
  it('uses the Codian mark for the view header icon', () => {
    const view = Object.create(CodianView.prototype) as CodianView;

    expect(view.getIcon()).toBe(CODIAN_RIBBON_ICON_ID);
  });

  it('appends text to the active composer without sending', () => {
    const dispatchEvent = jest.fn();
    const inputEl = {
      value: 'Review',
      selectionStart: 0,
      selectionEnd: 0,
      focus: jest.fn(),
      dispatchEvent,
      ownerDocument: { defaultView: null },
    } as any;
    const view = Object.create(CodianView.prototype) as any;
    view.tabManager = { getActiveTab: jest.fn().mockReturnValue({ dom: { inputEl } }) };

    expect(view.appendToActiveInput('@notes/plan.md')).toBe(true);
    expect(inputEl.value).toBe('Review @notes/plan.md');
    expect(inputEl.selectionStart).toBe(inputEl.value.length);
    expect(dispatchEvent).toHaveBeenCalledTimes(1);
  });

  it('hides the new-tab button when the tab manager is at capacity', () => {
    const { newTabButtonEl, view } = createViewHarness({ canCreateTab: false });

    view.refreshTabControls();

    expect(newTabButtonEl.hasClass('codian-hidden')).toBe(true);
    expect(newTabButtonEl.getAttribute('aria-disabled')).toBe('true');
    expect(newTabButtonEl.getAttribute('aria-hidden')).toBe('true');
  });

  it('shows the new-tab button when another tab can be created', () => {
    const { newTabButtonEl, view } = createViewHarness({ canCreateTab: true });
    newTabButtonEl.addClass('codian-hidden');
    newTabButtonEl.setAttribute('aria-disabled', 'true');
    newTabButtonEl.setAttribute('aria-hidden', 'true');

    view.refreshTabControls();

    expect(newTabButtonEl.hasClass('codian-hidden')).toBe(false);
    expect(newTabButtonEl.getAttribute('aria-disabled')).toBeNull();
    expect(newTabButtonEl.getAttribute('aria-hidden')).toBeNull();
  });

  it('hides tab-only controls while the wide session layout is active', () => {
    const { newTabButtonEl, view } = createViewHarness({ canCreateTab: true, tabCount: 3 });
    view.dualPaneLayout = { isWide: true };

    view.refreshTabControls();

    expect(view.tabBarContainerEl.hasClass('codian-hidden')).toBe(true);
    expect(newTabButtonEl.hasClass('codian-hidden')).toBe(true);
    expect(newTabButtonEl.getAttribute('aria-hidden')).toBe('true');
  });

  it('renders the current conversation list in wide layout and wires selection actions', async () => {
    const sidebar = createMockEl();
    const renderHistoryDropdown = jest.fn();
    const openConversation = jest.fn();
    const openConversationInNewTab = jest.fn();
    const view = Object.create(CodianView.prototype) as any;
    view.dualPaneLayout = { isWide: true };
    view.wideSessionSidebarEl = sidebar;
    view.tabManager = {
      getActiveTab: jest.fn().mockReturnValue({
        controllers: { conversationController: { renderHistoryDropdown } },
      }),
    };
    view.openHistoryConversation = openConversation;
    view.openHistoryConversationInNewTab = openConversationInNewTab;
    view.getHistoryConversationStatus = jest.fn().mockReturnValue({ openState: 'closed', isRunning: false });

    view.renderWideSessionSidebar();

    const [container, options] = renderHistoryDropdown.mock.calls[0];
    expect(container).toBe(sidebar);
    await options.onSelectConversation('conversation-a');
    await options.onOpenConversationInNewTab('conversation-b', false);
    expect(openConversation).toHaveBeenCalledWith('conversation-a');
    expect(openConversationInNewTab).toHaveBeenCalledWith('conversation-b', false);
    expect(options.getConversationStatus('conversation-c')).toEqual({ openState: 'closed', isRunning: false });
  });

  it('passes active-tab review outcome into history conversation status', () => {
    const attention = { kind: 'review', outcome: 'error', since: 42 } as const;
    const activeTab = {
      id: 'tab-active',
      conversationId: 'conversation-a',
      state: { isStreaming: false, attention },
    };
    const view = Object.create(CodianView.prototype) as any;
    view.tabManager = {
      getActiveTab: jest.fn().mockReturnValue(activeTab),
      getAllTabs: jest.fn().mockReturnValue([activeTab]),
    };

    expect(view.getHistoryConversationStatus('conversation-a')).toEqual({
      openState: 'current',
      isRunning: false,
      attention,
      location: 'current-view',
      tabIndex: 1,
    });
  });

  it('returns runtime-only unread attention for a closed history conversation', () => {
    const attention = { kind: 'review', outcome: 'completed', since: 123 } as const;
    const view = Object.create(CodianView.prototype) as any;
    view.plugin = {
      sessionRuntimePool: {
        hasConversation: jest.fn().mockReturnValue(false),
        getConversationAttention: jest.fn().mockReturnValue(attention),
      },
      findConversationAcrossViews: jest.fn().mockReturnValue(null),
    };
    view.tabManager = {
      getActiveTab: jest.fn().mockReturnValue(null),
      getAllTabs: jest.fn().mockReturnValue([]),
    };

    expect(view.getHistoryConversationStatus('conversation-closed')).toMatchObject({
      openState: 'closed',
      isRunning: false,
      attention,
    });
  });

  it('routes wide-layout history selection through the manager for an already open conversation', async () => {
    const existingTab = { id: 'tab-existing', conversationId: 'conversation-a' };
    const messages: unknown[] = [];
    const storedMessage = { id: 'stored-message', role: 'user', content: 'History content', timestamp: 1 };
    const loadActive = jest.fn(async () => { messages.push(storedMessage); });
    const openConversation = jest.fn(async () => loadActive());
    const view = Object.create(CodianView.prototype) as any;
    view.dualPaneLayout = { isWide: true };
    view.plugin = { settings: {}, findConversationAcrossViews: jest.fn().mockReturnValue(null) };
    view.tabManager = {
      getAllTabs: () => [existingTab],
      openConversation,
      canCreateTab: () => true,
    };

    await view.openHistoryConversationInLayout('conversation-a', true);

    expect(openConversation).toHaveBeenCalledWith('conversation-a');
    expect(loadActive).toHaveBeenCalledTimes(1);
    expect(messages).toEqual([storedMessage]);
  });

  it('opens an unseen wide-layout conversation in a separate tab', async () => {
    const openConversation = jest.fn().mockResolvedValue(undefined);
    const view = Object.create(CodianView.prototype) as any;
    view.dualPaneLayout = { isWide: true };
    view.plugin = { settings: {}, findConversationAcrossViews: jest.fn().mockReturnValue(null) };
    view.tabManager = {
      getAllTabs: () => [],
      openConversation,
      canCreateTab: () => true,
    };

    await view.openHistoryConversationInLayout('conversation-new', false);

    expect(openConversation).toHaveBeenCalledWith('conversation-new', { preferNewTab: true, activate: false });
  });

  it('keeps current tab and unsent input when wide-layout tab limit blocks a history selection', async () => {
    const openConversation = jest.fn();
    const view = Object.create(CodianView.prototype) as any;
    view.dualPaneLayout = { isWide: true };
    view.plugin = { settings: { maxTabs: 3 }, findConversationAcrossViews: jest.fn().mockReturnValue(null) };
    view.tabManager = {
      getAllTabs: () => [],
      openConversation,
      canCreateTab: () => false,
    };

    await view.openHistoryConversationInLayout('conversation-new', true);

    expect(openConversation).not.toHaveBeenCalled();
  });

  it('keeps tab controls in the view-owned input row', () => {
    const navRowContent = createMockEl();
    const inputNavRowHostEl = createMockEl();
    const view = Object.create(CodianView.prototype) as any;

    view.containerEl = createMockEl();
    view.navRowContent = navRowContent;
    view.inputNavRowHostEl = inputNavRowHostEl;
    view.tabBar = {
      captureScrollPosition: jest.fn(),
      restoreScrollPosition: jest.fn(),
    };

    view.attachNavRowContentToInputFooter();

    expect(inputNavRowHostEl.children).toContain(navRowContent);
    expect(view.tabBar.captureScrollPosition).toHaveBeenCalledTimes(1);
    expect(view.tabBar.restoreScrollPosition).toHaveBeenCalledTimes(1);
  });

  it('moves only the active tab input into the stable input slot', () => {
    const activeInputSlotEl = createMockEl();
    const tab1 = {
      id: 'tab-1',
      dom: {
        contentEl: createMockEl(),
        inputComposerEl: createMockEl(),
        inputContainerEl: createMockEl(),
      },
    };
    const tab2 = {
      id: 'tab-2',
      dom: {
        contentEl: createMockEl(),
        inputComposerEl: createMockEl(),
        inputContainerEl: createMockEl(),
      },
    };
    const view = Object.create(CodianView.prototype) as any;

    view.activeInputSlotEl = activeInputSlotEl;
    view.tabManager = {
      getActiveTab: jest.fn()
        .mockReturnValueOnce(tab1)
        .mockReturnValueOnce(tab2),
      getTab: jest.fn((id: string) => id === 'tab-1' ? tab1 : tab2),
    };

    view.updateInputLocation();
    view.updateInputLocation();

    expect(activeInputSlotEl.children).toContain(tab2.dom.inputComposerEl);
    expect(activeInputSlotEl.children).not.toContain(tab1.dom.inputComposerEl);
    expect(tab1.dom.contentEl.children).toContain(tab1.dom.inputComposerEl);
  });

  it('keeps only the replacement composer when a tab is rebuilt under the same id', () => {
    const activeInputSlotEl = createMockEl();
    const oldTab = {
      id: 'tab-1',
      dom: {
        contentEl: createMockEl(),
        inputComposerEl: createMockEl(),
        inputContainerEl: createMockEl(),
      },
    };
    const replacementTab = {
      id: 'tab-1',
      dom: {
        contentEl: createMockEl(),
        inputComposerEl: createMockEl(),
        inputContainerEl: createMockEl(),
      },
    };
    let activeTab = oldTab;
    let currentTab = oldTab;
    const view = Object.create(CodianView.prototype) as any;

    view.activeInputSlotEl = activeInputSlotEl;
    view.tabManager = {
      getActiveTab: jest.fn(() => activeTab),
      getTab: jest.fn(() => currentTab),
    };

    view.updateInputLocation();
    activeTab = replacementTab;
    currentTab = replacementTab;
    view.updateInputLocation();

    expect(activeInputSlotEl.children).toEqual([replacementTab.dom.inputComposerEl]);
    expect(oldTab.dom.contentEl.children).toContain(oldTab.dom.inputComposerEl);
  });

  it('does not accumulate composers across repeated same-id tab rebuilds', () => {
    const activeInputSlotEl = createMockEl();
    const createTab = () => ({
      id: 'tab-1',
      dom: {
        contentEl: createMockEl(),
        inputComposerEl: createMockEl(),
        inputContainerEl: createMockEl(),
      },
    });
    let activeTab = createTab();
    const view = Object.create(CodianView.prototype) as any;

    view.activeInputSlotEl = activeInputSlotEl;
    view.tabManager = { getActiveTab: jest.fn(() => activeTab) };
    view.updateInputLocation();

    for (let replacement = 0; replacement < 3; replacement++) {
      activeTab = createTab();
      view.updateInputLocation();
      expect(activeInputSlotEl.children).toEqual([activeTab.dom.inputComposerEl]);
    }
  });

  it('preserves active pending prompt siblings during same-tab input updates', () => {
    const activeInputSlotEl = createMockEl();
    const inputComposerEl = activeInputSlotEl.createDiv();
    const pendingPromptEl = inputComposerEl.createDiv({ cls: 'codian-ask-question-inline' });
    const tab = {
      id: 'tab-1',
      dom: {
        contentEl: createMockEl(),
        inputComposerEl,
        inputContainerEl: inputComposerEl.createDiv({ cls: 'codian-input-container' }),
      },
    };
    const view = Object.create(CodianView.prototype) as any;

    Object.defineProperty(inputComposerEl, 'parentElement', {
      configurable: true,
      get: () => activeInputSlotEl,
    });
    view.activeInputTab = tab;
    view.activeInputSlotEl = activeInputSlotEl;
    view.tabManager = {
      getActiveTab: jest.fn().mockReturnValue(tab),
      getTab: jest.fn().mockReturnValue(tab),
    };

    view.updateInputLocation();

    expect(activeInputSlotEl.children).toContain(inputComposerEl);
    expect(inputComposerEl.children).toContain(pendingPromptEl);
  });

  it('clears the stable input slot when no tab is active', () => {
    const activeInputSlotEl = createMockEl();
    const staleInputEl = activeInputSlotEl.createDiv();
    const view = Object.create(CodianView.prototype) as any;

    view.activeInputTab = { id: 'tab-1' };
    view.activeInputSlotEl = activeInputSlotEl;
    view.tabManager = {
      getActiveTab: jest.fn().mockReturnValue(null),
    };

    view.updateInputLocation();

    expect(activeInputSlotEl.children).not.toContain(staleInputEl);
    expect(view.activeInputTab).toBeNull();
  });

  it('toggles the history dropdown when the history button is clicked', () => {
    const historyDropdown = createMockEl();
    const view = Object.create(CodianView.prototype) as any;
    const resetHistorySearch = jest.fn();

    view.historyDropdown = historyDropdown;
    view.tabManager = {
      getActiveTab: jest.fn().mockReturnValue({
        controllers: {
          conversationController: {
            renderHistoryDropdown: jest.fn(),
            resetHistorySearch,
          },
        },
      }),
    };

    view.toggleHistoryDropdown();

    expect(historyDropdown.hasClass('visible')).toBe(true);

    view.toggleHistoryDropdown();

    expect(historyDropdown.hasClass('visible')).toBe(false);
    expect(resetHistorySearch).toHaveBeenCalled();
  });

  it('rerenders cached history content when reopening the dropdown', () => {
    const historyDropdown = createMockEl();
    const view = Object.create(CodianView.prototype) as any;

    view.historyDropdown = historyDropdown;
    view.historyDropdownDirty = false;
    view.tabManager = {
      getActiveTab: jest.fn().mockReturnValue({
        controllers: { conversationController: { resetHistorySearch: jest.fn() } },
      }),
    };
    view.renderHistoryDropdown = jest.fn();

    view.toggleHistoryDropdown();

    expect(view.historyDropdownDirty).toBe(true);
    expect(view.renderHistoryDropdown).toHaveBeenCalledTimes(1);
  });

  it('defers hidden history rendering and coalesces invalidations until the dropdown opens', () => {
    const historyDropdown = createMockEl();
    const renderHistoryDropdown = jest.fn();
    const view = Object.create(CodianView.prototype) as any;

    view.historyDropdown = historyDropdown;
    view.historyDropdownDirty = true;
    view.historyDropdownRendered = false;
    view.tabManager = {
      getActiveTab: jest.fn().mockReturnValue({
        controllers: {
          conversationController: { renderHistoryDropdown },
        },
      }),
    };

    view.updateHistoryDropdown();
    view.updateHistoryDropdown();

    expect(renderHistoryDropdown).not.toHaveBeenCalled();

    view.toggleHistoryDropdown();

    expect(renderHistoryDropdown).toHaveBeenCalledTimes(1);
    const firstRenderSignal = renderHistoryDropdown.mock.calls[0][1].signal as AbortSignal;
    expect(firstRenderSignal.aborted).toBe(false);

    view.updateHistoryDropdown();

    expect(renderHistoryDropdown).toHaveBeenCalledTimes(2);

    view.toggleHistoryDropdown();
    expect(firstRenderSignal.aborted).toBe(true);
    view.updateHistoryDropdown();

    expect(renderHistoryDropdown).toHaveBeenCalledTimes(2);
  });

  it('persists expanded title tab ids with the tab layout snapshot', () => {
    const view = Object.create(CodianView.prototype) as any;

    view.tabManager = {
      getPersistedState: jest.fn().mockReturnValue({
        openTabs: [
          { tabId: 'tab-1', conversationId: null },
          { tabId: 'tab-2', conversationId: 'conv-2' },
        ],
        activeTabId: 'tab-2',
      }),
    };
    view.tabBar = {
      getExpandedTitleTabIds: jest.fn().mockReturnValue(['tab-2', 'closed-tab']),
    };

    expect(view.getPersistedTabState()).toEqual({
      openTabs: [
        { tabId: 'tab-1', conversationId: null },
        { tabId: 'tab-2', conversationId: 'conv-2' },
      ],
      activeTabId: 'tab-2',
      expandedTitleTabIds: ['tab-2'],
    });
  });

  it('restores expanded title tab ids after restoring tabs', async () => {
    const persistedState = {
      openTabs: [{ tabId: 'tab-1', conversationId: null }],
      activeTabId: 'tab-1',
      expandedTitleTabIds: ['tab-1'],
    };
    const view = Object.create(CodianView.prototype) as any;

    view.plugin = {
      storage: {
        getTabManagerState: jest.fn().mockResolvedValue(persistedState),
      },
    };
    view.tabManager = {
      restoreState: jest.fn().mockResolvedValue(undefined),
      createTab: jest.fn(),
    };
    view.tabBar = {
      setExpandedTitleTabIds: jest.fn(),
    };
    view.updateTabBar = jest.fn();

    await view.restoreOrCreateTabs();

    expect(view.tabManager.restoreState).toHaveBeenCalledWith(persistedState);
    expect(view.tabBar.setExpandedTitleTabIds).toHaveBeenCalledWith(['tab-1']);
    expect(view.updateTabBar).toHaveBeenCalledTimes(1);
    expect(view.tabManager.createTab).not.toHaveBeenCalled();
  });
});

describe('CodianView shutdown', () => {
  it('disposes view resources when the final tab-state flush fails', async () => {
    const error = new Error('disk full');
    const view = Object.create(CodianView.prototype) as any;
    const destroy = jest.fn().mockResolvedValue(undefined);
    const tabBarDestroy = jest.fn();
    const persistenceDispose = jest.fn();

    Object.assign(view, {
      cancelHistoryRendering: jest.fn(),
      eventRefs: [],
      mentionCacheCoordinator: {},
      pendingTabBarUpdate: null,
      persistTabStateImmediate: jest.fn().mockRejectedValue(error),
      plugin: { app: { vault: { offref: jest.fn() } } },
      restoreActiveInputToTabContent: jest.fn(),
      scope: {},
      tabBar: { destroy: tabBarDestroy },
      tabManager: { destroy },
      tabStatePersistence: { dispose: persistenceDispose },
    });

    await expect(view.onClose()).resolves.toBeUndefined();

    expect(persistenceDispose).toHaveBeenCalledTimes(1);
    expect(view.restoreActiveInputToTabContent).toHaveBeenCalledTimes(1);
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(tabBarDestroy).toHaveBeenCalledTimes(1);
    expect(view.tabManager).toBeNull();
    expect(view.scope).toBeNull();
  });
});

describe('CodianView Escape handling', () => {
  beforeEach(() => {
    MockScope.instances.length = 0;
  });

  function createEscapeHarness(options: {
    isStreaming: boolean;
  }): {
    cancelInlineRename: jest.Mock;
    cancelStreaming: jest.Mock;
    eventRefs: unknown[];
    view: any;
  } {
    const cancelInlineRename = jest.fn().mockReturnValue(false);
    const cancelStreaming = jest.fn();
    const eventRefs: unknown[] = [];
    const parentScope = new Scope();
    const view = Object.create(CodianView.prototype) as any;

    view.app = { scope: parentScope };
    view.containerEl = createMockEl();
    view.historyDropdown = createMockEl();
    view.registerDomEvent = jest.fn();
    view.registerEvent = jest.fn();
    view.eventRefs = eventRefs;
    view.plugin = {
      app: {
        vault: {
          on: jest.fn((_event: string, handler: unknown) => {
            const ref = { handler };
            eventRefs.push(ref);
            return ref;
          }),
        },
        workspace: {
          on: jest.fn((_event: string, handler: unknown) => {
            const ref = { handler };
            eventRefs.push(ref);
            return ref;
          }),
        },
      },
    };
    view.tabManager = {
      getActiveTab: jest.fn().mockReturnValue({
        state: { isStreaming: options.isStreaming },
        controllers: {
          conversationController: { cancelInlineRename },
          inputController: { cancelStreaming },
        },
        ui: {
          fileContextManager: {
            markFileCacheDirty: jest.fn(),
            markFolderCacheDirty: jest.fn(),
            handleFileOpen: jest.fn(),
            handleClickOutside: jest.fn(),
          },
        },
      }),
    };

    return { cancelInlineRename, cancelStreaming, eventRefs, view };
  }

  function createScopedSendHarness(options: {
    inputFocused: boolean;
  }): {
    inputEl: HTMLTextAreaElement;
    sendMessage: jest.Mock;
    view: any;
  } {
    const sendMessage = jest.fn();
    const inputEl = createMockEl('textarea') as unknown as HTMLTextAreaElement;
    Object.defineProperty(inputEl.ownerDocument, 'activeElement', {
      configurable: true,
      get: () => options.inputFocused ? inputEl : null,
    });
    const eventRefs: unknown[] = [];
    const parentScope = new Scope();
    const view = Object.create(CodianView.prototype) as any;

    view.app = { scope: parentScope };
    view.containerEl = createMockEl();
    view.historyDropdown = createMockEl();
    view.registerDomEvent = jest.fn();
    view.registerEvent = jest.fn();
    view.eventRefs = eventRefs;
    view.plugin = {
      app: {
        vault: {
          on: jest.fn((_event: string, handler: unknown) => {
            const ref = { handler };
            eventRefs.push(ref);
            return ref;
          }),
        },
        workspace: {
          on: jest.fn((_event: string, handler: unknown) => {
            const ref = { handler };
            eventRefs.push(ref);
            return ref;
          }),
        },
      },
    };
    view.tabManager = {
      getActiveTab: jest.fn().mockReturnValue({
        state: { isStreaming: false },
        dom: { inputEl },
        controllers: {
          inputController: { sendMessage },
        },
        ui: {
          fileContextManager: {
            markFileCacheDirty: jest.fn(),
            markFolderCacheDirty: jest.fn(),
            handleFileOpen: jest.fn(),
            handleClickOutside: jest.fn(),
          },
        },
      }),
    };

    return { inputEl, sendMessage, view };
  }

  it('registers Escape on the Obsidian view scope instead of document keydown capture', () => {
    const { view } = createEscapeHarness({ isStreaming: true });

    view.wireEventHandlers();

    expect(view.scope).toBeInstanceOf(Scope);
    expect(view.scope.parent).toBe(view.app.scope);
    expect(view.scope.register).toHaveBeenCalledWith([], 'Escape', expect.any(Function));
    expect(view.registerDomEvent).not.toHaveBeenCalledWith(
      expect.anything(),
      'keydown',
      expect.any(Function),
      { capture: true }
    );
  });

  it('cancels streaming and consumes scoped Escape', () => {
    const { cancelStreaming, view } = createEscapeHarness({ isStreaming: true });

    view.wireEventHandlers();
    const escapeHandler = view.scope.handlers.find((handler: any) => handler.key === 'Escape');
    const result = escapeHandler.func({ key: 'Escape', isComposing: false } as KeyboardEvent);

    expect(cancelStreaming).toHaveBeenCalledTimes(1);
    expect(result).toBe(false);
  });

  it('cancels inline rename before cancelling streaming', () => {
    const { cancelInlineRename, cancelStreaming, view } = createEscapeHarness({ isStreaming: true });
    cancelInlineRename.mockReturnValue(true);

    view.wireEventHandlers();
    const escapeHandler = view.scope.handlers.find((handler: any) => handler.key === 'Escape');
    const result = escapeHandler.func({ key: 'Escape', isComposing: false } as KeyboardEvent);

    expect(cancelInlineRename).toHaveBeenCalledTimes(1);
    expect(cancelStreaming).not.toHaveBeenCalled();
    expect(result).toBe(false);
  });

  it('consumes scoped Escape without cancelling when not streaming', () => {
    const { cancelStreaming, view } = createEscapeHarness({ isStreaming: false });

    view.wireEventHandlers();
    const escapeHandler = view.scope.handlers.find((handler: any) => handler.key === 'Escape');
    const result = escapeHandler.func({ key: 'Escape', isComposing: false } as KeyboardEvent);

    expect(cancelStreaming).not.toHaveBeenCalled();
    expect(result).toBe(false);
  });

  it('consumes already handled scoped Escape without cancelling again', () => {
    const { cancelStreaming, view } = createEscapeHarness({ isStreaming: true });

    view.wireEventHandlers();
    const escapeHandler = view.scope.handlers.find((handler: any) => handler.key === 'Escape');
    const result = escapeHandler.func({
      key: 'Escape',
      isComposing: false,
      defaultPrevented: true,
    } as KeyboardEvent);

    expect(cancelStreaming).not.toHaveBeenCalled();
    expect(result).toBe(false);
  });

  it('sends from focused composer through scoped Mod+Enter', () => {
    Platform.isMacOS = true;
    const { sendMessage, view } = createScopedSendHarness({ inputFocused: true });

    view.wireEventHandlers();
    const sendHandler = view.scope.handlers.find(
      (handler: any) => handler.key === 'Enter' && handler.modifiers?.includes('Mod')
    );
    const event = {
      key: 'Enter',
      shiftKey: false,
      ctrlKey: false,
      metaKey: true,
      altKey: false,
      isComposing: false,
      defaultPrevented: false,
      preventDefault: jest.fn(),
    } as unknown as KeyboardEvent;
    const result = sendHandler.func(event);

    expect(event.preventDefault).toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(result).toBe(false);
  });

  it('ignores scoped Mod+Enter when composer is not focused', () => {
    Platform.isMacOS = true;
    const { sendMessage, view } = createScopedSendHarness({ inputFocused: false });

    view.wireEventHandlers();
    const sendHandler = view.scope.handlers.find(
      (handler: any) => handler.key === 'Enter' && handler.modifiers?.includes('Mod')
    );
    const event = {
      key: 'Enter',
      shiftKey: false,
      ctrlKey: false,
      metaKey: true,
      altKey: false,
      isComposing: false,
      defaultPrevented: false,
      preventDefault: jest.fn(),
    } as unknown as KeyboardEvent;
    const result = sendHandler.func(event);

    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
    expect(result).toBeUndefined();
  });
});
