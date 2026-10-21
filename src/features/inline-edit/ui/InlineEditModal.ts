import { StateEffect, StateField, type Text } from '@codemirror/state';
import type { DecorationSet } from '@codemirror/view';
import { Decoration, EditorView, WidgetType } from '@codemirror/view';
import type { App, Component, Editor, MarkdownView } from 'obsidian';
import { Notice } from 'obsidian';

import { getHiddenProviderCommandSet } from '../../../core/providers/commands/hiddenCommands';
import { normalizeProviderCommandDiscoveryItems } from '../../../core/providers/commands/ProviderCommandDiscoveryResult';
import { ProviderCommandDiscoveryStore } from '../../../core/providers/commands/ProviderCommandDiscoveryStore';
import {
  getProviderSettingsSnapshotWithModel,
  resolveConversationModel,
} from '../../../core/providers/conversationModel';
import {
  getAllEnabledProviderModelOptions,
  getEnabledProviderForModel,
} from '../../../core/providers/modelRouting';
import { ProviderRegistry } from '../../../core/providers/ProviderRegistry';
import { ProviderWorkspaceRegistry } from '../../../core/providers/ProviderWorkspaceRegistry';
import { DEFAULT_CHAT_PROVIDER_ID, type InlineEditMode, type InlineEditService, type ProviderId } from '../../../core/providers/types';
import type { StoredInlineEditModelSelection } from '../../../core/types/settings';
import { hideSelectionHighlight, showSelectionHighlight } from '../../../shared/components/SelectionHighlight';
import { SlashCommandDropdown } from '../../../shared/components/SlashCommandDropdown';
import { MentionDropdownController } from '../../../shared/mention/MentionDropdownController';
import { VaultMentionDataProvider } from '../../../shared/mention/VaultMentionDataProvider';
import { ModelSelector } from '../../../shared/toolbar/ModelSelector';
import { ThinkingSelector } from '../../../shared/toolbar/ThinkingSelector';
import type { ModelPickerCallbacks, ModelPickerSettings } from '../../../shared/toolbar/types';
import {
  createExternalContextLookupGetter,
  findBestMentionLookupMatch,
  isMentionStart,
  normalizeForPlatformLookup,
  normalizeMentionPath,
  resolveExternalMentionAtIndex,
} from '../../../utils/contextMentionResolver';
import { type CursorContext, getEditorView } from '../../../utils/editor';
import { buildExternalContextDisplayEntries } from '../../../utils/externalContext';
import { externalContextScanner } from '../../../utils/externalContextScanner';
import { normalizeInsertionText } from '../../../utils/inlineEdit';
import { getVaultPath, normalizePathForVault as normalizePathForVaultUtil } from '../../../utils/path';
import type { FeatureHost } from '../../FeatureHost';
import { renderInlineEditMarkdownPreview } from './inlineEditMarkdownPreview';
import {
  buildMarkdownDiffDocuments,
  computeMarkdownDiff,
  countDiffLines,
  type DiffOp,
  diffOpsEqual,
} from './markdownLineDiff';

type InlineEditHost = FeatureHost & Component;

export type InlineEditContext =
  | { mode: 'selection'; selectedText: string }
  | { mode: 'cursor'; cursorContext: CursorContext };

const showInlineEdit = StateEffect.define<{
  inputPos: number;
  selFrom: number;
  selTo: number;
  widget: InlineEditSession;
  isInbetween?: boolean;
}>();
const showDiff = StateEffect.define<{
  from: number;
  to: number;
  diffOps: DiffOp[];
  previewPos: number;
  widget: InlineEditSession;
}>();
const showInsertion = StateEffect.define<{
  diffOps: DiffOp[];
  previewPos: number;
  widget: InlineEditSession;
}>();
const hideInlineEdit = StateEffect.define<null>();

let activeController: InlineEditSession | null = null;

function rejectActiveController(): boolean {
  const controller = activeController;
  if (!controller) return false;
  controller.reject();
  return true;
}

class InputWidget extends WidgetType {
  constructor(private controller: InlineEditSession) {
    super();
  }
  toDOM(): HTMLElement {
    return this.controller.createInputDOM();
  }
  destroy(dom: HTMLElement): void {
    this.controller.destroyInputDOM(dom);
  }
  eq(): boolean {
    return false;
  }
  ignoreEvent(): boolean {
    return true;
  }
}

class MarkdownDiffWidget extends WidgetType {
  constructor(private diffOps: DiffOp[], private controller: InlineEditSession) {
    super();
  }
  toDOM(): HTMLElement {
    return this.controller.createDiffPreviewDOM(this.diffOps);
  }
  eq(other: MarkdownDiffWidget): boolean {
    return diffOpsEqual(this.diffOps, other.diffOps);
  }
  ignoreEvent(): boolean {
    return true;
  }
}

export function buildInlineEditInputDecorations(options: {
  doc: Text;
  inputPos: number;
  isInbetween?: boolean;
  widget: WidgetType;
}): DecorationSet {
  // Decoration.set(..., true) sorts line and widget decorations by CodeMirror's
  // internal range ordering, including equal-position block widgets at line start.
  const isInbetween = options.isInbetween ?? false;
  const lineStart = options.doc.lineAt(options.inputPos).from;
  return Decoration.set([
    Decoration.line({
      class: 'codian-inline-input-line',
    }).range(lineStart),
    Decoration.widget({
      widget: options.widget,
      block: !isInbetween,
      side: isInbetween ? 1 : -1,
    }).range(options.inputPos),
  ], true);
}

const inlineEditField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update: (deco, tr) => {
    deco = deco.map(tr.changes);
    for (const e of tr.effects) {
      if (e.is(showInlineEdit)) {
        // Block above line for selection/inline mode, inline widget for inbetween mode
        deco = buildInlineEditInputDecorations({
          doc: tr.state.doc,
          inputPos: e.value.inputPos,
          isInbetween: e.value.isInbetween,
          widget: new InputWidget(e.value.widget),
        });
      } else if (e.is(showDiff)) {
        deco = Decoration.set([
          Decoration.widget({
            widget: new MarkdownDiffWidget(e.value.diffOps, e.value.widget),
            block: true,
            side: -1,
          }).range(e.value.previewPos),
          Decoration.replace({}).range(e.value.from, e.value.to),
        ], true);
      } else if (e.is(showInsertion)) {
        deco = Decoration.set([
          Decoration.widget({
            widget: new MarkdownDiffWidget(e.value.diffOps, e.value.widget),
            block: true,
            side: -1,
          }).range(e.value.previewPos),
        ], true);
      } else if (e.is(hideInlineEdit)) {
        deco = Decoration.none;
      }
    }
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

const installedEditors = new WeakSet<EditorView>();

function getDiffBlockClass(type: DiffOp['type']): string {
  switch (type) {
    case 'delete':
      return 'codian-diff-del';
    case 'insert':
      return 'codian-diff-ins';
    default:
      return 'codian-diff-equal';
  }
}

export type InlineEditDecision = 'accept' | 'edit' | 'reject';

interface InlineEditSourceSnapshot {
  doc: Text;
  from: number;
  text: string;
  to: number;
}

interface InlineEditProviderContext {
  modelOverride?: string;
  reasoningOverride?: string;
  providerId: ProviderId;
}

/** The saved inline default, while its provider is enabled and still offers its model and effort. */
function resolveSavedInlineEditModel(plugin: InlineEditHost): InlineEditProviderContext | null {
  const saved = plugin.settings?.inlineEditModel;
  if (!saved
    || !ProviderRegistry.getRegisteredProviderIds().includes(saved.providerId)
    || !ProviderRegistry.isEnabled(saved.providerId, plugin.settings)) {
    return null;
  }
  const settings = getProviderSettingsSnapshotWithModel({ ...plugin.settings }, saved.providerId);
  const uiConfig = ProviderRegistry.getChatUIConfig(saved.providerId);
  const envVars = typeof plugin.getActiveEnvironmentVariables === 'function'
    ? plugin.getActiveEnvironmentVariables(saved.providerId)
    : '';
  const offered = uiConfig.getModelOptions({
    ...settings,
    environmentVariables: envVars,
  }).some(option => option.value === saved.model);
  if (!offered) return null;
  const reasoningOffered = uiConfig.getReasoningOptions(saved.model, settings)
    .some(option => option.value === saved.reasoning);
  return {
    modelOverride: saved.model,
    reasoningOverride: reasoningOffered ? saved.reasoning : undefined,
    providerId: saved.providerId,
  };
}

function resolveInlineEditProviderContext(plugin: InlineEditHost): InlineEditProviderContext {
  const saved = resolveSavedInlineEditModel(plugin);
  if (saved) return saved;
  const activeView = typeof plugin.getView === 'function' ? plugin.getView() : null;
  const activeTab = activeView?.getActiveTab();
  const conversation = activeTab?.conversationId
    ? plugin.getConversationSync(activeTab.conversationId)
    : null;
  const activeDraftProvider = activeTab?.draftModel && plugin.settings
    ? getEnabledProviderForModel(activeTab.draftModel, plugin.settings)
    : undefined;
  const providerId = conversation?.providerId
    ?? activeTab?.service?.providerId
    ?? activeDraftProvider
    ?? activeTab?.providerId
    ?? (plugin.settings?.defaultChatProvider as ProviderId)
    ?? DEFAULT_CHAT_PROVIDER_ID;
  const modelOverride = conversation
    ? resolveConversationModel(plugin.settings, providerId, conversation).model
    : activeTab?.service?.providerId === providerId
    ? activeTab.service.getAuxiliaryModel?.()
    : activeTab?.draftModel && activeDraftProvider === providerId
    ? activeTab.draftModel
    : activeTab?.providerId === providerId
    ? activeTab.draftModel
    : null;

  return {
    modelOverride: modelOverride ?? undefined,
    providerId,
  };
}

export class InlineEditModal {
  private controller: InlineEditSession | null = null;

  constructor(
    private app: App,
    private plugin: InlineEditHost,
    private editor: Editor,
    private view: MarkdownView,
    private editContext: InlineEditContext,
    private notePath: string,
    private getExternalContexts: () => string[] = () => []
  ) {}

  async openAndWait(): Promise<{ decision: InlineEditDecision; editedText?: string }> {
    if (rejectActiveController()) {
      return { decision: 'reject' };
    }

    // Use the editor/view provided by Obsidian's editorCallback.
    // This avoids timing issues during leaf/view transitions (e.g., navigating via Search in the same tab).
    let editor = this.editor;
    let editorView = getEditorView(editor);

    // Fallback: in rare cases Obsidian may re-initialize the editor between callback and modal open.
    if (!editorView) {
      editor = this.view.editor;
      editorView = getEditorView(editor);
    }

    if (!editorView) {
      new Notice('Inline edit unavailable: could not access the active editor. Try reopening the note.');
      return { decision: 'reject' };
    }

    const providerContext = resolveInlineEditProviderContext(this.plugin);
    try {
      await ProviderWorkspaceRegistry.ensureInitialized(
        this.plugin.providerHost,
        providerContext.providerId,
        'inline-edit',
      );
    } catch {
      new Notice(`Inline edit unavailable: failed to initialize the ${providerContext.providerId} provider.`);
      return { decision: 'reject' };
    }

    if (rejectActiveController()) {
      return { decision: 'reject' };
    }

    return new Promise((resolve) => {
      this.controller = new InlineEditSession(
        this.app,
        this.plugin,
        editorView,
        editor,
        this.editContext,
        this.notePath,
        this.getExternalContexts,
        resolve,
        providerContext,
      );
      activeController = this.controller;
      this.controller.show();
    });
  }
}

export class InlineEditSession {
  private inputEl: HTMLInputElement | null = null;
  private spinnerEl: HTMLElement | null = null;
  private modelToolbarEl: HTMLElement | null = null;
  private agentReplyEl: HTMLElement | null = null;
  private containerEl: HTMLElement | null = null;
  private editedText: string | null = null;
  private insertedText: string | null = null;
  private selFrom = 0;
  private selTo = 0;
  private selectedText: string;
  private startLine: number = 0; // 1-indexed
  private mode: InlineEditMode;
  private cursorContext: CursorContext | null = null;
  private inlineEditService: InlineEditService;
  /** Removes the current phase's Escape/Enter listener. */
  private releaseKeyHandler: (() => void) | null = null;
  private selectionListener: ((e: Event) => void) | null = null;
  private isConversing = false;
  private resolvedProviderId: ProviderId;
  private slashCommandDropdown: SlashCommandDropdown | null = null;
  private mentionDropdown: MentionDropdownController | null = null;
  private mentionDataProvider: VaultMentionDataProvider;
  private agentReplyRenderVersion = 0;
  private sourceSnapshot: InlineEditSourceSnapshot | null = null;
  private settled = false;
  private generation = 0;
  private generating = false;

  private modelOverride: string | undefined;
  private reasoningOverride: string | undefined;
  private inputResources: {
    container: HTMLElement;
    modelSelector: ModelSelector;
    thinkingSelector: ThinkingSelector;
    menuLayer: HTMLElement;
    dispose(): void;
  } | null = null;

  constructor(
    private app: App,
    private plugin: InlineEditHost,
    private editorView: EditorView,
    private editor: Editor,
    editContext: InlineEditContext,
    private notePath: string,
    private getExternalContexts: () => string[] = () => [],
    private resolve: (result: { decision: InlineEditDecision; editedText?: string }) => void,
    providerContext?: InlineEditProviderContext,
  ) {
    const resolvedProviderContext = providerContext ?? resolveInlineEditProviderContext(plugin);
    const providerId = resolvedProviderContext.providerId;
    this.inlineEditService = ProviderRegistry.createInlineEditService(
      plugin.providerHost,
      providerId,
    );
    this.modelOverride = resolvedProviderContext.modelOverride;
    this.reasoningOverride = resolvedProviderContext.reasoningOverride;
    this.inlineEditService.setModelOverride?.(this.modelOverride);
    this.inlineEditService.setReasoningOverride?.(this.reasoningOverride);
    this.resolvedProviderId = providerId;
    this.mentionDataProvider = new VaultMentionDataProvider(this.app, {
      onFileLoadError: () => {
        new Notice('Failed to load vault files. Vault @-mentions may be unavailable.');
      },
    });
    this.mentionDataProvider.initializeInBackground();
    this.mode = editContext.mode;
    if (editContext.mode === 'cursor') {
      this.cursorContext = editContext.cursorContext;
      this.selectedText = '';
    } else {
      this.selectedText = editContext.selectedText;
    }

    this.updatePositionsFromEditor();
  }

  getOwnerDocument(): Document {
    return this.editorView.dom.ownerDocument ?? window.document;
  }

  private updatePositionsFromEditor() {
    const doc = this.editorView.state.doc;

    if (this.mode === 'cursor') {
      const ctx = this.cursorContext as CursorContext;
      const line = doc.line(ctx.line + 1);
      this.selFrom = line.from + ctx.column;
      this.selTo = this.selFrom;
    } else {
      const from = this.editor.getCursor('from');
      const to = this.editor.getCursor('to');
      const fromLine = doc.line(from.line + 1);
      const toLine = doc.line(to.line + 1);
      this.selFrom = fromLine.from + from.ch;
      this.selTo = toLine.from + to.ch;
      this.selectedText = this.editor.getSelection() || this.selectedText;
      this.startLine = from.line + 1; // 1-indexed
    }
  }

  show() {
    const needsField = typeof this.editorView.state?.field === 'function'
      ? this.editorView.state.field(inlineEditField, false) === undefined
      : !installedEditors.has(this.editorView);
    if (needsField) {
      this.editorView.dispatch({
        effects: StateEffect.appendConfig.of(inlineEditField),
      });
      installedEditors.add(this.editorView);
    }

    this.updateHighlight();

    if (this.mode === 'selection') {
      this.attachSelectionListeners();
    }

    // !e.isComposing: skip during IME composition (Chinese, Japanese, Korean, etc.)
    // Bubble phase, so the instruction's suggestion dropdown and mention dropdown close on Escape first.
    const ownerDocument = this.getOwnerDocument();
    const onKeydown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.isComposing && this.isKeyboardEventInContext(e)) {
        this.reject();
      }
    };
    ownerDocument.addEventListener('keydown', onKeydown);
    this.releaseKeyHandler = () => ownerDocument.removeEventListener('keydown', onKeydown);
  }

  private updateHighlight() {
    const doc = this.editorView.state.doc;
    const line = doc.lineAt(this.selFrom);
    const isInbetween = this.mode === 'cursor' && this.cursorContext?.isInbetween;

    this.editorView.dispatch({
      effects: showInlineEdit.of({
        inputPos: isInbetween ? this.selFrom : line.from,
        selFrom: this.selFrom,
        selTo: this.selTo,
        widget: this,
        isInbetween,
      }),
    });
    this.updateSelectionHighlight();
  }

  private updateSelectionHighlight(): void {
    if (this.mode === 'selection' && this.selFrom !== this.selTo) {
      showSelectionHighlight(this.editorView, this.selFrom, this.selTo);
    } else {
      hideSelectionHighlight(this.editorView);
    }
  }

  private attachSelectionListeners() {
    this.removeSelectionListeners();
    this.selectionListener = (e: Event) => {
      const target = e.target as Node | null;
      if (target && this.inputEl && (target === this.inputEl || this.inputEl.contains(target))) {
        return;
      }
      const prevFrom = this.selFrom;
      const prevTo = this.selTo;
      const newSelection = this.editor.getSelection();
      if (newSelection && newSelection.length > 0) {
        this.updatePositionsFromEditor();
        if (prevFrom !== this.selFrom || prevTo !== this.selTo) {
          this.updateHighlight();
        }
      }
    };
    this.editorView.dom.addEventListener('mouseup', this.selectionListener);
    this.editorView.dom.addEventListener('keyup', this.selectionListener);
  }

  destroyInputDOM(container: HTMLElement): void {
    if (this.inputResources?.container !== container) return;
    this.inputResources.dispose();
    this.inputResources = null;
    this.agentReplyRenderVersion += 1;
    this.inputEl = null;
    this.spinnerEl = null;
    this.modelToolbarEl = null;
    this.agentReplyEl = null;
    if (this.containerEl === container) this.containerEl = null;
  }

  createInputDOM(): HTMLElement {
    if (this.inputResources) this.destroyInputDOM(this.inputResources.container);
    const ownerDocument = this.getOwnerDocument();
    const container = createDiv({
      cls: 'codian-inline-input-container',
      attr: { 'data-provider': this.resolvedProviderId },
    });
    this.containerEl = container;

    // The widget root only spaces the card: Obsidian zeroes editor widget margins.
    const cardEl = container.createDiv({ cls: 'codian-inline-composer' });
    this.agentReplyEl = cardEl.createDiv({ cls: 'codian-inline-agent-reply codian-hidden' });

    const inputWrap = cardEl.createDiv({ cls: 'codian-inline-input-wrap' });

    const inputEl = inputWrap.createEl('input', {
      cls: 'codian-inline-input',
      type: 'text',
      attr: {
        placeholder: this.mode === 'cursor' ? 'Insert instructions...' : 'Edit instructions...',
        spellcheck: 'false',
      },
    });
    this.inputEl = inputEl;

    this.spinnerEl = inputWrap.createDiv({ cls: 'codian-inline-spinner codian-hidden' });
    this.modelToolbarEl = inputWrap.createDiv({ cls: 'codian-input-toolbar codian-inline-model-toolbar' });
    const menuLayer = ownerDocument.body.createDiv({
      cls: 'codian-inline-menu-layer',
      attr: { 'data-provider': this.resolvedProviderId },
    });
    const modelSelector = new ModelSelector(this.modelToolbarEl, this.modelPickerCallbacks(), menuLayer);
    const thinkingSelector = new ThinkingSelector(this.modelToolbarEl, this.modelPickerCallbacks(), menuLayer);
    this.showGenerating(this.generating);

    this.setupSlashCommandDropdown();

    this.mentionDropdown = new MentionDropdownController(
      ownerDocument.body,
      this.inputEl,
      {
        // Inline-edit resolves @mentions at send time from input text.
        onAttachFile: () => {},
        onMcpMentionChange: () => {},
        getMentionedMcpServers: () => new Set(),
        setMentionedMcpServers: () => false,
        addMentionedMcpServer: () => {},
        getExternalContexts: this.getExternalContexts,
        getCachedVaultFolders: () => this.mentionDataProvider.getCachedVaultFolders(),
        getCachedVaultFiles: () => this.mentionDataProvider.getCachedVaultFiles(),
        normalizePathForVault: (rawPath) => this.normalizePathForVault(rawPath),
      },
      { fixed: true }
    );

    this.inputEl.addEventListener('keydown', (e) => this.handleKeydown(e));
    this.inputEl.addEventListener('input', () => this.mentionDropdown?.handleInputChange());

    const focusTimer = window.setTimeout(() => {
      const active = ownerDocument.activeElement;
      if (active && (container.contains(active) || menuLayer.contains(active))) return;
      this.inputEl?.focus();
    }, 50);

    this.inputResources = {
      container,
      modelSelector,
      thinkingSelector,
      menuLayer,
      dispose: () => {
        window.clearTimeout(focusTimer);
        modelSelector.destroy();
        thinkingSelector.destroy();
        menuLayer.remove();
        this.slashCommandDropdown?.destroy();
        this.slashCommandDropdown = null;
        this.mentionDropdown?.destroy();
        this.mentionDropdown = null;
      },
    };

    return container;
  }

  private setupSlashCommandDropdown(): void {
    this.slashCommandDropdown?.destroy();
    if (!this.inputEl) return;
    const ownerDocument = this.getOwnerDocument();
    const inlineCatalog = ProviderWorkspaceRegistry.getCommandCatalog(this.resolvedProviderId);
    this.slashCommandDropdown = new SlashCommandDropdown(
      ownerDocument.body,
      this.inputEl,
      {
        onSelect: () => {},
        onHide: () => {},
      },
      {
        fixed: true,
        hiddenCommands: getHiddenProviderCommandSet(this.plugin.settings, this.resolvedProviderId),
        ...(inlineCatalog ? {
          providerConfig: inlineCatalog.getDropdownConfig(),
          providerDiscovery: new ProviderCommandDiscoveryStore(async () =>
            normalizeProviderCommandDiscoveryItems(
              await inlineCatalog.listDropdownEntries({ includeBuiltIns: false }),
            ),
          ),
        } : {}),
      }
    );
  }

  private async switchProvider(newProviderId: ProviderId): Promise<void> {
    if (this.resolvedProviderId === newProviderId) return;

    try {
      await ProviderWorkspaceRegistry.ensureInitialized(
        this.plugin.providerHost,
        newProviderId,
        'inline-edit',
      );
    } catch {
      new Notice(`Failed to initialize ${ProviderRegistry.getProviderDisplayName(newProviderId)} provider.`);
      return;
    }

    this.inlineEditService.cancel();
    this.inlineEditService.resetConversation();
    this.isConversing = false;

    this.resolvedProviderId = newProviderId;
    this.inlineEditService = ProviderRegistry.createInlineEditService(
      this.plugin.providerHost,
      newProviderId,
    );
    if (this.containerEl) {
      this.containerEl.setAttribute('data-provider', newProviderId);
    }
    if (this.inputResources?.menuLayer) {
      this.inputResources.menuLayer.setAttribute('data-provider', newProviderId);
    }

    this.setupSlashCommandDropdown();
  }

  private modelPickerCallbacks(): ModelPickerCallbacks {
    return {
      getSettings: () => this.getModelPickerSettings(),
      getAvailableModels: () => getAllEnabledProviderModelOptions(
        this.plugin.settings,
        (providerId) => typeof this.plugin.getActiveEnvironmentVariables === 'function'
          ? this.plugin.getActiveEnvironmentVariables(providerId)
          : '',
      ),
      onModelChange: async (model, providerId) => {
        const targetProviderId = providerId
          ?? getEnabledProviderForModel(model, this.plugin.settings, this.resolvedProviderId);

        if (targetProviderId !== this.resolvedProviderId) {
          await this.switchProvider(targetProviderId);
        }

        this.modelOverride = model;
        const settings = this.getModelPickerSettings();
        const offered = ProviderRegistry.getChatUIConfig(this.resolvedProviderId)
          .getReasoningOptions(settings.model, settings)
          .some(option => option.value === this.reasoningOverride);
        if (!offered) {
          this.reasoningOverride = undefined;
        }

        this.inlineEditService.setModelOverride?.(this.modelOverride);
        this.inlineEditService.setReasoningOverride?.(this.reasoningOverride);

        this.inputResources?.modelSelector.updateDisplay();
        this.inputResources?.thinkingSelector.updateDisplay();
        await this.saveInlineEditDefault();
      },
      onEffortLevelChange: async (effort) => {
        this.reasoningOverride = effort;
        this.inlineEditService.setReasoningOverride?.(this.reasoningOverride);
        this.inputResources?.modelSelector.updateDisplay();
        this.inputResources?.thinkingSelector.updateDisplay();
        await this.saveInlineEditDefault();
      },
    };
  }

  private async saveInlineEditDefault(): Promise<void> {
    const { model, reasoning } = this.getModelPickerSettings();
    if (!model) return;
    const selection: StoredInlineEditModelSelection = {
      providerId: this.resolvedProviderId,
      model,
      ...(reasoning ? { reasoning } : {}),
    };
    if (typeof this.plugin.mutateSettings === 'function') {
      await this.plugin.mutateSettings((settings) => {
        settings.inlineEditModel = selection;
      });
    } else if (this.plugin.settings) {
      this.plugin.settings.inlineEditModel = selection;
    }
  }

  private getModelPickerSettings(): ModelPickerSettings {
    const snapshot = getProviderSettingsSnapshotWithModel(
      { ...this.plugin.settings },
      this.resolvedProviderId,
      this.modelOverride,
    );
    const model = typeof snapshot.model === 'string' && snapshot.model
      ? snapshot.model
      : (this.modelOverride || '');
    const offersReasoning = ProviderRegistry.getChatUIConfig(this.resolvedProviderId)
      .getReasoningOptions(model, snapshot).length > 0;
    const reasoning = this.reasoningOverride
      ?? (typeof snapshot.effortLevel === 'string' ? snapshot.effortLevel : null);
    return {
      ...snapshot,
      providerId: this.resolvedProviderId,
      model,
      reasoning: offersReasoning && reasoning ? reasoning : null,
    };
  }

  private showGenerating(generating: boolean): void {
    if (this.inputEl) this.inputEl.disabled = generating;
    if (generating) {
      this.inputResources?.modelSelector.close();
      this.inputResources?.thinkingSelector.close();
    }
    this.spinnerEl?.toggleClass('codian-hidden', !generating);
    this.modelToolbarEl?.toggleClass('codian-hidden', generating);
  }

  createDiffPreviewDOM(diffOps: DiffOp[]): HTMLElement {
    const previewEl = createDiv({ cls: 'codian-inline-diff-preview' });
    this.containerEl = previewEl;

    const bodyEl = previewEl.createDiv({ cls: 'codian-inline-diff-preview-body markdown-rendered' });

    const actionsEl = previewEl.createDiv({ cls: 'codian-inline-preview-actions' });
    actionsEl.setAttribute('role', 'toolbar');
    actionsEl.setAttribute('aria-label', 'Inline edit actions');
    const statsEl = actionsEl.createDiv({ cls: 'codian-inline-diff-stats' });
    const removed = countDiffLines(diffOps, 'delete');
    const added = countDiffLines(diffOps, 'insert');
    if (removed > 0) statsEl.createSpan({ cls: 'codian-inline-diff-stat-del', text: `−${removed}` });
    if (added > 0) statsEl.createSpan({ cls: 'codian-inline-diff-stat-ins', text: `+${added}` });
    statsEl.createSpan({ text: removed + added === 1 ? 'line' : 'lines' });
    actionsEl.appendChild(this.createPreviewActionButton('Reject', 'reject', 'Esc', () => this.reject()));
    actionsEl.appendChild(this.createPreviewActionButton('Accept', 'accept', '↵', () => this.accept()));

    void this.renderMarkdownDiffPreview(bodyEl, diffOps);
    return previewEl;
  }

  private createPreviewActionButton(
    label: string,
    variant: 'accept' | 'reject',
    keyHint: string,
    onClick: () => void
  ): HTMLButtonElement {
    const button = createEl('button', {
      cls: `codian-inline-preview-action ${variant}`,
      type: 'button',
      text: label,
      attr: {
        'aria-label': `${label} inline edit`,
        title: variant === 'accept' ? 'Accept (enter)' : 'Reject (esc)',
        'aria-keyshortcuts': variant === 'accept' ? 'Enter' : 'Escape',
      },
    });
    button.createEl('kbd', { cls: 'codian-inline-preview-key', text: keyHint, attr: { 'aria-hidden': 'true' } });
    button.addEventListener('click', (event: MouseEvent) => {
      event.preventDefault?.();
      event.stopPropagation?.();
      onClick();
    });
    return button;
  }

  private async renderMarkdownPreview(container: HTMLElement, markdown: string): Promise<void> {
    await renderInlineEditMarkdownPreview({
      app: this.app,
      component: this.plugin,
      container,
      markdown,
      sourcePath: this.notePath,
      mediaFolder: this.plugin.settings?.mediaFolder ?? '',
    });
  }

  private async renderMarkdownDiffPreview(container: HTMLElement, diffOps: DiffOp[]): Promise<void> {
    container.empty();
    for (const document of buildMarkdownDiffDocuments(diffOps)) {
      if (!document.markdown) continue;

      const opEl = container.createDiv({ cls: `codian-diff-block ${getDiffBlockClass(document.type)}` });
      await this.renderMarkdownPreview(opEl, document.markdown);
    }
  }

  private replaceRenderedPreview(target: HTMLElement, rendered: HTMLElement): void {
    target.empty();

    if (rendered.childNodes) {
      for (const child of Array.from(rendered.childNodes)) {
        target.appendChild(child);
      }
      return;
    }

    for (const child of Array.from(rendered.children)) {
      target.appendChild(child);
    }
  }

  private async generate(): Promise<void> {
    if (this.settled || !this.inputEl || !this.spinnerEl) return;
    const userMessage = this.inputEl.value.trim();
    if (!userMessage) return;
    const generation = ++this.generation;

    const sourceDoc = this.editorView.state.doc;
    this.sourceSnapshot = {
      doc: sourceDoc,
      from: this.selFrom,
      text: this.getDocumentSlice(sourceDoc, this.selFrom, this.selTo),
      to: this.selTo,
    };

    // Slash commands are passed directly to SDK for handling

    this.removeSelectionListeners();

    this.generating = true;
    this.showGenerating(true);

    const { model, reasoning } = this.getModelPickerSettings();
    this.inlineEditService.setModelOverride?.(model || undefined);
    this.inlineEditService.setReasoningOverride?.(reasoning || undefined);

    const contextFiles = this.resolveContextFilesFromMessage(userMessage);

    let result;
    try {
      if (this.isConversing) {
        result = await this.inlineEditService.continueConversation(userMessage, contextFiles);
      } else {
        if (this.mode === 'cursor') {
          result = await this.inlineEditService.editText({
            mode: 'cursor',
            instruction: userMessage,
            notePath: this.notePath,
            cursorContext: this.cursorContext as CursorContext,
            contextFiles,
          });
        } else {
          const lineCount = this.selectedText.split(/\r?\n/).length;
          result = await this.inlineEditService.editText({
            mode: 'selection',
            instruction: userMessage,
            notePath: this.notePath,
            selectedText: this.selectedText,
            startLine: this.startLine,
            lineCount,
            contextFiles,
          });
        }
      }
    } catch (error) {
      if (this.isGenerationActive(generation)) {
        this.handleError(error instanceof Error ? error.message : 'Error - try again');
      }
      return;
    } finally {
      if (this.isGenerationActive(generation)) {
        this.generating = false;
        this.showGenerating(false);
      }
    }

    if (!this.isGenerationActive(generation)) {
      return;
    }
    if (!this.isSourceUnchanged()) {
      this.rejectStaleSource();
      return;
    }

    if (result.success) {
      if (result.editedText !== undefined) {
        this.editedText = result.editedText;
        this.showDiffInPlace();
      } else if (result.insertedText !== undefined) {
        this.insertedText = result.insertedText;
        this.showInsertionInPlace();
      } else if (result.clarification) {
        this.showAgentReply(result.clarification);
        this.isConversing = true;
        this.inputEl.disabled = false;
        this.inputEl.value = '';
        this.inputEl.placeholder = 'Reply to continue...';
        this.inputEl.focus();
      } else {
        this.handleError('No response from agent');
      }
    } else {
      this.handleError(result.error || 'Error - try again');
    }
  }

  private showAgentReply(message: string) {
    if (!this.agentReplyEl || !this.containerEl) return;
    const replyEl = this.agentReplyEl;
    const renderVersion = ++this.agentReplyRenderVersion;
    const renderedEl = this.agentReplyEl.createDiv();

    replyEl.removeClass('codian-hidden');
    replyEl.empty();
    void this.renderMarkdownPreview(renderedEl, message).then(() => {
      if (renderVersion !== this.agentReplyRenderVersion || replyEl !== this.agentReplyEl) {
        return;
      }
      this.replaceRenderedPreview(replyEl, renderedEl);
    });
    this.containerEl.classList.add('has-agent-reply');
  }

  private handleError(errorMessage: string) {
    if (!this.inputEl) return;
    this.inputEl.disabled = false;
    this.inputEl.placeholder = errorMessage;
    this.updatePositionsFromEditor();
    this.updateHighlight();
    this.attachSelectionListeners();
    this.inputEl.focus();
  }

  private showDiffInPlace() {
    if (this.editedText === null) return;

    hideSelectionHighlight(this.editorView);

    const diffOps = computeMarkdownDiff(this.selectedText, this.editedText);
    const previewPos = this.editorView.state.doc.lineAt(this.selFrom).from;

    this.editorView.dispatch({
      effects: showDiff.of({
        from: this.selFrom,
        to: this.selTo,
        diffOps,
        previewPos,
        widget: this,
      }),
    });

    this.installAcceptRejectHandler();
  }

  private showInsertionInPlace() {
    if (this.insertedText === null) return;

    hideSelectionHighlight(this.editorView);

    const trimmedText = normalizeInsertionText(this.insertedText);
    this.insertedText = trimmedText;

    const diffOps: DiffOp[] = [{ type: 'insert', text: trimmedText }];
    const previewPos = this.editorView.state.doc.lineAt(this.selFrom).from;

    this.editorView.dispatch({
      effects: showInsertion.of({
        diffOps,
        previewPos,
        widget: this,
      }),
    });

    this.installAcceptRejectHandler();
  }

  /**
   * Window capture runs ahead of CodeMirror, which would insert a newline on Enter and so turn the
   * accept into a stale-source rejection, and ahead of Obsidian's keymap, which handles Escape.
   */
  private installAcceptRejectHandler() {
    this.releaseKeyHandler?.();
    const ownerDocument = this.getOwnerDocument();
    const keyTarget: EventTarget | null =
      (ownerDocument.defaultView && typeof ownerDocument.defaultView.addEventListener === 'function')
        ? ownerDocument.defaultView
        : (typeof window !== 'undefined' && typeof window.addEventListener === 'function')
        ? window
        : (typeof ownerDocument.addEventListener === 'function')
        ? ownerDocument
        : null;
    const onKeydown: EventListener = (event) => {
      const e = event as KeyboardEvent;
      if (e.isComposing || !this.isKeyboardEventInContext(e)) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        this.reject();
      } else if (e.key === 'Enter' && !this.containerEl?.contains(e.target as Node)) {
        // Preview controls keep their native Enter activation.
        e.preventDefault();
        e.stopPropagation();
        this.accept();
      }
    };
    if (keyTarget) {
      keyTarget.addEventListener('keydown', onKeydown, true);
      this.releaseKeyHandler = () => keyTarget.removeEventListener('keydown', onKeydown, true);
    }
  }

  accept() {
    if (this.settled) {
      return;
    }
    const textToInsert = this.editedText ?? this.insertedText;
    if (textToInsert !== null) {
      if (!this.isSourceUnchanged()) {
        this.rejectStaleSource();
        return;
      }
      // Convert CM6 positions back to Obsidian Editor positions
      const doc = this.editorView.state.doc;
      const fromLine = doc.lineAt(this.selFrom);
      const toLine = doc.lineAt(this.selTo);
      const from = { line: fromLine.number - 1, ch: this.selFrom - fromLine.from };
      const to = { line: toLine.number - 1, ch: this.selTo - toLine.from };

      this.settled = true;
      this.cleanup();
      this.editor.replaceRange(textToInsert, from, to);
      this.focusEditor();
      this.resolve({ decision: 'accept', editedText: textToInsert });
    } else {
      this.settled = true;
      this.cleanup();
      this.resolve({ decision: 'reject' });
    }
  }

  reject() {
    if (this.settled) {
      return;
    }
    this.settled = true;
    this.cleanup({ keepSelectionHighlight: true });
    this.restoreSelectionHighlight();
    this.focusEditor();
    this.resolve({ decision: 'reject' });
  }

  private removeSelectionListeners() {
    if (this.selectionListener) {
      this.editorView.dom.removeEventListener('mouseup', this.selectionListener);
      this.editorView.dom.removeEventListener('keyup', this.selectionListener);
      this.selectionListener = null;
    }
  }

  private cleanup(options?: { keepSelectionHighlight?: boolean }) {
    this.generation += 1;
    this.generating = false;
    this.inlineEditService.cancel();
    this.inlineEditService.resetConversation();
    this.isConversing = false;
    this.removeSelectionListeners();
    this.releaseKeyHandler?.();
    this.releaseKeyHandler = null;
    if (this.inputResources) {
      this.destroyInputDOM(this.inputResources.container);
    }
    this.slashCommandDropdown?.destroy();
    this.slashCommandDropdown = null;

    this.mentionDropdown?.destroy();
    this.mentionDropdown = null;

    if (activeController === this) {
      activeController = null;
    }
    this.editorView.dispatch({
      effects: hideInlineEdit.of(null),
    });
    if (!options?.keepSelectionHighlight) {
      hideSelectionHighlight(this.editorView);
    }
  }

  private restoreSelectionHighlight(): void {
    if (this.mode !== 'selection' || this.selFrom === this.selTo) {
      return;
    }
    showSelectionHighlight(this.editorView, this.selFrom, this.selTo);
  }

  private isSourceUnchanged(): boolean {
    const snapshot = this.sourceSnapshot;
    if (!snapshot) {
      return false;
    }

    const currentDoc = this.editorView.state.doc;
    const currentLength = typeof currentDoc.length === 'number'
      ? currentDoc.length
      : Number.POSITIVE_INFINITY;
    return currentDoc === snapshot.doc
      && snapshot.from >= 0
      && snapshot.to >= snapshot.from
      && snapshot.to <= currentLength
      && this.getDocumentSlice(currentDoc, snapshot.from, snapshot.to) === snapshot.text;
  }

  private isGenerationActive(generation: number): boolean {
    return !this.settled && generation === this.generation;
  }

  private rejectStaleSource(): void {
    if (this.settled) {
      return;
    }
    new Notice('Inline edit was not applied because the source document or selection changed.');
    this.settled = true;
    this.cleanup();
    this.focusEditor();
    this.resolve({ decision: 'reject' });
  }

  private getDocumentSlice(doc: Text, from: number, to: number): string {
    const sliceString = (doc as Text & { sliceString?: (start: number, end: number) => string }).sliceString;
    if (typeof sliceString === 'function') {
      return sliceString.call(doc, from, to);
    }
    return from === this.selFrom && to === this.selTo ? this.selectedText : '';
  }

  /** Keys aimed at the editor, this widget, or nowhere: a disabled or replaced input leaves focus on the body. */
  private isKeyboardEventInContext(event: KeyboardEvent): boolean {
    const target = event.target as Node | null;
    if (!target) {
      return false;
    }
    return target === this.getOwnerDocument().body
      || target === this.containerEl
      || this.containerEl?.contains(target) === true
      || target === this.editorView.dom
      || this.editorView.dom.contains(target);
  }

  private focusEditor(): void {
    const focus = (this.editorView as EditorView & { focus?: () => void }).focus;
    focus?.call(this.editorView);
  }

  private handleKeydown(e: KeyboardEvent) {
    if (this.mentionDropdown?.handleKeydown(e)) {
      return;
    }

    if (this.slashCommandDropdown?.handleKeydown(e)) {
      return;
    }

    if (e.key === 'Enter' && !e.isComposing) {
      e.preventDefault();
      void this.generate();
    }
  }

  private normalizePathForVault(rawPath: string | undefined | null): string | null {
    try {
      const vaultPath = getVaultPath(this.app);
      return normalizePathForVaultUtil(rawPath, vaultPath);
    } catch {
      new Notice('Failed to attach file: invalid path');
      return null;
    }
  }

  private resolveContextFilesFromMessage(message: string): string[] {
    if (!message.includes('@')) return [];

    const vaultFiles = this.mentionDataProvider.getCachedVaultFiles();

    const pathLookup = new Map<string, string>();
    for (const file of vaultFiles) {
      const normalized = this.normalizePathForVault(file.path);
      if (!normalized) continue;
      const lookupKey = normalizeForPlatformLookup(normalizeMentionPath(normalized));
      if (!pathLookup.has(lookupKey)) {
        pathLookup.set(lookupKey, normalized);
      }
    }

    const resolved = new Set<string>();
    const externalEntries = buildExternalContextDisplayEntries(this.getExternalContexts())
      .sort((a, b) => b.displayNameLower.length - a.displayNameLower.length);
    const getExternalLookup = createExternalContextLookupGetter(
      contextRoot => externalContextScanner.scanPaths([contextRoot])
    );

    for (let index = 0; index < message.length; index++) {
      if (!isMentionStart(message, index)) continue;

      const externalMatch = resolveExternalMentionAtIndex(
        message, index, externalEntries, getExternalLookup
      );
      if (externalMatch) {
        resolved.add(externalMatch.resolvedPath);
        index = externalMatch.endIndex - 1;
        continue;
      }

      const vaultMatch = findBestMentionLookupMatch(
        message, index + 1, pathLookup, normalizeMentionPath, normalizeForPlatformLookup
      );
      if (vaultMatch) {
        resolved.add(vaultMatch.resolvedPath);
        index = vaultMatch.endIndex - 1;
      }
    }

    return [...resolved];
  }

}
