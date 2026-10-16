/** @jest-environment jsdom */

import type { ChatMessage } from '@/core/types';
import { PromptHistoryNavigation } from '@/features/chat/composer/PromptHistoryNavigation';

describe('PromptHistoryNavigation', () => {
  let textarea: HTMLTextAreaElement;
  let messages: ChatMessage[];
  let enabled: boolean;
  let nav: PromptHistoryNavigation;

  beforeEach(() => {
    textarea = document.createElement('textarea');
    document.body.appendChild(textarea);
    enabled = true;
    messages = [
      { id: 'msg-1', role: 'user', content: 'First prompt', timestamp: 1000 },
      { id: 'msg-2', role: 'assistant', content: 'Assistant reply 1', timestamp: 1001 },
      { id: 'msg-3', role: 'user', content: 'Second prompt', timestamp: 1002 },
      { id: 'msg-4', role: 'assistant', content: 'Assistant reply 2', timestamp: 1003 },
      { id: 'msg-5', role: 'user', content: 'Third prompt\nwith multiple lines', timestamp: 1004 },
      { id: 'msg-6', role: 'assistant', content: 'Assistant reply 3', timestamp: 1005 },
    ];

    nav = new PromptHistoryNavigation({
      getMessages: () => messages,
      input: textarea,
      isEnabled: () => enabled,
    });
  });

  afterEach(() => {
    nav.destroy();
    textarea.remove();
    document.body.innerHTML = '';
  });

  function pressKey(key: string, options: Partial<KeyboardEventInit> = {}): boolean {
    const event = new KeyboardEvent('keydown', {
      key,
      bubbles: true,
      cancelable: true,
      ...options,
    });
    const handled = nav.handleKeydown(event);
    return handled;
  }

  it('recalls the latest user prompt on ArrowUp when input is empty', () => {
    textarea.value = '';
    const handled = pressKey('ArrowUp');

    expect(handled).toBe(true);
    expect(textarea.value).toBe('Third prompt\nwith multiple lines');
    expect(nav.isRecalling).toBe(true);
  });

  it('steps backwards with successive ArrowUp and forward with ArrowDown', () => {
    textarea.value = '';
    pressKey('ArrowUp');
    expect(textarea.value).toBe('Third prompt\nwith multiple lines');

    // Caret starts at end of text. For multiline text, ArrowUp from line 2 should move within text
    // Simulate caret at top line (line 1)
    textarea.selectionStart = 0;
    textarea.selectionEnd = 0;

    pressKey('ArrowUp');
    expect(textarea.value).toBe('Second prompt');

    pressKey('ArrowUp');
    expect(textarea.value).toBe('First prompt');

    // Reached the earliest prompt - ArrowUp returns false
    expect(pressKey('ArrowUp')).toBe(false);
    expect(textarea.value).toBe('First prompt');

    // Step forward
    pressKey('ArrowDown');
    expect(textarea.value).toBe('Second prompt');

    pressKey('ArrowDown');
    expect(textarea.value).toBe('Third prompt\nwith multiple lines');

    // ArrowDown past latest prompt clears input
    // Place caret on bottom line
    textarea.selectionStart = textarea.value.length;
    textarea.selectionEnd = textarea.value.length;

    pressKey('ArrowDown');
    expect(textarea.value).toBe('');
    expect(nav.isRecalling).toBe(false);
  });

  it('clears recalled input when Escape is pressed', () => {
    textarea.value = '';
    pressKey('ArrowUp');
    expect(textarea.value).toBe('Third prompt\nwith multiple lines');
    expect(nav.isRecalling).toBe(true);

    const handled = pressKey('Escape');
    expect(handled).toBe(true);
    expect(textarea.value).toBe('');
    expect(nav.isRecalling).toBe(false);
  });

  it('does not trigger recall if input already has non-recalled text', () => {
    textarea.value = 'User is currently typing';
    const handled = pressKey('ArrowUp');

    expect(handled).toBe(false);
    expect(textarea.value).toBe('User is currently typing');
    expect(nav.isRecalling).toBe(false);
  });

  it('filters out interrupts and rebuilt context messages', () => {
    messages = [
      { id: 'u1', role: 'user', content: 'Valid prompt 1', timestamp: 1000 },
      { id: 'u2', role: 'user', content: 'Interrupt prompt', isInterrupt: true, timestamp: 1001 },
      { id: 'u3', role: 'user', content: 'Rebuilt prompt', isRebuiltContext: true, timestamp: 1002 },
    ];

    textarea.value = '';
    pressKey('ArrowUp');
    expect(textarea.value).toBe('Valid prompt 1');
  });

  it('extracts display text without injected context XML tags', () => {
    messages = [
      {
        id: 'u1',
        role: 'user',
        content: 'Original question\n\n<context_files>\n<file path="test.md">content</file>\n</context_files>',
        timestamp: 1000,
      },
    ];

    textarea.value = '';
    pressKey('ArrowUp');
    expect(textarea.value).toBe('Original question');
  });

  it('respects IME composition and ignores ArrowUp during composition', () => {
    textarea.value = '';
    textarea.dispatchEvent(new Event('compositionstart'));

    expect(pressKey('ArrowUp')).toBe(false);
    expect(textarea.value).toBe('');

    textarea.dispatchEvent(new Event('compositionend'));
    expect(pressKey('ArrowUp')).toBe(true);
    expect(textarea.value).toBe('Third prompt\nwith multiple lines');
  });

  it('respects isEnabled option', () => {
    enabled = false;
    textarea.value = '';

    expect(pressKey('ArrowUp')).toBe(false);
    expect(textarea.value).toBe('');
  });

  it('supports custom isCaretOnEdgeRow function', () => {
    const isCaretOnEdgeRow = jest.fn();
    (textarea as any).isCaretOnEdgeRow = isCaretOnEdgeRow;

    textarea.value = '';
    pressKey('ArrowUp');
    expect(textarea.value).toBe('Third prompt\nwith multiple lines');

    // When isCaretOnEdgeRow returns false, ArrowUp does not switch prompt
    isCaretOnEdgeRow.mockReturnValue(false);
    expect(pressKey('ArrowUp')).toBe(false);
    expect(textarea.value).toBe('Third prompt\nwith multiple lines');

    // When isCaretOnEdgeRow returns true, ArrowUp switches prompt
    isCaretOnEdgeRow.mockReturnValue(true);
    expect(pressKey('ArrowUp')).toBe(true);
    expect(textarea.value).toBe('Second prompt');
  });
});
