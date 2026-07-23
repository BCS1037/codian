/** @jest-environment jsdom */

import { LivePreviewInputBridge } from '@/features/chat/composer/LivePreviewInputBridge';

describe('LivePreviewInputBridge', () => {
  it('keeps the shared textarea contract synchronized with the visible composer', () => {
    const sourceEl = document.createElement('textarea');
    const hostEl = document.createElement('div');
    sourceEl.value = 'Initial';
    document.body.append(sourceEl, hostEl);
    const inputListener = jest.fn();
    sourceEl.addEventListener('input', inputListener);
    const bridge = new LivePreviewInputBridge(sourceEl, hostEl);

    bridge.composer.value = 'From composer';
    bridge.composer.setSelectionRange(5, 5);

    expect(sourceEl.value).toBe('From composer');
    expect(sourceEl.selectionStart).toBe(5);
    expect(inputListener).toHaveBeenCalled();

    sourceEl.value = 'From controller';
    sourceEl.setSelectionRange(4, 4);
    sourceEl.dispatchEvent(new Event('input', { bubbles: true }));

    expect(bridge.composer.value).toBe('From controller');
    expect(bridge.composer.selectionStart).toBe(4);

    sourceEl.focus();
    expect(document.activeElement).toBe(bridge.composer.contentDOM);

    bridge.destroy();
  });

  it('forwards composer keyboard events through shared textarea listeners', () => {
    const sourceEl = document.createElement('textarea');
    const hostEl = document.createElement('div');
    sourceEl.value = 'Draft';
    document.body.append(sourceEl, hostEl);
    const keydownListener = jest.fn((event: KeyboardEvent) => event.preventDefault());
    sourceEl.addEventListener('keydown', keydownListener);
    const bridge = new LivePreviewInputBridge(sourceEl, hostEl);

    bridge.composer.contentDOM.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Enter',
      bubbles: true,
      cancelable: true,
    }));

    expect(keydownListener).toHaveBeenCalled();
    expect(bridge.composer.value).toBe('Draft');
    bridge.destroy();
  });

  it('preserves IME composition state when forwarding keyboard events', () => {
    const sourceEl = document.createElement('textarea');
    const hostEl = document.createElement('div');
    document.body.append(sourceEl, hostEl);
    const compositionStates: boolean[] = [];
    sourceEl.addEventListener('keydown', event => compositionStates.push(event.isComposing));
    const bridge = new LivePreviewInputBridge(sourceEl, hostEl);

    bridge.composer.contentDOM.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Enter',
      isComposing: true,
      bubbles: true,
      cancelable: true,
    }));

    expect(compositionStates).toEqual([true]);
    bridge.destroy();
  });

  it('inserts a newline when shared chat handling leaves Enter unhandled', () => {
    const sourceEl = document.createElement('textarea');
    const hostEl = document.createElement('div');
    sourceEl.value = 'Draft';
    document.body.append(sourceEl, hostEl);
    const bridge = new LivePreviewInputBridge(sourceEl, hostEl);
    bridge.composer.setSelectionRange(5, 5);

    bridge.composer.contentDOM.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Enter',
      bubbles: true,
      cancelable: true,
    }));

    expect(bridge.composer.value).toBe('Draft\n');
    bridge.destroy();
  });
});
