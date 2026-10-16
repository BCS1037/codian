/** @jest-environment jsdom */

import { createMockEl } from '@test/helpers/mockElement';

import { LivePreviewInputBridge } from '@/features/chat/composer/LivePreviewInputBridge';
import { getAccessibleTextbox } from '@/shared/components/AccessibleTextbox';
import { SelectableDropdown } from '@/shared/components/SelectableDropdown';

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
    expect(getAccessibleTextbox(sourceEl)).toBe(bridge.composer.contentDOM);

    bridge.destroy();
    expect(getAccessibleTextbox(sourceEl)).toBe(sourceEl);
  });

  it('places popup relationships on the visible CodeMirror textbox instead of the hidden source', () => {
    const sourceEl = document.createElement('textarea');
    const hostEl = document.createElement('div');
    document.body.append(sourceEl, hostEl);
    const bridge = new LivePreviewInputBridge(sourceEl, hostEl);
    const dropdown = new SelectableDropdown<string>(createMockEl(), {
      listClassName: 'suggestions',
      itemClassName: 'suggestion',
      emptyClassName: 'empty',
      ariaLabel: 'Input suggestions',
      inputEl: sourceEl,
    });

    dropdown.render({
      items: ['first'],
      selectedIndex: 0,
      emptyText: 'No matches',
      renderItem: (item, itemEl) => itemEl.setText(item),
    });

    const listbox = dropdown.getElement()!;
    const option = listbox.querySelector('.suggestion')!;
    expect(bridge.composer.contentDOM.getAttribute('aria-controls'))
      .toBe(listbox.getAttribute('id'));
    expect(bridge.composer.contentDOM.getAttribute('aria-activedescendant'))
      .toBe(option.getAttribute('id'));
    expect(sourceEl.hasAttribute('aria-controls')).toBe(false);

    dropdown.destroy();
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
