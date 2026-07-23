/** @jest-environment jsdom */

import { createMockEl } from '@test/helpers/mockElement';
import { TFile, TFolder } from 'obsidian';

import { VaultContextDropController } from '@/features/chat/composer/VaultContextDropController';

function createVaultFile(path: string): TFile {
  return new (TFile as any)(path) as TFile;
}

function createVaultFolder(path: string): TFolder {
  return new (TFolder as any)(path) as TFolder;
}

function createInput(value: string, caret: number): HTMLTextAreaElement {
  return {
    value,
    selectionStart: caret,
    selectionEnd: caret,
    focus: jest.fn(),
    setSelectionRange: jest.fn(function (this: HTMLTextAreaElement, start: number, end: number) {
      this.selectionStart = start;
      this.selectionEnd = end;
    }),
    dispatchEvent: jest.fn(),
  } as unknown as HTMLTextAreaElement;
}

function addObsidianDomMethods<T extends HTMLElement>(element: T): T {
  return Object.assign(element, {
    createDiv(options?: { cls?: string; text?: string }) {
      const child = addObsidianDomMethods(document.createElement('div'));
      if (options?.cls) child.className = options.cls;
      if (options?.text) child.textContent = options.text;
      element.appendChild(child);
      return child;
    },
    createSpan(options?: { cls?: string; text?: string }) {
      const child = addObsidianDomMethods(document.createElement('span'));
      if (options?.cls) child.className = options.cls;
      if (options?.text) child.textContent = options.text;
      element.appendChild(child);
      return child;
    },
    addClass(className: string) {
      element.classList.add(className);
    },
    removeClass(className: string) {
      element.classList.remove(className);
    },
    toggleClass(className: string, force?: boolean) {
      element.classList.toggle(className, force);
    },
  });
}

describe('VaultContextDropController', () => {
  it('intercepts vault drops before child editors append their URI payload', () => {
    const note = createVaultFile('notes/alpha.md');
    const app = {
      dragManager: { draggable: { type: 'file', file: note } },
    } as any;
    const dropZone = addObsidianDomMethods(document.createElement('div'));
    const editor = dropZone.appendChild(document.createElement('div'));
    const input = dropZone.appendChild(document.createElement('textarea'));
    const childDrop = jest.fn(() => {
      input.value += 'obsidian://open?vault=bcsbox&file=notes%2Falpha.md';
    });
    editor.addEventListener('drop', childDrop);
    const controller = new VaultContextDropController(app, dropZone, input, {
      onReferencesDropped: jest.fn(),
    });

    editor.dispatchEvent(new Event('drop', { bubbles: true, cancelable: true }));

    expect(childDrop).not.toHaveBeenCalled();
    expect(input.value).toBe('@notes/alpha.md ');
    controller.destroy();
  });

  it('inserts dropped vault notes and folders at the caret', () => {
    const note = createVaultFile('notes/alpha.md');
    const folder = createVaultFolder('projects/demo');
    const app = {
      dragManager: {
        draggable: { type: 'files', files: [note, folder] },
      },
    } as any;
    const dropZone = createMockEl();
    const input = createInput('Review  please', 7);
    const onReferencesDropped = jest.fn();
    const controller = new VaultContextDropController(app, dropZone, input, {
      onReferencesDropped,
    });

    const event = {
      type: 'drop',
      preventDefault: jest.fn(),
      stopImmediatePropagation: jest.fn(),
      dataTransfer: { files: [] },
    };
    dropZone.dispatchEvent(event);

    expect(input.value).toBe('Review @notes/alpha.md @projects/demo/ please');
    expect(onReferencesDropped).toHaveBeenCalledWith([
      { path: 'notes/alpha.md', kind: 'file' },
      { path: 'projects/demo', kind: 'folder' },
    ]);
    expect(event.preventDefault).toHaveBeenCalled();

    controller.destroy();
  });

  it('shows context overlay for vault drags and skips references already in input', () => {
    const note = createVaultFile('notes/alpha.md');
    const app = {
      dragManager: { draggable: { type: 'file', file: note } },
    } as any;
    const dropZone = createMockEl();
    const input = createInput('@notes/alpha.md ', 16);
    const onReferencesDropped = jest.fn();
    const controller = new VaultContextDropController(app, dropZone, input, {
      onReferencesDropped,
    });

    const dragEnter = {
      type: 'dragenter',
      preventDefault: jest.fn(),
      stopImmediatePropagation: jest.fn(),
    };
    dropZone.dispatchEvent(dragEnter);

    const overlay = dropZone.querySelector('.claudian-drop-overlay');
    expect(overlay?.hasClass('visible')).toBe(true);
    const dropContent = dropZone.querySelector('.claudian-drop-content');
    expect(dropContent?.children[1]?.textContent).toBe('Drop to add context');

    dropZone.dispatchEvent({
      type: 'drop',
      preventDefault: jest.fn(),
      stopImmediatePropagation: jest.fn(),
      dataTransfer: { files: [] },
    });

    expect(input.value).toBe('@notes/alpha.md ');
    expect(onReferencesDropped).toHaveBeenCalledWith([
      { path: 'notes/alpha.md', kind: 'file' },
    ]);
    expect(overlay?.hasClass('visible')).toBe(false);

    controller.destroy();
  });

  it('reports an internal vault drag when every item is unsupported', () => {
    const app = {
      dragManager: { draggable: { type: 'file', file: createVaultFile('assets/manual.pdf') } },
    } as any;
    const dropZone = createMockEl();
    const input = createInput('', 0);
    const onInvalidDrop = jest.fn();
    const controller = new VaultContextDropController(app, dropZone, input, {
      onReferencesDropped: jest.fn(),
      onInvalidDrop,
    });
    const event = {
      type: 'drop',
      preventDefault: jest.fn(),
      stopImmediatePropagation: jest.fn(),
      dataTransfer: { files: [] },
    };

    dropZone.dispatchEvent(event);

    expect(onInvalidDrop).toHaveBeenCalled();
    expect(input.value).toBe('');
    expect(event.preventDefault).toHaveBeenCalled();

    controller.destroy();
  });

  it('rejects the vault root folder instead of inserting a double slash reference', () => {
    const app = {
      dragManager: { draggable: { type: 'file', file: createVaultFolder('/') } },
    } as any;
    const dropZone = createMockEl();
    const input = createInput('', 0);
    const onInvalidDrop = jest.fn();
    const controller = new VaultContextDropController(app, dropZone, input, {
      onReferencesDropped: jest.fn(),
      onInvalidDrop,
    });

    dropZone.dispatchEvent({
      type: 'drop',
      preventDefault: jest.fn(),
      stopImmediatePropagation: jest.fn(),
      dataTransfer: { files: [] },
    });

    expect(input.value).toBe('');
    expect(onInvalidDrop).toHaveBeenCalled();

    controller.destroy();
  });
});
