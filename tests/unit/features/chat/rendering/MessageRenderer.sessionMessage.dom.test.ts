/** @jest-environment jsdom */
import { Component, MarkdownRenderer, Notice } from 'obsidian';

import { encodeSessionMessage } from '@/core/session-tools/sessionMessageEnvelope';
import type { ChatMessage, Conversation } from '@/core/types';
import { MessageRenderer } from '@/features/chat/rendering/MessageRenderer';

HTMLElement.prototype.empty = function () { this.replaceChildren(); };

describe('MessageRenderer session message sender', () => {
  it.each(['live', 'history'])('shows the sender safely in %s and keeps the envelope out of the body', async (mode) => {
    document.body.replaceChildren();
    const host = document.body.createDiv();
    const records = new Map([['source-session', { id: 'source-session', title: 'Source Session', providerId: 'claude' } as Conversation]]);
    const openConversation = jest.fn(async (_id: string) => undefined);
    const renderer = new MessageRenderer(
      {
        app: {},
        settings: { mediaFolder: '' },
        getCachedConversation: (id: string) => records.get(id) ?? null,
        getConversationList: () => Array.from(records.values()),
      } as any,
      new Component(),
      host,
      undefined,
      undefined,
      undefined,
      undefined,
      openConversation,
    );
    jest.mocked(MarkdownRenderer.render).mockImplementation(async (_app, markdown, el) => {
      el.textContent = markdown;
    });

    const sender = { from: 'Research Session', sessionId: 'source-session' };
    const message: ChatMessage = {
      id: 'incoming',
      role: 'user',
      timestamp: Date.now(),
      content: encodeSessionMessage({ ...sender, text: 'Please check the results.' }),
      sessionMessage: sender,
    };
    const ordinary: ChatMessage = {
      id: 'ordinary',
      role: 'user',
      timestamp: Date.now(),
      content: 'My own prompt.',
    };

    try {
      if (mode === 'live') {
        renderer.addMessage(message);
        renderer.addMessage(ordinary);
      } else {
        renderer.renderMessages([message, ordinary], () => 'Hello');
      }
      await Promise.resolve();

      const senderLine = host.querySelector<HTMLElement>('.codian-session-message-sender')!;
      expect(senderLine).not.toBeNull();
      expect(senderLine.textContent).toContain('Research Session');

      const badge = senderLine.querySelector<HTMLButtonElement>('button.codian-session-link')!;
      expect(badge).not.toBeNull();
      expect(badge.textContent).toBe(sender.from);
      expect(badge.getAttribute('type')).toBe('button');
      expect(badge.getAttribute('title')).toContain('source-session');

      // The rendered body contains only the message text, not the XML envelope
      expect(host.textContent).toContain('Please check the results.');
      expect(host.textContent).not.toContain('<session_message');
      expect(host.textContent).toContain('My own prompt.');

      // Ordinary message has no session message sender line
      const ordinaryMsg = host.querySelector('[data-message-id="ordinary"]');
      expect(ordinaryMsg?.querySelector('.codian-session-message-sender')).toBeNull();

      // Clicking link triggers openConversation
      badge.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      expect(openConversation).toHaveBeenCalledWith('source-session');

      // When sender session is gone:
      records.delete('source-session');
      renderer.addMessage({ ...message, id: 'incoming-again' });
      const newMsg = host.querySelector<HTMLElement>('[data-message-id="incoming-again"]')!;
      const staleBadge = newMsg.querySelector<HTMLButtonElement>('button.codian-session-link')!;
      jest.mocked(Notice).mockClear();
      staleBadge.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      expect(Notice).toHaveBeenCalledWith('That session no longer exists.');
    } finally {
      renderer.dispose();
    }
  });
});
