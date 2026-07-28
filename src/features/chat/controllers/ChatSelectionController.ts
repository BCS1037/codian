import { setIcon } from 'obsidian';

import type { ChatSelectionContext } from '../../../core/runtime/types';
import { t } from '../../../i18n/i18n';
import type { ComposerContextTray } from '../ui/ComposerContextTray';

const MAX_SELECTIONS = 5;
const MAX_CHARACTERS = 20_000;

export class ChatSelectionController {
  private readonly selections: ChatSelectionContext[] = [];
  private toolbarEl: HTMLElement | null = null;
  private selectedText = '';

  constructor(
    private readonly messagesEl: HTMLElement,
    private readonly contextTray: ComposerContextTray,
    private readonly onDidChange: () => void,
    private readonly isStreaming: () => boolean,
  ) {
    this.messagesEl.ownerDocument.addEventListener('selectionchange', this.handleSelectionChange);
    this.messagesEl.addEventListener('scroll', this.hideToolbar, true);
  }

  getSelections(): readonly ChatSelectionContext[] { return this.selections; }

  clear(): void {
    this.selections.splice(0);
    this.contextTray.clearItems('chat-selection');
    this.onDidChange();
  }

  destroy(): void {
    this.messagesEl.ownerDocument.removeEventListener('selectionchange', this.handleSelectionChange);
    this.messagesEl.removeEventListener('scroll', this.hideToolbar, true);
    this.hideToolbar();
    this.clear();
  }

  private readonly handleSelectionChange = (): void => {
    const selection = this.messagesEl.ownerDocument.getSelection();
    const text = selection?.toString() ?? '';
    const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
    const startElement = range?.startContainer instanceof HTMLElement
      ? range.startContainer
      : range?.startContainer.parentElement;
    const endElement = range?.endContainer instanceof HTMLElement
      ? range.endContainer
      : range?.endContainer.parentElement;
    const startMessage = startElement?.closest<HTMLElement>('.claudian-message-assistant');
    const endMessage = endElement?.closest<HTMLElement>('.claudian-message-assistant');
    const startTextBlock = startElement?.closest<HTMLElement>('.claudian-text-block');
    const endTextBlock = endElement?.closest<HTMLElement>('.claudian-text-block');
    if (!text.trim() || this.isStreaming() || !startMessage || startMessage !== endMessage
      || !startTextBlock || !endTextBlock || !this.messagesEl.contains(startMessage)) {
      this.hideToolbar();
      return;
    }
    this.selectedText = text;
    this.showToolbar(range!);
  };

  private showToolbar(range: Range): void {
    this.hideToolbar();
    const rect = range.getBoundingClientRect();
    if (!rect.width && !rect.height) return;
    const toolbar = this.messagesEl.ownerDocument.createElement('div');
    toolbar.className = 'claudian-selection-toolbar';
    toolbar.setAttribute('role', 'toolbar');
    toolbar.style.left = `${Math.max(8, rect.left + rect.width / 2)}px`;
    toolbar.style.top = `${Math.max(8, rect.top - 8)}px`;
    const add = this.createButton(toolbar, 'plus', t('chat.selectionToolbar.add'), () => this.addSelection());
    if (!this.canAdd(this.selectedText)) {
      add.disabled = true;
      add.title = t('chat.selectionToolbar.limit');
    }
    this.createButton(toolbar, 'copy', t('chat.selectionToolbar.copy'), () => void this.copySelection());
    this.messagesEl.ownerDocument.body.appendChild(toolbar);
    this.toolbarEl = toolbar;
  }

  private createButton(parent: HTMLElement, icon: string, label: string, action: () => void): HTMLButtonElement {
    const button = parent.createEl('button', { attr: { type: 'button', 'aria-label': label, title: label } });
    setIcon(button, icon);
    button.addEventListener('mousedown', event => event.preventDefault());
    button.addEventListener('click', action);
    return button;
  }

  private canAdd(text: string): boolean {
    return this.selections.length < MAX_SELECTIONS
      && this.selections.reduce((sum, item) => sum + item.text.length, 0) + text.length <= MAX_CHARACTERS;
  }

  private addSelection(): void {
    if (!this.canAdd(this.selectedText)) return;
    this.selections.push({ id: `chat-selection-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, text: this.selectedText });
    this.renderChips();
    this.messagesEl.ownerDocument.getSelection()?.removeAllRanges();
    this.hideToolbar();
  }

  private async copySelection(): Promise<void> {
    try { await navigator.clipboard.writeText(this.selectedText); } catch { return; }
  }

  private renderChips(): void {
    this.contextTray.setItems('chat-selection', this.selections.map(selection => ({
      id: selection.id,
      kind: 'selection',
      label: selection.text.trim().replace(/\s+/g, ' ').slice(0, 5),
      icon: 'file-text',
      title: selection.text,
      ariaLabel: t('chat.selectionToolbar.selectedReply'),
      onRemove: () => {
        const index = this.selections.findIndex(item => item.id === selection.id);
        if (index >= 0) this.selections.splice(index, 1);
        this.renderChips();
      },
    })));
    this.onDidChange();
  }

  private readonly hideToolbar = (): void => {
    this.toolbarEl?.remove();
    this.toolbarEl = null;
  };
}
