import '@/providers';

import { Text } from '@codemirror/state';
import { createMockEl } from '@test/helpers/mockElement';
import { Notice } from 'obsidian';

import { ProviderRegistry } from '@/core/providers/ProviderRegistry';
import { ProviderWorkspaceRegistry } from '@/core/providers/ProviderWorkspaceRegistry';
import { InlineEditSession } from '@/features/inline-edit/ui/InlineEditModal';

jest.mock('@/shared/components/SelectionHighlight', () => ({
  hideSelectionHighlight: jest.fn(),
  showSelectionHighlight: jest.fn(),
}));

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function createSession() {
  const sourceDoc = Text.of(['hello']);
  const editorView: any = {
    dispatch: jest.fn(),
    dom: createMockEl(),
    focus: jest.fn(),
    state: { doc: sourceDoc },
  };
  const editor = {
    getCursor: jest.fn((which: string) => which === 'from'
      ? { line: 0, ch: 0 }
      : { line: 0, ch: 5 }),
    getSelection: jest.fn(() => 'hello'),
    replaceRange: jest.fn(),
  };
  const service = {
    cancel: jest.fn(),
    continueConversation: jest.fn(),
    editText: jest.fn(),
    resetConversation: jest.fn(),
    setModelOverride: jest.fn(),
    setReasoningOverride: jest.fn(),
  };
  jest.spyOn(ProviderRegistry, 'createInlineEditService').mockReturnValue(service as any);
  const resolve = jest.fn();
  const plugin: any = {
    providerHost: {},
    settings: {
      hiddenProviderCommands: {},
      providerConfigs: {
        claude: {
          model: 'claude-3-5-sonnet',
          effortLevel: 'medium',
        },
      },
    },
    mutateSettings: jest.fn(async (mutator: (s: any) => void) => {
      mutator(plugin.settings);
    }),
    getView: jest.fn(() => null),
  };
  const app: any = {
    metadataCache: {},
    vault: { getMarkdownFiles: jest.fn(() => []) },
  };
  const session = new InlineEditSession(
    app,
    plugin,
    editorView,
    editor as any,
    { mode: 'selection', selectedText: 'hello' },
    'note.md',
    () => [],
    resolve,
  );
  Object.assign(session as any, {
    editedText: 'world',
    sourceSnapshot: { doc: sourceDoc, from: 0, to: 5, text: 'hello' },
  });
  return { editor, editorView, resolve, service, session, sourceDoc };
}

describe('InlineEditSession', () => {
  let originalDocument: any;

  beforeEach(() => {
    originalDocument = (global as any).document;
    (global as any).document = {
      body: createMockEl('body'),
      createElement: (tagName: string) => createMockEl(tagName),
      addEventListener: jest.fn(),
      removeEventListener: jest.fn(),
    };
  });

  afterEach(() => {
    (global as any).document = originalDocument;
    jest.restoreAllMocks();
  });

  it('refuses a result when the captured source document changed', () => {
    const { editor, editorView, resolve, session } = createSession();
    editorView.state.doc = Text.of(['HELLO']);

    session.accept();

    expect(editor.replaceRange).not.toHaveBeenCalled();
    expect(resolve).toHaveBeenCalledWith({ decision: 'reject' });
    expect(Notice).toHaveBeenCalledWith(
      'Inline edit was not applied because the source document or selection changed.',
    );
  });

  it('settles, edits, and focuses only once', () => {
    const { editor, editorView, resolve, session } = createSession();

    session.accept();
    session.accept();
    session.reject();

    expect(editor.replaceRange).toHaveBeenCalledTimes(1);
    expect(editorView.focus).toHaveBeenCalledTimes(1);
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(resolve).toHaveBeenCalledWith({ decision: 'accept', editedText: 'world' });
  });

  it('scopes keyboard handling to its preview or editor DOM', () => {
    const { editorView, session } = createSession();
    const preview = createMockEl();
    const previewChild = createMockEl('button');
    const outside = createMockEl();
    preview.appendChild(previewChild);
    (session as any).containerEl = preview;

    expect((session as any).isKeyboardEventInContext({ target: previewChild })).toBe(true);
    expect((session as any).isKeyboardEventInContext({ target: editorView.dom })).toBe(true);
    expect((session as any).isKeyboardEventInContext({ target: outside })).toBe(false);
  });

  it('ignores a provider result that arrives after the session is rejected', async () => {
    const { editorView, resolve, service, session } = createSession();
    const result = createDeferred<{ success: true; editedText: string }>();
    service.editText.mockReturnValue(result.promise);
    Object.assign(session as any, {
      editedText: null,
      inputEl: Object.assign(createMockEl('input'), { value: 'rewrite' }),
      spinnerEl: createMockEl(),
    });

    const generation = (session as any).generate();
    await Promise.resolve();
    session.reject();
    editorView.dispatch.mockClear();
    result.resolve({ success: true, editedText: 'world' });
    await generation;

    expect(editorView.dispatch).not.toHaveBeenCalled();
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(resolve).toHaveBeenCalledWith({ decision: 'reject' });
  });

  it('rejects a provider result before previewing when its source snapshot changed', async () => {
    const { editorView, resolve, service, session } = createSession();
    const result = createDeferred<{ success: true; editedText: string }>();
    service.editText.mockReturnValue(result.promise);
    const showDiff = jest.fn();
    Object.assign(session as any, {
      editedText: null,
      inputEl: Object.assign(createMockEl('input'), { value: 'rewrite' }),
      showDiffInPlace: showDiff,
      spinnerEl: createMockEl(),
    });

    const generation = (session as any).generate();
    await Promise.resolve();
    editorView.state.doc = Text.of(['changed']);
    result.resolve({ success: true, editedText: 'world' });
    await generation;

    expect(showDiff).not.toHaveBeenCalled();
    expect(resolve).toHaveBeenCalledWith({ decision: 'reject' });
    expect(Notice).toHaveBeenCalledWith(
      'Inline edit was not applied because the source document or selection changed.',
    );
  });

  it('renders review bar with line count stats and keyboard shortcut hints', () => {
    const { session } = createSession();
    const diffOps: any[] = [
      { type: 'delete', text: 'old line 1\nold line 2\n' },
      { type: 'insert', text: 'new line 1\n' },
      { type: 'equal', text: 'same\n' },
    ];

    const previewEl = session.createDiffPreviewDOM(diffOps);
    const statsEl = previewEl.querySelector('.codian-inline-diff-stats');
    expect(statsEl).toBeDefined();
    expect(previewEl.querySelector('.codian-inline-diff-stat-del')?.textContent).toBe('−2');
    expect(previewEl.querySelector('.codian-inline-diff-stat-ins')?.textContent).toBe('+1');
    const labelSpan = statsEl?.children[statsEl.children.length - 1];
    expect(labelSpan?.textContent).toBe('lines');

    const actions = previewEl.querySelectorAll('.codian-inline-preview-action');
    expect(actions).toHaveLength(2);
    const rejectBtn = actions[0];
    const acceptBtn = actions[1];

    expect(rejectBtn.getAttribute('aria-keyshortcuts')).toBe('Escape');
    expect(rejectBtn.querySelector('.codian-inline-preview-key')?.textContent).toBe('Esc');

    expect(acceptBtn.getAttribute('aria-keyshortcuts')).toBe('Enter');
    expect(acceptBtn.querySelector('.codian-inline-preview-key')?.textContent).toBe('↵');
  });

  it('renders single-row composer card with data-provider and Codian selectors', () => {
    const { session } = createSession();
    const dom = session.createInputDOM();

    expect(dom.classList.contains('codian-inline-input-container')).toBe(true);
    expect(dom.getAttribute('data-provider')).toBe('claude');
    const cardEl = dom.querySelector('.codian-inline-composer');
    expect(cardEl).not.toBeNull();
    expect(cardEl?.querySelector('.codian-inline-input-wrap')).not.toBeNull();
    expect(cardEl?.querySelector('input.codian-inline-input')).not.toBeNull();
    expect(cardEl?.querySelector('.codian-inline-spinner')).not.toBeNull();
    expect(cardEl?.querySelector('.codian-inline-model-toolbar')).not.toBeNull();
    expect(cardEl?.querySelector('.codian-model-selector')).not.toBeNull();
    expect(cardEl?.querySelector('.codian-thinking-selector')).not.toBeNull();
  });

  it('persists model and reasoning selection when changed via callbacks', async () => {
    const { session } = createSession();
    session.createInputDOM();
    const callbacks = (session as any).modelPickerCallbacks();

    await callbacks.onModelChange('haiku');
    expect((session as any).plugin.mutateSettings).toHaveBeenCalled();
    expect((session as any).plugin.settings.inlineEditModel).toEqual({
      providerId: 'claude',
      model: 'haiku',
      reasoning: 'high',
    });

    await callbacks.onEffortLevelChange('low');
    expect((session as any).plugin.settings.inlineEditModel).toEqual({
      providerId: 'claude',
      model: 'haiku',
      reasoning: 'low',
    });
  });

  it('switches provider and inlineEditService when selecting model from another provider', async () => {
    jest.spyOn(ProviderWorkspaceRegistry, 'ensureInitialized').mockResolvedValue(undefined as any);
    const { session } = createSession();
    const dom = session.createInputDOM();
    const callbacks = (session as any).modelPickerCallbacks();

    // Select a model belonging to another provider (e.g. codex)
    await callbacks.onModelChange('gpt-4o', 'codex');

    expect(ProviderWorkspaceRegistry.ensureInitialized).toHaveBeenCalledWith(
      (session as any).plugin.providerHost,
      'codex',
      'inline-edit',
    );
    expect(dom.getAttribute('data-provider')).toBe('codex');
    expect((session as any).resolvedProviderId).toBe('codex');
    expect((session as any).plugin.settings.inlineEditModel).toEqual({
      providerId: 'codex',
      model: 'gpt-4o',
      reasoning: 'high',
    });
  });

  it('forwards model and reasoning overrides to inlineEditService during generate', async () => {
    const { service, session } = createSession();
    session.createInputDOM();
    const callbacks = (session as any).modelPickerCallbacks();
    await callbacks.onModelChange('sonnet');
    await callbacks.onEffortLevelChange('low');

    const result = createDeferred<{ success: true; editedText: string }>();
    service.editText.mockReturnValue(result.promise);
    (session as any).inputEl.value = 'refactor function';

    const generation = (session as any).generate();
    expect(service.setModelOverride).toHaveBeenCalledWith('sonnet');
    expect(service.setReasoningOverride).toHaveBeenCalledWith('low');

    result.resolve({ success: true, editedText: 'world' });
    await generation;
  });

  it('cleans up floating menu layer and input resources on cleanup', () => {
    const { session } = createSession();
    const dom = session.createInputDOM();
    expect(dom).toBeDefined();
    const ownerDocument = (session as any).getOwnerDocument();
    const menuLayer = ownerDocument.body.querySelector('.codian-inline-menu-layer');
    expect(menuLayer).toBeDefined();

    session.reject();
    expect((session as any).inputResources).toBeNull();
  });

  it('initializes with saved inlineEditModel defaults from plugin settings', () => {
    const sourceDoc = Text.of(['hello']);
    const editorView: any = {
      dispatch: jest.fn(),
      dom: createMockEl(),
      focus: jest.fn(),
      state: { doc: sourceDoc },
    };
    const editor = {
      getCursor: jest.fn(() => ({ line: 0, ch: 0 })),
      getSelection: jest.fn(() => 'hello'),
      replaceRange: jest.fn(),
    };
    const service = {
      cancel: jest.fn(),
      continueConversation: jest.fn(),
      editText: jest.fn(),
      resetConversation: jest.fn(),
      setModelOverride: jest.fn(),
      setReasoningOverride: jest.fn(),
    };
    jest.spyOn(ProviderRegistry, 'createInlineEditService').mockReturnValue(service as any);
    const plugin: any = {
      providerHost: {},
      settings: {
        hiddenProviderCommands: {},
        inlineEditModel: {
          providerId: 'claude',
          model: 'haiku',
          reasoning: 'low',
        },
        providerConfigs: {
          claude: {
            model: 'sonnet',
          },
        },
      },
      mutateSettings: jest.fn(),
      getView: jest.fn(() => null),
    };
    const app: any = {
      metadataCache: {},
      vault: { getMarkdownFiles: jest.fn(() => []) },
    };
    new InlineEditSession(
      app,
      plugin,
      editorView,
      editor as any,
      { mode: 'selection', selectedText: 'hello' },
      'note.md',
      () => [],
      jest.fn(),
    );

    expect(service.setModelOverride).toHaveBeenCalledWith('haiku');
    expect(service.setReasoningOverride).toHaveBeenCalledWith('low');
  });
});
