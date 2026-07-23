import { setIcon } from 'obsidian';

import type { Conversation } from '../../../core/types';
import { t } from '../../../i18n/i18n';
import { extractUserDisplayContent } from '../../../utils/context';
import type {
  ConversationBrowserEnhancement,
  ConversationBrowserRenderContext,
  ConversationBrowserSession,
} from './types';

function renderMatch(container: HTMLElement, text: string, normalizedQuery: string): void {
  const matchIndex = text.toLocaleLowerCase().indexOf(normalizedQuery);
  if (matchIndex < 0) {
    container.setText(text);
    return;
  }

  if (matchIndex > 0) container.createSpan({ text: text.slice(0, matchIndex) });
  container.createSpan({
    cls: 'claudian-history-match',
    text: text.slice(matchIndex, matchIndex + normalizedQuery.length),
  });
  if (matchIndex + normalizedQuery.length < text.length) {
    container.createSpan({ text: text.slice(matchIndex + normalizedQuery.length) });
  }
}

class SearchConversationBrowserSession implements ConversationBrowserSession {
  private query = '';
  private highlightedConversationId: string | null = null;

  reset(): void {
    this.query = '';
    this.highlightedConversationId = null;
  }

  render(context: ConversationBrowserRenderContext): void {
    const search = context.header.createDiv({ cls: 'claudian-history-search' });
    search.addEventListener('click', event => event.stopPropagation());
    const input = search.createEl('input', {
      cls: 'claudian-history-search-input',
      attr: { type: 'search', placeholder: t('chat.historySearch.placeholder') },
    });
    input.value = this.query;

    const rerenderAndFocus = () => {
      context.rerender();
      const nextInput = context.container.querySelector<HTMLInputElement>('.claudian-history-search-input');
      nextInput?.focus();
      nextInput?.setSelectionRange?.(nextInput.value.length, nextInput.value.length);
    };

    const commitQuery = () => {
      this.query = input.value;
      this.highlightedConversationId = null;
      rerenderAndFocus();
    };
    let isComposing = false;
    input.addEventListener('compositionstart', () => {
      isComposing = true;
    });
    input.addEventListener('compositionend', () => {
      isComposing = false;
      commitQuery();
    });
    input.addEventListener('input', event => {
      if (isComposing || event.isComposing) return;
      commitQuery();
    });
    input.addEventListener('keydown', event => {
      if (isComposing || event.isComposing) return;
      if (event.key !== 'Escape') return;
      event.preventDefault();
      if (this.query.length > 0) {
        this.reset();
        rerenderAndFocus();
      } else {
        this.reset();
        context.close();
      }
    });

    const clearButton = search.createEl('button', {
      cls: 'claudian-history-search-clear',
      attr: { 'aria-label': t('chat.historySearch.clear'), type: 'button' },
    });
    setIcon(clearButton, 'x');
    clearButton.addEventListener('click', event => {
      event.stopPropagation();
      this.reset();
      rerenderAndFocus();
    });

    const normalizedQuery = this.query.trim().toLocaleLowerCase();
    const conversations = context.conversations.filter(conversation => (
      normalizedQuery.length === 0
      || conversation.title.toLocaleLowerCase().includes(normalizedQuery)
      || (conversation.preview ?? '').toLocaleLowerCase().includes(normalizedQuery)
    ));
    const actionableIds = context.getActionableConversationIds(conversations);
    if (!this.highlightedConversationId
      || !actionableIds.includes(this.highlightedConversationId)) {
      this.highlightedConversationId = actionableIds[0] ?? null;
    }

    input.addEventListener('keydown', event => {
      if (isComposing || event.isComposing) return;
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        if (actionableIds.length === 0) return;
        const currentIndex = actionableIds.indexOf(this.highlightedConversationId ?? '');
        const direction = event.key === 'ArrowDown' ? 1 : -1;
        const nextIndex = currentIndex < 0
          ? 0
          : (currentIndex + direction + actionableIds.length) % actionableIds.length;
        this.highlightedConversationId = actionableIds[nextIndex];
        rerenderAndFocus();
      } else if (event.key === 'Enter' && this.highlightedConversationId) {
        event.preventDefault();
        context.selectConversation(this.highlightedConversationId);
      }
    });

    context.renderList({
      conversations,
      emptyText: t('chat.historySearch.noMatches'),
      highlightedConversationId: this.highlightedConversationId,
      renderTitle: (container, conversation) => {
        if (normalizedQuery.length > 0) renderMatch(container, conversation.title, normalizedQuery);
        else container.setText(conversation.title);
      },
      renderPreview: (container, conversation) => {
        if (normalizedQuery.length === 0 || !conversation.preview) return;
        const preview = container.createDiv({ cls: 'claudian-history-item-preview' });
        renderMatch(preview, conversation.preview, normalizedQuery);
      },
    });

    if (context.container.hasClass('visible')) {
      input.focus();
      input.setSelectionRange?.(input.value.length, input.value.length);
    }
  }
}

export class SearchConversationBrowserEnhancement implements ConversationBrowserEnhancement {
  createSession(): ConversationBrowserSession {
    return new SearchConversationBrowserSession();
  }

  createPreview(conversation: Conversation): string | undefined {
    const firstUserMessage = conversation.messages.find(message => message.role === 'user');
    if (!firstUserMessage) return conversation.preview;

    const text = firstUserMessage.displayContent
      ?? extractUserDisplayContent(firstUserMessage.content)
      ?? firstUserMessage.content;
    return text.substring(0, 50) + (text.length > 50 ? '...' : '');
  }
}
