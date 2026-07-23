import type { App } from 'obsidian';

export interface VaultContextReference {
  path: string;
  kind: 'file' | 'folder';
}

export interface ComposerSession {
  readonly focusTargetEl: HTMLElement;
  onDraftConsumed(): void;
  onConversationReset(): void;
  destroy(): void;
}

export interface ComposerEnhancementContext {
  app: App;
  sourceEl: HTMLTextAreaElement;
  inputWrapperEl: HTMLElement;
  dropZoneEl: HTMLElement;
  initialReferences: readonly VaultContextReference[];
  onReferencesDropped(references: readonly VaultContextReference[]): void;
  onOpenReference(reference: VaultContextReference): void;
  setReferenceSink(sink: ((references: readonly VaultContextReference[]) => void) | null): void;
}

export interface ComposerEnhancement {
  mount(context: ComposerEnhancementContext): ComposerSession;
}
