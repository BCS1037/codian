import type { App } from 'obsidian';
import { setIcon, TFile, TFolder } from 'obsidian';

import { t } from '../../../i18n/i18n';
import type { VaultContextReference } from './types';

export type { VaultContextReference } from './types';

export interface VaultContextDropCallbacks {
  onReferencesDropped: (references: readonly VaultContextReference[]) => void;
  onInvalidDrop?: () => void;
}

interface DragManagerHost {
  dragManager?: unknown;
}

export class VaultContextDropController {
  private readonly dropOverlayEl: HTMLElement;

  private readonly handleDragEnter = (event: DragEvent): void => {
    if (this.getDraggedItems().length === 0) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    this.dropOverlayEl.toggleClass('visible', this.getDraggedReferences().length > 0);
  };

  private readonly handleDragOver = (event: DragEvent): void => {
    if (this.getDraggedItems().length === 0) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  };

  private readonly handleDragLeave = (event: DragEvent): void => {
    const rect = this.dropZoneEl.getBoundingClientRect();
    if (
      event.clientX <= rect.left
      || event.clientX >= rect.right
      || event.clientY <= rect.top
      || event.clientY >= rect.bottom
    ) {
      this.dropOverlayEl.removeClass('visible');
    }
  };

  private readonly handleDrop = (event: DragEvent): void => {
    const draggedItems = this.getDraggedItems();
    if (draggedItems.length === 0) return;

    const references = this.getDraggedReferences();
    event.preventDefault();
    event.stopImmediatePropagation();
    this.dropOverlayEl.removeClass('visible');

    if (references.length === 0) {
      this.callbacks.onInvalidDrop?.();
      return;
    }

    const newReferences = references.filter(reference => !this.inputContainsReference(reference));
    if (newReferences.length > 0) {
      this.insertReferences(newReferences);
    }
    this.callbacks.onReferencesDropped(references);
  };

  constructor(
    private readonly app: App,
    private readonly dropZoneEl: HTMLElement,
    private readonly inputEl: HTMLTextAreaElement,
    private readonly callbacks: VaultContextDropCallbacks,
  ) {
    this.dropOverlayEl = this.createDropOverlay();
    this.dropZoneEl.addEventListener('dragenter', this.handleDragEnter);
    this.dropZoneEl.addEventListener('dragover', this.handleDragOver);
    this.dropZoneEl.addEventListener('dragleave', this.handleDragLeave);
    this.dropZoneEl.addEventListener('drop', this.handleDrop, true);
  }

  destroy(): void {
    this.dropZoneEl.removeEventListener('dragenter', this.handleDragEnter);
    this.dropZoneEl.removeEventListener('dragover', this.handleDragOver);
    this.dropZoneEl.removeEventListener('dragleave', this.handleDragLeave);
    this.dropZoneEl.removeEventListener('drop', this.handleDrop, true);
    this.dropOverlayEl.remove();
  }

  private getDraggedItems(): unknown[] {
    const host = this.app as unknown as DragManagerHost;
    if (!this.isRecord(host.dragManager)) return [];

    const draggable = host.dragManager.draggable;
    if (!this.isRecord(draggable)) return [];

    return draggable.type === 'files' && Array.isArray(draggable.files)
      ? draggable.files
      : draggable.file ? [draggable.file] : [];
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
  }

  private getDraggedReferences(): VaultContextReference[] {
    const references: VaultContextReference[] = [];
    const seenPaths = new Set<string>();
    for (const item of this.getDraggedItems()) {
      const reference = item instanceof TFolder && item.path !== '/' && item.path !== ''
        ? { path: item.path, kind: 'folder' as const }
        : item instanceof TFile && item.extension.toLowerCase() === 'md'
          ? { path: item.path, kind: 'file' as const }
          : null;
      if (!reference || seenPaths.has(reference.path)) continue;
      seenPaths.add(reference.path);
      references.push(reference);
    }
    return references;
  }

  private inputContainsReference(reference: VaultContextReference): boolean {
    const token = `@${reference.path}${reference.kind === 'folder' ? '/' : ''}`;
    const escapedToken = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(^|\\s)${escapedToken}(?=\\s|$)`).test(this.inputEl.value);
  }

  private createDropOverlay(): HTMLElement {
    const overlayEl = this.dropZoneEl.createDiv({ cls: 'claudian-drop-overlay' });
    const contentEl = overlayEl.createDiv({ cls: 'claudian-drop-content' });
    const iconEl = contentEl.createSpan({ cls: 'claudian-drop-icon' });
    setIcon(iconEl, 'paperclip');
    contentEl.createSpan({ text: t('chat.drop.context') });
    return overlayEl;
  }

  private insertReferences(references: readonly VaultContextReference[]): void {
    const caret = this.inputEl.selectionStart ?? this.inputEl.value.length;
    const before = this.inputEl.value.slice(0, caret);
    const after = this.inputEl.value.slice(caret);
    const referencesText = references
      .map(reference => `@${reference.path}${reference.kind === 'folder' ? '/' : ''}`)
      .join(' ');
    const prefix = before.length > 0 && !/\s$/.test(before) ? ' ' : '';
    const suffix = after.length === 0 || !/^\s/.test(after) ? ' ' : '';
    const insertion = `${prefix}${referencesText}${suffix}`;

    this.inputEl.value = `${before}${insertion}${after}`;
    const nextCaret = before.length + insertion.length;
    this.inputEl.setSelectionRange(nextCaret, nextCaret);
    this.inputEl.focus();
    this.dispatchInputEvent();
  }

  private dispatchInputEvent(): void {
    const EventConstructor = this.inputEl.ownerDocument?.defaultView?.Event ?? Event;
    this.inputEl.dispatchEvent(new EventConstructor('input', { bubbles: true }));
  }
}
