import type { AppTabManagerState } from '../providers/types';

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Validates state before it crosses the persistence boundary.
 *
 * Reads stay tolerant through normalizeTabManagerState(); writes must reject
 * invalid input so an accidental undefined state cannot erase plugin data.
 */
export function isValidTabManagerState(data: unknown): data is AppTabManagerState {
  if (!isRecord(data) || !Array.isArray(data.openTabs)) {
    return false;
  }
  if (data.activeTabId !== null && typeof data.activeTabId !== 'string') {
    return false;
  }
  if (
    data.expandedTitleTabIds !== undefined
    && (!Array.isArray(data.expandedTitleTabIds)
      || !data.expandedTitleTabIds.every(tabId => typeof tabId === 'string'))
  ) {
    return false;
  }

  return data.openTabs.every(tab => (
    isRecord(tab)
    && typeof tab.tabId === 'string'
    && (tab.conversationId === null || typeof tab.conversationId === 'string')
    && (tab.draftModel === undefined
      || tab.draftModel === null
      || typeof tab.draftModel === 'string')
  ));
}

export function normalizeTabManagerState(data: unknown): AppTabManagerState | null {
  if (!isRecord(data) || !Array.isArray(data.openTabs)) {
    return null;
  }

  const openTabs: AppTabManagerState['openTabs'] = [];
  const openTabIds = new Set<string>();
  for (const tab of data.openTabs) {
    if (!isRecord(tab) || typeof tab.tabId !== 'string') {
      continue;
    }

    openTabs.push({
      tabId: tab.tabId,
      conversationId: typeof tab.conversationId === 'string' ? tab.conversationId : null,
      ...(typeof tab.draftModel === 'string'
        ? { draftModel: tab.draftModel }
        : {}),
    });
    openTabIds.add(tab.tabId);
  }

  const expandedTitleTabIds: string[] = [];
  const seenExpandedTabIds = new Set<string>();
  if (Array.isArray(data.expandedTitleTabIds)) {
    for (const tabId of data.expandedTitleTabIds) {
      if (
        typeof tabId !== 'string'
        || !openTabIds.has(tabId)
        || seenExpandedTabIds.has(tabId)
      ) {
        continue;
      }

      expandedTitleTabIds.push(tabId);
      seenExpandedTabIds.add(tabId);
    }
  }

  return {
    openTabs,
    activeTabId: typeof data.activeTabId === 'string' ? data.activeTabId : null,
    ...(expandedTitleTabIds.length > 0 ? { expandedTitleTabIds } : {}),
  };
}
