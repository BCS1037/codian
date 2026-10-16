import { t } from '@/i18n/i18n';

const WIDE_SESSION_LAYOUT_MIN_WIDTH = 600;
const MIN_CHAT_PANEL_WIDTH = 320;
const MIN_SESSION_SIDEBAR_WIDTH = 180;
const SESSION_RESIZER_WIDTH = 5;
const SESSION_RESIZE_KEYBOARD_STEP = 16;

export interface DualPaneLayoutElements {
  containerEl: HTMLElement;
  resizerEl: HTMLElement;
  sidebarEl: HTMLElement;
}

export interface DualPaneLayoutHooks {
  onWideChanged(wide: boolean): void;
}

/** Owns responsive chat layout and accessible resizing for one view. */
export class DualPaneLayout {
  private elements: DualPaneLayoutElements | null = null;
  private wide = false;
  private resizeObserver: ResizeObserver | null = null;
  private resizeCleanup: (() => void) | null = null;
  private sidebarWidth: number | null = null;

  constructor(private readonly hooks: DualPaneLayoutHooks) {}

  get isWide(): boolean {
    return this.wide;
  }

  initialize(elements: DualPaneLayoutElements): void {
    this.elements = elements;
    const { containerEl, resizerEl } = elements;
    resizerEl.setAttribute('role', 'separator');
    resizerEl.setAttribute('aria-label', t('chat.resizeConversations'));
    resizerEl.setAttribute('aria-orientation', 'vertical');
    resizerEl.setAttribute('tabindex', '0');
    resizerEl.addEventListener('pointerdown', this.handlePointerDown);
    resizerEl.addEventListener('keydown', this.handleKeydown);
    this.update(containerEl.getBoundingClientRect().width);
  }

  startObserving(): void {
    const containerEl = this.elements?.containerEl;
    if (!containerEl) return;
    const ResizeObserverConstructor = containerEl.ownerDocument.defaultView?.ResizeObserver;
    if (typeof ResizeObserverConstructor === 'function') {
      this.resizeObserver = new ResizeObserverConstructor((entries) => {
        const entry = entries.at(-1);
        this.update(entry?.contentRect.width ?? containerEl.getBoundingClientRect().width);
      });
      this.resizeObserver.observe(containerEl);
    }
    this.update(containerEl.getBoundingClientRect().width);
  }

  refresh(): void {
    const containerEl = this.elements?.containerEl;
    if (containerEl) this.update(containerEl.getBoundingClientRect().width);
  }

  dispose(): void {
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.stopResize();
    const resizerEl = this.elements?.resizerEl;
    resizerEl?.removeEventListener('pointerdown', this.handlePointerDown);
    resizerEl?.removeEventListener('keydown', this.handleKeydown);
    this.elements = null;
  }

  private update(width: number): void {
    const containerEl = this.elements?.containerEl;
    if (!containerEl || width <= 0) return;
    const nextWide = width >= WIDE_SESSION_LAYOUT_MIN_WIDTH;
    if (nextWide === this.wide) {
      if (nextWide && this.sidebarWidth !== null) this.setSidebarWidth(this.sidebarWidth);
      return;
    }
    this.wide = nextWide;
    containerEl.classList.toggle('codian-wide-session-layout', nextWide);
    if (nextWide) this.setSidebarWidth(this.sidebarWidth ?? 220);
    this.hooks.onWideChanged(nextWide);
  }

  private readonly handlePointerDown = (event: PointerEvent): void => {
    const elements = this.elements;
    if (!this.wide || event.button !== 0 || !elements) return;
    event.preventDefault();
    this.stopResize();
    const ownerDocument = (event.currentTarget as HTMLElement).ownerDocument;
    const startX = event.clientX;
    const startWidth = this.sidebarWidth ?? elements.sidebarEl.getBoundingClientRect().width;
    const handlePointerMove = (moveEvent: PointerEvent): void => {
      this.setSidebarWidth(startWidth + moveEvent.clientX - startX);
    };
    const handlePointerEnd = (): void => this.stopResize();
    ownerDocument.addEventListener('pointermove', handlePointerMove);
    ownerDocument.addEventListener('pointerup', handlePointerEnd);
    ownerDocument.addEventListener('pointercancel', handlePointerEnd);
    elements.containerEl.classList.add('codian-resizing-session-sidebar');
    this.resizeCleanup = () => {
      ownerDocument.removeEventListener('pointermove', handlePointerMove);
      ownerDocument.removeEventListener('pointerup', handlePointerEnd);
      ownerDocument.removeEventListener('pointercancel', handlePointerEnd);
      elements.containerEl.classList.remove('codian-resizing-session-sidebar');
    };
  };

  private readonly handleKeydown = (event: KeyboardEvent): void => {
    const elements = this.elements;
    if (!this.wide || !elements || (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight')) return;
    event.preventDefault();
    const currentWidth = this.sidebarWidth ?? elements.sidebarEl.getBoundingClientRect().width;
    this.setSidebarWidth(currentWidth + (event.key === 'ArrowRight'
      ? SESSION_RESIZE_KEYBOARD_STEP
      : -SESSION_RESIZE_KEYBOARD_STEP));
  };

  private setSidebarWidth(requestedWidth: number): void {
    const elements = this.elements;
    if (!elements) return;
    const totalWidth = elements.containerEl.getBoundingClientRect().width;
    const maxWidth = Math.max(
      MIN_SESSION_SIDEBAR_WIDTH,
      totalWidth - MIN_CHAT_PANEL_WIDTH - SESSION_RESIZER_WIDTH,
    );
    const width = Math.round(Math.min(Math.max(requestedWidth, MIN_SESSION_SIDEBAR_WIDTH), maxWidth));
    this.sidebarWidth = width;
    elements.containerEl.style.setProperty('--codian-session-sidebar-width', `${width}px`);
    elements.resizerEl.setAttribute('aria-valuenow', String(width));
    elements.resizerEl.setAttribute('aria-valuemin', String(MIN_SESSION_SIDEBAR_WIDTH));
    elements.resizerEl.setAttribute('aria-valuemax', String(Math.round(maxWidth)));
  }

  private stopResize(): void {
    const cleanup = this.resizeCleanup;
    this.resizeCleanup = null;
    cleanup?.();
  }
}
