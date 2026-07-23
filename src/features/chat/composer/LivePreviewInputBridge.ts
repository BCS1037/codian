import { LivePreviewComposer } from './LivePreviewComposer';
import type { VaultContextReference } from './types';

export interface LivePreviewInputBridgeOptions {
  references?: readonly VaultContextReference[];
  onOpenReference?: (reference: VaultContextReference) => void;
}

export class LivePreviewInputBridge {
  readonly composer: LivePreviewComposer;

  private syncing = false;
  private readonly originalFocus: HTMLTextAreaElement['focus'];

  private readonly handleComposerPaste = (event: ClipboardEvent): void => {
    const EventConstructor = this.sourceEl.ownerDocument.defaultView?.Event ?? Event;
    const forwardedEvent = new EventConstructor('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(forwardedEvent, 'clipboardData', { value: event.clipboardData });
    this.sourceEl.dispatchEvent(forwardedEvent);
    if (forwardedEvent.defaultPrevented) event.preventDefault();
  };

  private readonly handleSourceInput = (): void => {
    if (this.syncing) return;
    this.syncFromSource();
  };

  constructor(
    private readonly sourceEl: HTMLTextAreaElement,
    private readonly hostEl: HTMLElement,
    private readonly options: LivePreviewInputBridgeOptions = {},
  ) {
    this.originalFocus = sourceEl.focus;
    this.composer = new LivePreviewComposer(hostEl, {
      initialValue: sourceEl.value,
      placeholder: sourceEl.placeholder,
      references: options.references,
      onChange: value => this.syncToSource(value),
      onSelectionChange: (start, end) => this.syncSelectionToSource(start, end),
      onKeydown: event => this.handleComposerKeydown(event),
      onOpenReference: options.onOpenReference,
    });
    sourceEl.classList.add('claudian-live-preview-source');
    hostEl.classList.add('claudian-live-preview-host');
    sourceEl.addEventListener('input', this.handleSourceInput);
    this.composer.contentDOM.addEventListener('paste', this.handleComposerPaste);
    sourceEl.focus = () => {
      this.syncFromSource();
      this.composer.focus();
    };
  }

  setReferences(references: readonly VaultContextReference[]): void {
    this.composer.setReferences(references);
  }

  destroy(): void {
    this.sourceEl.removeEventListener('input', this.handleSourceInput);
    this.composer.contentDOM.removeEventListener('paste', this.handleComposerPaste);
    this.sourceEl.focus = this.originalFocus;
    this.sourceEl.classList.remove('claudian-live-preview-source');
    this.hostEl.classList.remove('claudian-live-preview-host');
    this.composer.destroy();
  }

  private handleComposerKeydown(event: KeyboardEvent): boolean {
    this.syncSelectionToSource(this.composer.selectionStart, this.composer.selectionEnd);
    const KeyboardEventConstructor = this.sourceEl.ownerDocument.defaultView?.KeyboardEvent ?? KeyboardEvent;
    const forwardedEvent = new KeyboardEventConstructor('keydown', {
      key: event.key,
      code: event.code,
      altKey: event.altKey,
      ctrlKey: event.ctrlKey,
      metaKey: event.metaKey,
      shiftKey: event.shiftKey,
      repeat: event.repeat,
      isComposing: event.isComposing,
      bubbles: true,
      cancelable: true,
    });
    this.sourceEl.dispatchEvent(forwardedEvent);
    if (forwardedEvent.defaultPrevented) event.preventDefault();
    this.syncFromSource();
    return forwardedEvent.defaultPrevented;
  }

  private syncToSource(value: string): void {
    if (this.syncing) return;
    this.syncing = true;
    this.sourceEl.value = value;
    this.syncSelectionToSource(this.composer.selectionStart, this.composer.selectionEnd);
    const EventConstructor = this.sourceEl.ownerDocument.defaultView?.Event ?? Event;
    this.sourceEl.dispatchEvent(new EventConstructor('input', { bubbles: true }));
    this.syncing = false;
  }

  private syncSelectionToSource(start: number, end: number): void {
    this.sourceEl.setSelectionRange(start, end);
  }

  syncFromSource(): void {
    if (this.composer.value !== this.sourceEl.value) {
      this.syncing = true;
      this.composer.value = this.sourceEl.value;
      this.syncing = false;
    }
    this.composer.setSelectionRange(this.sourceEl.selectionStart, this.sourceEl.selectionEnd);
    this.composer.setPlaceholder(this.sourceEl.placeholder);
  }
}
