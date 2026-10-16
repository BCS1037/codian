import { setIcon } from 'obsidian';

import { getToolIcon } from '../../../core/tools/toolIcons';
import type { ToolCallInfo, ToolDiffData } from '../../../core/types';
import type { DiffLine } from '../../../core/types/diff';
import { t } from '../../../i18n/i18n';
import { setupCollapsible } from './collapsible';
import { renderDiffContent, renderDiffStats } from './DiffRenderer';
import { fileNameOnly } from './ToolCallRenderer';

export interface WriteEditState {
  wrapperEl: HTMLElement;
  contentEl: HTMLElement;
  headerEl: HTMLElement;
  nameEl: HTMLElement;
  summaryEl: HTMLElement;
  statsEl: HTMLElement;
  statusEl: HTMLElement;
  toolCall: ToolCallInfo;
  isExpanded: boolean;
  diffLines?: DiffLine[];
}

export interface WriteEditRenderOptions {
  initiallyExpanded?: boolean;
}

function shortenPath(filePath: string, maxLength = 40): string {
  if (!filePath) return 'file';
  // Normalize path separators for cross-platform support
  const normalized = filePath.replace(/\\/g, '/');
  if (normalized.length <= maxLength) return normalized;

  const parts = normalized.split('/');
  if (parts.length <= 2) {
    return '...' + normalized.slice(-maxLength + 3);
  }

  // Show first dir + ... + filename
  const filename = parts[parts.length - 1];
  const firstDir = parts[0];
  const available = maxLength - firstDir.length - filename.length - 5; // 5 for ".../.../"

  if (available < 0) {
    return '...' + filename.slice(-maxLength + 3);
  }

  return `${firstDir}/.../${filename}`;
}

export function createWriteEditBlock(
  parentEl: HTMLElement,
  toolCall: ToolCallInfo,
  options: WriteEditRenderOptions = {}
): WriteEditState {
  const filePath = (toolCall.input.file_path as string) || t('chat.tools.file');
  const toolName = toolCall.name; // 'Write' or 'Edit'
  const baseAriaLabel = `${toolName}: ${shortenPath(filePath)}`;

  const wrapperEl = parentEl.createDiv({ cls: 'codian-write-edit-block' });
  wrapperEl.dataset.toolId = toolCall.id;

  // Header (clickable to collapse/expand)
  const headerEl = wrapperEl.createDiv({ cls: 'codian-write-edit-header' });
  headerEl.setAttribute('tabindex', '0');
  headerEl.setAttribute('role', 'button');

  // File icon
  const iconEl = headerEl.createDiv({ cls: 'codian-write-edit-icon' });
  iconEl.setAttribute('aria-hidden', 'true');
  setIcon(iconEl, getToolIcon(toolName));

  const nameEl = headerEl.createDiv({ cls: 'codian-write-edit-name' });
  nameEl.setText(toolName);
  const summaryEl = headerEl.createDiv({ cls: 'codian-write-edit-summary' });
  summaryEl.setText(fileNameOnly(filePath) || t('chat.tools.file'));

  // Populated when diff is computed
  const statsEl = headerEl.createDiv({ cls: 'codian-write-edit-stats' });

  const statusEl = headerEl.createDiv({ cls: 'codian-write-edit-status status-running' });
  statusEl.setAttribute('aria-label', t('chat.tools.status.running'));

  // Content area (collapsed by default)
  const contentEl = wrapperEl.createDiv({ cls: 'codian-write-edit-content' });

  // Initial loading state
  const loadingRow = contentEl.createDiv({ cls: 'codian-write-edit-diff-row' });
  const loadingEl = loadingRow.createDiv({ cls: 'codian-write-edit-loading' });
  loadingEl.setText(t('chat.tools.writing'));

  // Create state object
  const state: WriteEditState = {
    wrapperEl,
    contentEl,
    headerEl,
    nameEl,
    summaryEl,
    statsEl,
    statusEl,
    toolCall,
    isExpanded: false,
  };

  // Setup collapsible behavior (handles click, keyboard, ARIA, CSS)
  setupCollapsible(wrapperEl, headerEl, contentEl, state, {
    initiallyExpanded: options.initiallyExpanded ?? false,
    baseAriaLabel,
  });

  return state;
}

export function updateWriteEditWithDiff(state: WriteEditState, diffData: ToolDiffData): void {
  state.statsEl.empty();
  state.contentEl.empty();

  const { diffLines, stats } = diffData;
  state.diffLines = diffLines;

  // Update stats
  renderDiffStats(state.statsEl, stats);

  // Render diff content
  const row = state.contentEl.createDiv({ cls: 'codian-write-edit-diff-row' });
  const diffEl = row.createDiv({ cls: 'codian-write-edit-diff' });
  renderDiffContent(diffEl, diffLines);
}

export function finalizeWriteEditBlock(state: WriteEditState, isError: boolean): void {
  // Update status icon - only show icon on error
  state.statusEl.className = 'codian-write-edit-status';
  state.statusEl.empty();
  state.statusEl.setAttribute('aria-label', t(isError ? 'chat.tools.status.error' : 'chat.tools.status.completed'));

  if (isError) {
    state.statusEl.addClass('status-error');
    setIcon(state.statusEl, 'x');

    // Show error in content if no diff was shown
    if (!state.diffLines) {
      state.contentEl.empty();
      const row = state.contentEl.createDiv({ cls: 'codian-write-edit-diff-row' });
      const errorEl = row.createDiv({ cls: 'codian-write-edit-error' });
      errorEl.setText(state.toolCall.result || t('common.error'));
    }
  } else if (!state.diffLines) {
    // Success but no diff data - clear the "Writing..." loading text and show DONE
    state.contentEl.empty();
    const row = state.contentEl.createDiv({ cls: 'codian-write-edit-diff-row' });
    const doneEl = row.createDiv({ cls: 'codian-write-edit-done-text' });
    doneEl.setText(t('chat.tools.done'));
  }

  // Update wrapper class
  if (isError) {
    state.wrapperEl.addClass('error');
  } else {
    state.wrapperEl.addClass('done');
  }
}

export function renderStoredWriteEdit(
  parentEl: HTMLElement,
  toolCall: ToolCallInfo,
  options: WriteEditRenderOptions = {}
): HTMLElement {
  const filePath = (toolCall.input.file_path as string) || t('chat.tools.file');
  const toolName = toolCall.name;
  const baseAriaLabel = `${toolName}: ${shortenPath(filePath)}`;
  const isError = toolCall.status === 'error' || toolCall.status === 'blocked';

  const wrapperEl = parentEl.createDiv({ cls: 'codian-write-edit-block' });
  if (isError) {
    wrapperEl.addClass('error');
  } else if (toolCall.status === 'completed') {
    wrapperEl.addClass('done');
  }
  wrapperEl.dataset.toolId = toolCall.id;

  // Header
  const headerEl = wrapperEl.createDiv({ cls: 'codian-write-edit-header' });
  headerEl.setAttribute('tabindex', '0');
  headerEl.setAttribute('role', 'button');

  // File icon
  const iconEl = headerEl.createDiv({ cls: 'codian-write-edit-icon' });
  iconEl.setAttribute('aria-hidden', 'true');
  setIcon(iconEl, getToolIcon(toolName));

  const nameEl = headerEl.createDiv({ cls: 'codian-write-edit-name' });
  nameEl.setText(toolName);
  const summaryEl = headerEl.createDiv({ cls: 'codian-write-edit-summary' });
  summaryEl.setText(fileNameOnly(filePath) || t('chat.tools.file'));

  const statsEl = headerEl.createDiv({ cls: 'codian-write-edit-stats' });
  if (toolCall.diffData) {
    renderDiffStats(statsEl, toolCall.diffData.stats);
  }

  // Status indicator - only show icon on error
  const statusEl = headerEl.createDiv({ cls: 'codian-write-edit-status' });
  statusEl.setAttribute('aria-label', t(`chat.tools.status.${toolCall.status}`));
  if (isError) {
    statusEl.addClass('status-error');
    setIcon(statusEl, 'x');
  }

  // Content
  const contentEl = wrapperEl.createDiv({ cls: 'codian-write-edit-content' });

  let contentRendered = false;
  const renderContentOnce = () => {
    if (contentRendered) return;
    const row = contentEl.createDiv({ cls: 'codian-write-edit-diff-row' });

    if (toolCall.diffData && toolCall.diffData.diffLines.length > 0) {
      const diffEl = row.createDiv({ cls: 'codian-write-edit-diff' });
      renderDiffContent(diffEl, toolCall.diffData.diffLines);
    } else if (isError && toolCall.result) {
      const errorEl = row.createDiv({ cls: 'codian-write-edit-error' });
      errorEl.setText(toolCall.result);
    } else {
      const doneEl = row.createDiv({ cls: 'codian-write-edit-done-text' });
      doneEl.setText(isError ? t('chat.tools.errorResult') : t('chat.tools.done'));
    }
    contentRendered = true;
  };
  if (toolCall.status === 'running' || options.initiallyExpanded) renderContentOnce();

  // Setup collapsible behavior (handles click, keyboard, ARIA, CSS)
  const state = { isExpanded: false };
  setupCollapsible(wrapperEl, headerEl, contentEl, state, {
    initiallyExpanded: options.initiallyExpanded ?? false,
    onToggle: (expanded) => {
      if (expanded) renderContentOnce();
    },
    baseAriaLabel,
  });

  return wrapperEl;
}
