/** @jest-environment jsdom */

import { LivePreviewComposer } from '@/features/chat/composer/LivePreviewComposer';

describe('LivePreviewComposer', () => {
  it('sends the Markdown draft on Enter and continues an unordered list on Shift+Enter', () => {
    const parentEl = document.createElement('div');
    document.body.appendChild(parentEl);
    const onSend = jest.fn();
    const composer = new LivePreviewComposer(parentEl, {
      initialValue: '- first',
      onSend,
    });

    composer.setSelectionRange(7, 7);
    composer.contentDOM.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Enter',
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    }));

    expect(composer.value).toBe('- first\n- ');
    expect(onSend).not.toHaveBeenCalled();

    composer.contentDOM.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Enter',
      bubbles: true,
      cancelable: true,
    }));

    expect(onSend).toHaveBeenCalledWith('- first\n- ');

    composer.destroy();
  });

  it('increments ordered lists and exits empty list items on Shift+Enter', () => {
    const parentEl = document.createElement('div');
    document.body.appendChild(parentEl);
    const composer = new LivePreviewComposer(parentEl, {
      initialValue: '8. eighth',
    });

    composer.setSelectionRange(9, 9);
    composer.contentDOM.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Enter',
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    }));

    expect(composer.value).toBe('8. eighth\n9. ');

    composer.contentDOM.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Enter',
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    }));

    expect(composer.value).toBe('8. eighth\n');
    composer.destroy();
  });

  it('renders inline code and vault references while preserving full Markdown', () => {
    const parentEl = document.createElement('div');
    document.body.appendChild(parentEl);
    const composer = new LivePreviewComposer(parentEl, {
      initialValue: 'Use `InputController` and @notes/projects/alpha.md\nContinue',
      references: [{ path: 'notes/projects/alpha.md', kind: 'file' }],
    });

    composer.setSelectionRange(composer.value.length, composer.value.length);

    const inlineCode = parentEl.querySelector('.claudian-live-preview-inline-code');
    const reference = parentEl.querySelector<HTMLElement>('.claudian-live-preview-reference');
    expect(inlineCode?.textContent).toBe('InputController');
    expect(reference?.textContent).toContain('alpha.md');
    expect(reference?.dataset.path).toBe('notes/projects/alpha.md');
    expect(reference?.title).toBe('@notes/projects/alpha.md');
    expect(composer.value).toBe('Use `InputController` and @notes/projects/alpha.md\nContinue');

    composer.destroy();
  });

  it('renders inline code as soon as the cursor leaves its token on the same line', () => {
    const parentEl = document.createElement('div');
    document.body.appendChild(parentEl);
    const value = 'Use `InputController` here';
    const composer = new LivePreviewComposer(parentEl, { initialValue: value });

    composer.setSelectionRange('Use `Input'.length, 'Use `Input'.length);

    expect(parentEl.querySelector('.claudian-live-preview-inline-code')).toBeNull();
    expect(composer.contentDOM.textContent).toContain('`InputController`');

    const tokenEnd = 'Use `InputController`'.length;
    composer.setSelectionRange(tokenEnd, tokenEnd);

    expect(parentEl.querySelector('.claudian-live-preview-inline-code')?.textContent)
      .toBe('InputController');
    expect(composer.value).toBe(value);

    composer.destroy();
  });

  it('renders a link as soon as the cursor leaves its token on the same line', () => {
    const parentEl = document.createElement('div');
    document.body.appendChild(parentEl);
    const token = '[Docs](https://example.com)';
    const value = `${token} next`;
    const composer = new LivePreviewComposer(parentEl, { initialValue: value });

    composer.setSelectionRange('[Docs]'.length, '[Docs]'.length);

    expect(parentEl.querySelector('.claudian-live-preview-link')).toBeNull();
    expect(composer.contentDOM.textContent).toContain(token);

    composer.setSelectionRange(token.length, token.length);

    expect(parentEl.querySelector('.claudian-live-preview-link')?.textContent).toBe('Docs');
    expect(composer.value).toBe(value);

    composer.destroy();
  });

  it('renders a list marker when the cursor moves from the marker into item text', () => {
    const parentEl = document.createElement('div');
    document.body.appendChild(parentEl);
    const composer = new LivePreviewComposer(parentEl, { initialValue: '- alpha' });

    composer.setSelectionRange(1, 1);

    expect(parentEl.querySelector('.claudian-live-preview-unordered-marker')).toBeNull();
    expect(composer.contentDOM.textContent).toContain('- alpha');

    composer.setSelectionRange(2, 2);

    expect(parentEl.querySelector('.claudian-live-preview-unordered-marker')?.textContent).toBe('•');
    expect(composer.value).toBe('- alpha');

    composer.destroy();
  });

  it('keeps incomplete Markdown tokens as source', () => {
    const parentEl = document.createElement('div');
    document.body.appendChild(parentEl);
    const value = 'Use `unfinished and [Docs](https://example.com';
    const composer = new LivePreviewComposer(parentEl, { initialValue: value });

    composer.setSelectionRange(value.length, value.length);

    expect(parentEl.querySelector('.claudian-live-preview-inline-code')).toBeNull();
    expect(parentEl.querySelector('.claudian-live-preview-link')).toBeNull();
    expect(composer.contentDOM.textContent).toContain(value);

    composer.destroy();
  });

  it('keeps the composer styling hook while focused', () => {
    const parentEl = document.createElement('div');
    document.body.appendChild(parentEl);
    const composer = new LivePreviewComposer(parentEl);

    composer.focus();
    composer.value = 'focused draft';
    composer.setSelectionRange(composer.value.length, composer.value.length);

    expect(composer.contentDOM.closest('.cm-editor')?.classList.contains(
      'claudian-live-preview-composer',
    )).toBe(true);
    composer.destroy();
  });

  it('limits long vault reference labels to the first 20 characters', () => {
    const parentEl = document.createElement('div');
    document.body.appendChild(parentEl);
    const path = 'notes/JJ-Josephson Coupling in Vertically Stacked NbS2 Graphene.md';
    const composer = new LivePreviewComposer(parentEl, {
      initialValue: `@${path}`,
      references: [{ path, kind: 'file' }],
    });

    const reference = parentEl.querySelector<HTMLElement>('.claudian-live-preview-reference');
    const label = reference?.querySelector('.claudian-live-preview-reference-label');
    expect(label?.textContent).toBe('JJ-Josephson Couplin…');
    expect(reference?.textContent).not.toContain('notes/');
    expect(reference?.title).toBe(`@${path}`);
    composer.destroy();
  });

  it('does not render a folder reference inside a file path with the same prefix', () => {
    const parentEl = document.createElement('div');
    document.body.appendChild(parentEl);
    const composer = new LivePreviewComposer(parentEl, {
      initialValue: '@notes/projects/alpha.md @notes/projects/ ',
      references: [
        { path: 'notes/projects/alpha.md', kind: 'file' },
        { path: 'notes/projects', kind: 'folder' },
      ],
    });

    const references = parentEl.querySelectorAll('.claudian-live-preview-reference');
    expect(references).toHaveLength(2);
    expect([...references].map(element => (element as HTMLElement).dataset.path)).toEqual([
      'notes/projects/alpha.md',
      'notes/projects',
    ]);
    composer.destroy();
  });

  it('renders links and list markers outside the active line and reveals active-line source', () => {
    const parentEl = document.createElement('div');
    document.body.appendChild(parentEl);
    const value = '[Docs](https://example.com)\n- alpha\n3. third\nContinue';
    const composer = new LivePreviewComposer(parentEl, { initialValue: value });

    composer.setSelectionRange(value.length, value.length);

    expect(parentEl.querySelector('.claudian-live-preview-link')?.textContent).toBe('Docs');
    expect(parentEl.querySelector('.claudian-live-preview-unordered-marker')?.textContent).toBe('•');
    expect(parentEl.querySelector('.claudian-live-preview-ordered-marker')?.textContent).toBe('3.');

    composer.setSelectionRange(0, 0);

    expect(parentEl.querySelector('.claudian-live-preview-link')).toBeNull();
    expect(composer.contentDOM.textContent).toContain('[Docs](https://example.com)');
    composer.destroy();
  });

  it('treats vault references as atomic and opens them with a modified click', () => {
    const parentEl = document.createElement('div');
    document.body.appendChild(parentEl);
    const reference = { path: 'notes/alpha.md', kind: 'file' as const };
    const onOpenReference = jest.fn();
    const composer = new LivePreviewComposer(parentEl, {
      initialValue: 'Read @notes/alpha.md now',
      references: [reference],
      onOpenReference,
    });
    const referenceEl = parentEl.querySelector<HTMLElement>('.claudian-live-preview-reference');

    referenceEl?.dispatchEvent(new MouseEvent('click', {
      metaKey: true,
      bubbles: true,
      cancelable: true,
    }));
    expect(onOpenReference).toHaveBeenCalledWith(reference);

    referenceEl?.dispatchEvent(new MouseEvent('click', {
      bubbles: true,
      cancelable: true,
    }));
    expect(composer.selectionStart).toBe('Read '.length);
    expect(composer.selectionEnd).toBe('Read @notes/alpha.md'.length);

    const tokenEnd = 'Read @notes/alpha.md'.length;
    composer.setSelectionRange(tokenEnd, tokenEnd);
    composer.contentDOM.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Backspace',
      bubbles: true,
      cancelable: true,
    }));

    expect(composer.value).toBe('Read  now');
    composer.destroy();
  });

  it('lets shared chat key handling intercept commands before composer defaults', () => {
    const parentEl = document.createElement('div');
    document.body.appendChild(parentEl);
    const onSend = jest.fn();
    const onKeydown = jest.fn((event: KeyboardEvent) => {
      event.preventDefault();
      return true;
    });
    const composer = new LivePreviewComposer(parentEl, {
      initialValue: '@notes/al',
      onKeydown,
      onSend,
    });

    composer.contentDOM.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Enter',
      bubbles: true,
      cancelable: true,
    }));

    expect(onKeydown).toHaveBeenCalled();
    expect(onSend).not.toHaveBeenCalled();
    expect(composer.value).toBe('@notes/al');
    composer.destroy();
  });
});
