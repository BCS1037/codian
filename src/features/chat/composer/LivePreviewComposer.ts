import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { Compartment, EditorSelection, EditorState, Prec, StateEffect } from '@codemirror/state';
import {
  Decoration,
  type DecorationSet,
  EditorView,
  keymap,
  placeholder,
  type PluginValue,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from '@codemirror/view';
import { setIcon } from 'obsidian';

import type { VaultContextReference } from './types';

const refreshDecorationsEffect = StateEffect.define<void>();
const MAX_REFERENCE_LABEL_LENGTH = 20;

function formatReferenceLabel(path: string): string {
  const basename = path.split('/').at(-1) ?? path;
  const characters = Array.from(basename);
  return characters.length > MAX_REFERENCE_LABEL_LENGTH
    ? `${characters.slice(0, MAX_REFERENCE_LABEL_LENGTH).join('')}…`
    : basename;
}

export interface LivePreviewComposerOptions {
  initialValue?: string;
  placeholder?: string;
  references?: readonly VaultContextReference[];
  onChange?: (value: string) => void;
  onKeydown?: (event: KeyboardEvent) => boolean | void;
  onSelectionChange?: (start: number, end: number) => void;
  onSend?: (value: string) => void;
  onOpenReference?: (reference: VaultContextReference) => void;
}

class InlineCodeWidget extends WidgetType {
  constructor(private readonly text: string) {
    super();
  }

  eq(other: InlineCodeWidget): boolean {
    return this.text === other.text;
  }

  toDOM(view: EditorView): HTMLElement {
    const element = view.dom.ownerDocument.createElement('code');
    element.classList.add('claudian-live-preview-inline-code');
    element.textContent = this.text;
    return element;
  }
}

class LinkWidget extends WidgetType {
  constructor(private readonly label: string, private readonly href: string) {
    super();
  }

  eq(other: LinkWidget): boolean {
    return this.label === other.label && this.href === other.href;
  }

  toDOM(view: EditorView): HTMLElement {
    const element = view.dom.ownerDocument.createElement('span');
    element.classList.add('claudian-live-preview-link');
    element.dataset.href = this.href;
    element.title = this.href;
    element.textContent = this.label;
    return element;
  }
}

class ListMarkerWidget extends WidgetType {
  constructor(private readonly label: string, private readonly ordered: boolean) {
    super();
  }

  eq(other: ListMarkerWidget): boolean {
    return this.label === other.label && this.ordered === other.ordered;
  }

  toDOM(view: EditorView): HTMLElement {
    const element = view.dom.ownerDocument.createElement('span');
    element.classList.add(this.ordered
      ? 'claudian-live-preview-ordered-marker'
      : 'claudian-live-preview-unordered-marker');
    element.textContent = this.label;
    return element;
  }
}

class VaultReferenceWidget extends WidgetType {
  constructor(
    private readonly reference: VaultContextReference,
    private readonly from: number,
    private readonly to: number,
    private readonly selected: boolean,
    private readonly onOpen?: (reference: VaultContextReference) => void,
  ) {
    super();
  }

  eq(other: VaultReferenceWidget): boolean {
    return this.reference.path === other.reference.path
      && this.reference.kind === other.reference.kind
      && this.from === other.from
      && this.to === other.to
      && this.selected === other.selected;
  }

  toDOM(view: EditorView): HTMLElement {
    const ownerDocument = view.dom.ownerDocument;
    const element = ownerDocument.createElement('span');
    const icon = ownerDocument.createElement('span');
    const label = ownerDocument.createElement('span');
    const token = `@${this.reference.path}${this.reference.kind === 'folder' ? '/' : ''}`;

    element.classList.add('claudian-live-preview-reference');
    element.classList.toggle('claudian-live-preview-reference--selected', this.selected);
    element.dataset.path = this.reference.path;
    element.dataset.kind = this.reference.kind;
    element.title = token;
    icon.classList.add('claudian-live-preview-reference-icon');
    setIcon(icon, this.reference.kind === 'folder' ? 'folder' : 'file-text');
    label.classList.add('claudian-live-preview-reference-label');
    label.textContent = formatReferenceLabel(this.reference.path);
    element.append(icon, label);
    element.addEventListener('click', (event) => {
      event.preventDefault();
      if (event.metaKey || event.ctrlKey) {
        this.onOpen?.(this.reference);
        return;
      }
      view.dispatch({ selection: EditorSelection.range(this.from, this.to) });
      view.focus();
    });
    return element;
  }

  ignoreEvent(): boolean {
    return false;
  }
}

function createDecorationPlugin(
  getReferences: () => readonly VaultContextReference[],
  onOpenReference?: (reference: VaultContextReference) => void,
) {
  return ViewPlugin.fromClass(class implements PluginValue {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = this.buildDecorations(view);
    }

    update(update: ViewUpdate): void {
      const refreshRequested = update.transactions.some(transaction => (
        transaction.effects.some(effect => effect.is(refreshDecorationsEffect))
      ));
      if (update.docChanged || update.selectionSet || update.viewportChanged || refreshRequested) {
        this.decorations = this.buildDecorations(update.view);
      }
    }

    private buildDecorations(view: EditorView): DecorationSet {
      const ranges: Array<{ from: number; to: number; value: Decoration }> = [];
      const text = view.state.doc.toString();
      const selection = view.state.selection.main;
      const selectionIntersects = (from: number, to: number): boolean => (
        selection.empty
          ? selection.head >= from && selection.head < to
          : selection.from < to && selection.to > from
      );

      for (const reference of getReferences()) {
        const token = `@${reference.path}${reference.kind === 'folder' ? '/' : ''}`;
        let from = text.indexOf(token);
        while (from >= 0) {
          const to = from + token.length;
          const hasTokenBoundary = (from === 0 || /\s/.test(text[from - 1]))
            && (to === text.length || /\s/.test(text[to]));
          if (!hasTokenBoundary) {
            from = text.indexOf(token, to);
            continue;
          }
          ranges.push({
            from,
            to,
            value: Decoration.replace({
              widget: new VaultReferenceWidget(
                reference,
                from,
                to,
                selection.from === from && selection.to === to,
                onOpenReference,
              ),
            }),
          });
          from = text.indexOf(token, from + token.length);
        }
      }

      const overlapsExistingRange = (from: number, to: number): boolean => (
        ranges.some(range => range.from < to && range.to > from)
      );

      const linkPattern = /\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g;
      let linkMatch: RegExpExecArray | null;
      while ((linkMatch = linkPattern.exec(text)) !== null) {
        const from = linkMatch.index;
        const to = from + linkMatch[0].length;
        if (selectionIntersects(from, to)) continue;
        if (overlapsExistingRange(from, to)) continue;
        ranges.push({
          from,
          to,
          value: Decoration.replace({ widget: new LinkWidget(linkMatch[1], linkMatch[2]) }),
        });
      }

      for (let lineNumber = 1; lineNumber <= view.state.doc.lines; lineNumber += 1) {
        const line = view.state.doc.line(lineNumber);
        const unorderedMatch = /^(\s*)([-+*])\s/.exec(line.text);
        const orderedMatch = /^(\s*)(\d+)\.\s/.exec(line.text);
        if (unorderedMatch) {
          const from = line.from + unorderedMatch[1].length;
          const to = from + unorderedMatch[2].length + 1;
          if (selectionIntersects(from, to)) continue;
          ranges.push({
            from,
            to,
            value: Decoration.replace({ widget: new ListMarkerWidget('•', false) }),
          });
        } else if (orderedMatch) {
          const from = line.from + orderedMatch[1].length;
          const to = from + orderedMatch[2].length + 2;
          if (selectionIntersects(from, to)) continue;
          ranges.push({
            from,
            to,
            value: Decoration.replace({ widget: new ListMarkerWidget(`${orderedMatch[2]}.`, true) }),
          });
        }
      }

      const inlineCodePattern = /`([^`\n]+)`/g;
      let match: RegExpExecArray | null;
      while ((match = inlineCodePattern.exec(text)) !== null) {
        const from = match.index;
        const to = from + match[0].length;
        if (selectionIntersects(from, to)) continue;
        if (overlapsExistingRange(from, to)) continue;
        ranges.push({
          from,
          to,
          value: Decoration.replace({ widget: new InlineCodeWidget(match[1]) }),
        });
      }

      ranges.sort((left, right) => left.from - right.from || left.to - right.to);
      return Decoration.set(ranges.map(range => range.value.range(range.from, range.to)), true);
    }
  }, {
    decorations: value => value.decorations,
  });
}

export class LivePreviewComposer {
  private readonly view: EditorView;
  private readonly placeholderCompartment = new Compartment();
  private references: readonly VaultContextReference[];

  constructor(parentEl: HTMLElement, private readonly options: LivePreviewComposerOptions = {}) {
    this.references = options.references ?? [];
    const state = EditorState.create({
      doc: options.initialValue ?? '',
      extensions: [
        history(),
        keymap.of([...defaultKeymap, ...historyKeymap]),
        EditorView.editorAttributes.of({ class: 'claudian-live-preview-composer' }),
        this.placeholderCompartment.of(placeholder(options.placeholder ?? '')),
        createDecorationPlugin(() => this.references, options.onOpenReference),
        Prec.highest(EditorView.domEventHandlers({
          keydown: (event) => this.handleKeydown(event),
        })),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) this.options.onChange?.(update.state.doc.toString());
          if (update.selectionSet) {
            const selection = update.state.selection.main;
            this.options.onSelectionChange?.(selection.from, selection.to);
          }
        }),
      ],
    });
    this.view = new EditorView({ state, parent: parentEl });
  }

  get contentDOM(): HTMLElement {
    return this.view.contentDOM;
  }

  get value(): string {
    return this.view.state.doc.toString();
  }

  set value(value: string) {
    this.view.dispatch({
      changes: { from: 0, to: this.view.state.doc.length, insert: value },
    });
  }

  get selectionStart(): number {
    return this.view.state.selection.main.from;
  }

  get selectionEnd(): number {
    return this.view.state.selection.main.to;
  }

  setSelectionRange(start: number, end: number): void {
    this.view.dispatch({
      selection: EditorSelection.range(start, end),
    });
  }

  setReferences(references: readonly VaultContextReference[]): void {
    this.references = references;
    this.view.dispatch({ effects: refreshDecorationsEffect.of() });
  }

  setPlaceholder(value: string): void {
    this.view.dispatch({
      effects: this.placeholderCompartment.reconfigure(placeholder(value)),
    });
  }

  focus(): void {
    this.view.focus();
  }

  destroy(): void {
    this.view.destroy();
  }

  private handleKeydown(event: KeyboardEvent): boolean {
    if (this.options.onKeydown?.(event) === true || event.defaultPrevented) return true;

    if ((event.key === 'Backspace' || event.key === 'Delete') && this.deleteAtomicReference(event.key)) {
      event.preventDefault();
      return true;
    }

    if (event.key !== 'Enter' || event.isComposing) return false;

    if (!event.shiftKey) {
      if (!this.options.onSend) return false;
      event.preventDefault();
      this.options.onSend(this.value);
      return true;
    }

    event.preventDefault();
    this.insertListContinuation();
    return true;
  }

  private deleteAtomicReference(key: 'Backspace' | 'Delete'): boolean {
    const selection = this.view.state.selection.main;
    const ranges = this.findReferenceRanges();
    const target = ranges.find(range => {
      if (!selection.empty) return selection.from < range.to && selection.to > range.from;
      return key === 'Backspace' ? selection.from === range.to : selection.from === range.from;
    });
    if (!target) return false;

    this.view.dispatch({
      changes: { from: target.from, to: target.to, insert: '' },
      selection: { anchor: target.from },
      scrollIntoView: true,
    });
    return true;
  }

  private findReferenceRanges(): Array<{ from: number; to: number }> {
    const text = this.value;
    const ranges: Array<{ from: number; to: number }> = [];
    for (const reference of this.references) {
      const token = `@${reference.path}${reference.kind === 'folder' ? '/' : ''}`;
      let from = text.indexOf(token);
      while (from >= 0) {
        ranges.push({ from, to: from + token.length });
        from = text.indexOf(token, from + token.length);
      }
    }
    return ranges;
  }

  private insertListContinuation(): void {
    const selection = this.view.state.selection.main;
    const line = this.view.state.doc.lineAt(selection.head);
    const beforeCaret = this.view.state.sliceDoc(line.from, selection.head);
    if (/^\s*(?:[-+*]|\d+\.)\s*$/.test(beforeCaret)) {
      this.view.dispatch({
        changes: { from: line.from, to: selection.to, insert: '' },
        selection: { anchor: line.from },
        scrollIntoView: true,
      });
      return;
    }

    const unorderedMatch = /^(\s*)([-+*])\s+(.*)$/.exec(beforeCaret);
    const orderedMatch = /^(\s*)(\d+)\.\s+(.*)$/.exec(beforeCaret);
    const insert = unorderedMatch
      ? `\n${unorderedMatch[1]}${unorderedMatch[2]} `
      : orderedMatch
        ? `\n${orderedMatch[1]}${Number.parseInt(orderedMatch[2], 10) + 1}. `
        : '\n';

    this.view.dispatch({
      changes: { from: selection.from, to: selection.to, insert },
      selection: { anchor: selection.from + insert.length },
      scrollIntoView: true,
    });
  }
}
