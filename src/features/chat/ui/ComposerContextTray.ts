import { setIcon } from 'obsidian';

import { t } from '../../../i18n/i18n';
import {
  cancelScheduledAnimationFrame,
  scheduleAnimationFrame,
  type ScheduledAnimationFrame,
} from '../../../utils/animationFrame';

export type ComposerContextSlot =
  | 'current-note'
  | 'editor-selection'
  | 'browser-selection'
  | 'canvas-selection'
  | 'chat-selection'
  | 'vault-references'
  | 'images';

export type ComposerContextItemKind = 'note' | 'folder' | 'selection' | 'image';

export interface ComposerContextItem {
  id: string;
  kind: ComposerContextItemKind;
  label: string;
  icon?: string;
  title?: string;
  ariaLabel?: string;
  onActivate?: () => void;
  onRemove?: () => void;
}

export interface ComposerContextTrayOptions {
  onDidChange?: () => void;
}

const SLOT_ORDER: readonly ComposerContextSlot[] = [
  'current-note',
  'editor-selection',
  'browser-selection',
  'canvas-selection',
  'chat-selection',
  'vault-references',
  'images',
];

const MAX_COLLAPSED_ROWS = 1;
const ROW_OVERLAP_TOLERANCE = 1;

interface ContextTrayRow {
  top: number;
  bottom: number;
  firstIndex: number;
  lastIndex: number;
}

/**
 * Owns composer context layout while context managers retain their data and behavior.
 */
export class ComposerContextTray {
  private readonly containerEl: HTMLElement;
  private readonly options: ComposerContextTrayOptions;
  private readonly itemsBySlot = new Map<ComposerContextSlot, ComposerContextItem[]>();
  private resizeObserver: ResizeObserver | null = null;
  private pendingLayout: ScheduledAnimationFrame | null = null;
  private expanded = false;

  constructor(containerEl: HTMLElement, options: ComposerContextTrayOptions = {}) {
    this.containerEl = containerEl;
    this.options = options;
    this.containerEl.addClass('codian-context-row');
    this.observeSize();
    this.render();
  }

  setItems(slot: ComposerContextSlot, items: readonly ComposerContextItem[]): void {
    if (items.length === 0) {
      this.itemsBySlot.delete(slot);
    } else {
      this.itemsBySlot.set(slot, [...items]);
    }
    this.expanded = false;
    this.render();
  }

  clearItems(slot: ComposerContextSlot): void {
    if (!this.itemsBySlot.delete(slot)) return;
    this.expanded = false;
    this.render();
  }

  refreshLayout(): void {
    const chips = Array.from(
      this.containerEl.querySelectorAll<HTMLElement>('.codian-context-chip')
    );
    const moreButton = this.containerEl.querySelector<HTMLElement>('.codian-context-more');
    if (!moreButton || chips.length === 0) return;

    for (const chip of chips) {
      chip.removeClass('codian-context-chip--overflow-hidden');
    }
    moreButton.addClass('codian-hidden');

    const rows = this.getRows(chips);
    const hasOverflow = rows.length > MAX_COLLAPSED_ROWS;
    if (!hasOverflow) {
      this.expanded = false;
      this.containerEl.removeClass('codian-context-row--expanded');
      moreButton.setAttribute('aria-expanded', 'false');
      return;
    }

    moreButton.removeClass('codian-hidden');
    if (this.expanded) {
      this.containerEl.addClass('codian-context-row--expanded');
      const label = t('chat.composer.showLess');
      moreButton.textContent = label;
      moreButton.setAttribute('aria-label', label);
      moreButton.setAttribute('aria-expanded', 'true');
      return;
    }

    this.containerEl.removeClass('codian-context-row--expanded');
    moreButton.setAttribute('aria-expanded', 'false');

    const lastVisibleRow = rows[MAX_COLLAPSED_ROWS - 1];
    let visibleCount = lastVisibleRow.lastIndex + 1;

    for (let index = visibleCount; index < chips.length; index++) {
      chips[index].addClass('codian-context-chip--overflow-hidden');
    }

    const minimumVisibleCount = Math.max(1, lastVisibleRow.firstIndex);
    while (visibleCount > minimumVisibleCount && moreButton.offsetTop >= lastVisibleRow.bottom) {
      visibleCount -= 1;
      chips[visibleCount].addClass('codian-context-chip--overflow-hidden');
    }

    const hiddenCount = chips.length - visibleCount;
    moreButton.textContent = t('chat.composer.moreItems', { count: hiddenCount });
    moreButton.setAttribute('aria-label', t('chat.composer.moreContext', { count: hiddenCount }));
  }

  destroy(): void {
    if (this.pendingLayout) {
      cancelScheduledAnimationFrame(this.pendingLayout);
      this.pendingLayout = null;
    }
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.itemsBySlot.clear();
    this.containerEl.empty();
    this.containerEl.removeClass('has-content');
    this.containerEl.removeClass('codian-context-row--expanded');
  }

  private render(): void {
    this.containerEl.empty();
    this.containerEl.removeClass('codian-context-row--expanded');

    const entries = SLOT_ORDER.flatMap(slot =>
      (this.itemsBySlot.get(slot) ?? []).map(item => ({ item, slot }))
    );
    this.containerEl.toggleClass('has-content', entries.length > 0);

    for (const { item, slot } of entries) {
      this.renderItem(slot, item);
    }

    if (entries.length > 0) {
      const moreButton = this.containerEl.createEl('button', {
        cls: 'codian-context-more codian-hidden',
        attr: {
          type: 'button',
          'aria-expanded': 'false',
        },
      });
      moreButton.addEventListener('click', () => {
        this.expanded = !this.expanded;
        this.refreshLayout();
        this.options.onDidChange?.();
      });
    }

    this.options.onDidChange?.();
    this.scheduleLayout();
  }

  private renderItem(slot: ComposerContextSlot, item: ComposerContextItem): void {
    const chipEl = this.containerEl.createDiv({
      cls: `codian-context-chip codian-context-chip--${item.kind}`,
    });
    chipEl.dataset.contextSlot = slot;
    chipEl.dataset.contextId = item.id;

    const contentEl = item.onActivate
      ? chipEl.createEl('button', {
        cls: 'codian-context-chip-main',
        attr: { type: 'button' },
      })
      : chipEl.createSpan({ cls: 'codian-context-chip-main' });

    if (item.title) {
      contentEl.setAttribute('title', item.title);
    }
    contentEl.setAttribute('aria-label', item.ariaLabel ?? item.label);
    if (item.onActivate) {
      contentEl.addEventListener('click', item.onActivate);
    }

    if (item.icon) {
      const iconEl = contentEl.createSpan({ cls: 'codian-context-chip-icon' });
      setIcon(iconEl, item.icon);
    }

    contentEl.createSpan({ cls: 'codian-context-chip-label', text: item.label });

    if (item.onRemove) {
      const removeButton = chipEl.createEl('button', {
        cls: 'codian-context-chip-remove',
        text: '\u00D7',
        attr: {
          type: 'button',
          'aria-label': t('chat.removeItem', { item: item.ariaLabel ?? item.label }),
        },
      });
      removeButton.addEventListener('click', item.onRemove);
    }
  }

  private getRows(chips: readonly HTMLElement[]): ContextTrayRow[] {
    const rows: ContextTrayRow[] = [];
    for (const [index, chip] of chips.entries()) {
      const top = chip.offsetTop;
      const height = chip.offsetHeight > 0 ? chip.offsetHeight : 1;
      const bottom = top + height;
      const row = rows.find(candidate =>
        top < candidate.bottom + ROW_OVERLAP_TOLERANCE
        && bottom > candidate.top - ROW_OVERLAP_TOLERANCE
      );
      if (row) {
        row.top = Math.min(row.top, top);
        row.bottom = Math.max(row.bottom, bottom);
        row.lastIndex = index;
      } else {
        rows.push({ top, bottom, firstIndex: index, lastIndex: index });
      }
    }
    return rows.sort((left, right) => left.top - right.top);
  }

  private scheduleLayout(): void {
    if (this.pendingLayout) {
      cancelScheduledAnimationFrame(this.pendingLayout);
    }
    this.pendingLayout = scheduleAnimationFrame(() => {
      this.pendingLayout = null;
      this.refreshLayout();
    }, this.containerEl.ownerDocument.defaultView);
  }

  private observeSize(): void {
    const ResizeObserverConstructor = this.containerEl.ownerDocument.defaultView?.ResizeObserver;
    if (typeof ResizeObserverConstructor !== 'function') return;

    this.resizeObserver = new ResizeObserverConstructor(() => this.scheduleLayout());
    this.resizeObserver.observe(this.containerEl);
  }
}
