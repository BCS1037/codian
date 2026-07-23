import type { Conversation, ConversationMeta } from '../../../core/types';

export interface ConversationBrowserListPresentation {
  conversations: ConversationMeta[];
  emptyText: string;
  highlightedConversationId: string | null;
  renderTitle(container: HTMLElement, conversation: ConversationMeta): void;
  renderPreview(container: HTMLElement, conversation: ConversationMeta): void;
}

export interface ConversationBrowserRenderContext {
  container: HTMLElement;
  header: HTMLElement;
  conversations: ConversationMeta[];
  rerender(): void;
  close(): void;
  selectConversation(id: string): void;
  getActionableConversationIds(conversations: ConversationMeta[]): string[];
  renderList(presentation: ConversationBrowserListPresentation): void;
}

export interface ConversationBrowserSession {
  render(context: ConversationBrowserRenderContext): void;
  reset(): void;
}

export interface ConversationBrowserEnhancement {
  createSession(): ConversationBrowserSession;
  createPreview(conversation: Conversation): string | undefined;
}
