import {
  isValidTabManagerState,
  normalizeTabManagerState,
} from '@/core/bootstrap/tabManagerState';

describe('isValidTabManagerState', () => {
  it('accepts a complete writable tab state', () => {
    expect(isValidTabManagerState({
      openTabs: [
        { tabId: 'tab-1', conversationId: 'conv-1' },
        { tabId: 'tab-2', conversationId: null, draftModel: 'grok/grok-4.6' },
      ],
      activeTabId: 'tab-1',
      expandedTitleTabIds: ['tab-1'],
    })).toBe(true);
  });

  it.each([
    undefined,
    null,
    {},
    { openTabs: [], activeTabId: undefined },
    { openTabs: [{ tabId: 'tab-1', conversationId: 7 }], activeTabId: null },
    { openTabs: [{ tabId: 'tab-1', conversationId: null, draftModel: 7 }], activeTabId: null },
    { openTabs: [], activeTabId: null, expandedTitleTabIds: ['tab-1', 7] },
  ])('rejects invalid writable state %#', state => {
    expect(isValidTabManagerState(state)).toBe(false);
  });
});

describe('normalizeTabManagerState', () => {
  it('preserves valid expanded title tab ids', () => {
    const result = normalizeTabManagerState({
      openTabs: [
        { tabId: 'tab-1', conversationId: 'conv-1' },
        { tabId: 'tab-2', conversationId: null },
      ],
      activeTabId: 'tab-2',
      expandedTitleTabIds: ['tab-2', 'tab-1'],
    });

    expect(result).toEqual({
      openTabs: [
        { tabId: 'tab-1', conversationId: 'conv-1' },
        { tabId: 'tab-2', conversationId: null },
      ],
      activeTabId: 'tab-2',
      expandedTitleTabIds: ['tab-2', 'tab-1'],
    });
  });

  it('drops invalid, stale, and duplicate expanded title tab ids', () => {
    const result = normalizeTabManagerState({
      openTabs: [
        { tabId: 'tab-1', conversationId: null },
        { tabId: 'tab-2', conversationId: null },
      ],
      activeTabId: 'tab-1',
      expandedTitleTabIds: ['tab-2', 'missing-tab', 'tab-2', 7, 'tab-1'],
    });

    expect(result?.expandedTitleTabIds).toEqual(['tab-2', 'tab-1']);
  });
});
