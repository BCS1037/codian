import { createMockEl } from '@test/helpers/mockElement';

import { DualPaneLayout } from '@/features/chat/DualPaneLayout';

type ResizeCallback = (entries: Array<{ contentRect: { width: number } }>) => void;

class MockResizeObserver {
  static latest: MockResizeObserver | null = null;
  readonly observe = jest.fn();
  readonly disconnect = jest.fn();

  constructor(private readonly callback: ResizeCallback) {
    MockResizeObserver.latest = this;
  }

  emit(width: number): void {
    this.callback([{ contentRect: { width } }]);
  }
}

function setWidth(el: HTMLElement, width: number): void {
  el.getBoundingClientRect = jest.fn().mockReturnValue({ width }) as typeof el.getBoundingClientRect;
}

describe('DualPaneLayout', () => {
  beforeEach(() => {
    MockResizeObserver.latest = null;
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('shows wide layout at 600px, returns to tabs below it, and ignores hidden zero-width measurements', () => {
    const containerEl = createMockEl() as unknown as HTMLElement;
    const sidebarEl = createMockEl() as unknown as HTMLElement;
    const resizerEl = createMockEl() as unknown as HTMLElement;
    (containerEl.ownerDocument.defaultView as any).ResizeObserver = MockResizeObserver;
    (containerEl.style as any).setProperty = jest.fn();
    const onWideChanged = jest.fn();
    setWidth(containerEl, 720);
    const layout = new DualPaneLayout({ onWideChanged });

    layout.initialize({ containerEl, sidebarEl, resizerEl });
    expect(layout.isWide).toBe(true);
    expect(containerEl.classList.contains('codian-wide-session-layout')).toBe(true);

    layout.startObserving();
    MockResizeObserver.latest?.emit(560);
    expect(layout.isWide).toBe(false);
    expect(containerEl.classList.contains('codian-wide-session-layout')).toBe(false);

    MockResizeObserver.latest?.emit(0);
    expect(layout.isWide).toBe(false);

    MockResizeObserver.latest?.emit(600);
    expect(layout.isWide).toBe(true);
    expect(onWideChanged.mock.calls.map(([wide]) => wide)).toEqual([true, false, true]);

    layout.dispose();
    expect(MockResizeObserver.latest?.disconnect).toHaveBeenCalledTimes(1);
  });

  it('resizes the session list with keyboard and clamps it to preserve minimum chat width', () => {
    const containerEl = createMockEl() as unknown as HTMLElement;
    const sidebarEl = createMockEl() as unknown as HTMLElement;
    const resizerEl = createMockEl() as unknown as HTMLElement;
    setWidth(containerEl, 700);
    setWidth(sidebarEl, 220);
    (containerEl.style as any).setProperty = jest.fn();
    const layout = new DualPaneLayout({ onWideChanged: jest.fn() });
    layout.initialize({ containerEl, sidebarEl, resizerEl });

    const preventDefault = jest.fn();
    resizerEl.dispatchEvent({ type: 'keydown', key: 'ArrowRight', preventDefault } as unknown as Event);
    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(containerEl.style.setProperty).toHaveBeenLastCalledWith('--codian-session-sidebar-width', '236px');
    expect(resizerEl.getAttribute('aria-valuenow')).toBe('236');

    setWidth(containerEl, 500);
    resizerEl.dispatchEvent({ type: 'keydown', key: 'ArrowRight', preventDefault: jest.fn() } as unknown as Event);
    expect(containerEl.style.setProperty).toHaveBeenLastCalledWith('--codian-session-sidebar-width', '180px');

    layout.dispose();
  });
});
