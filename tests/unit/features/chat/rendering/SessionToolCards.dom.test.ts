/** @jest-environment jsdom */
import {
  renderListDestinationsContent,
  renderReadSessionContent,
  renderSendMessageContent,
} from '@/features/chat/rendering/sessionToolContent';

HTMLElement.prototype.empty = function () { this.replaceChildren(); };

describe('SessionToolCards', () => {
  let container: HTMLElement;

  beforeEach(() => {
    document.body.replaceChildren();
    container = document.body.createDiv();
  });

  describe('renderListDestinationsContent', () => {
    it('renders empty sessions state', () => {
      renderListDestinationsContent(container, {
        input: {},
        result: JSON.stringify({ sessions: [] }),
      });

      const emptyEl = container.querySelector('.codian-tool-empty');
      expect(emptyEl).not.toBeNull();
      expect(emptyEl?.textContent).toBe('No sessions');
    });

    it('renders destinations list with self badge and links', () => {
      renderListDestinationsContent(container, {
        input: {},
        result: JSON.stringify({
          sessions: [
            { sessionId: 'conv-1', title: 'Session One', self: true },
            { sessionId: 'conv-2', title: 'Session Two', self: false },
          ],
          truncated: true,
          providers: [{ provider: 'claude' }],
        }),
      });

      const rows = container.querySelectorAll('.codian-session-tool-row');
      expect(rows).toHaveLength(2);

      // Self row has badge and plain title span
      expect(rows[0].querySelector('.codian-session-tool-badge--self')?.textContent).toBe('This session');
      expect(rows[0].querySelector('button.codian-session-link')).toBeNull();

      // Other row has link button
      const link = rows[1].querySelector('button.codian-session-link');
      expect(link).not.toBeNull();
      expect(link?.textContent).toBe('Session Two');
      expect(link?.getAttribute('data-codian-open-session')).toBe('conv-2');

      // Notes
      const notes = container.querySelectorAll('.codian-session-tool-note');
      expect(notes).toHaveLength(2);
      expect(notes[0].textContent).toBe('More sessions not shown');
      expect(notes[1].textContent).toBe('Included available providers and models');
    });
  });

  describe('renderSendMessageContent', () => {
    it('renders send result with recipient, mode, model, and message', () => {
      renderSendMessageContent(container, {
        input: {
          sessionId: 'conv-2',
          text: 'Hello from planner',
          mode: 'steer',
          model: 'claude-3-7-sonnet',
          reasoning: 'high',
        },
        result: JSON.stringify({
          sessionId: 'conv-2',
          title: 'Target Session',
          provider: 'claude',
          status: 'steered',
        }),
      });

      const root = container.querySelector('.codian-session-tool');
      expect(root).not.toBeNull();

      const link = root?.querySelector('button.codian-session-link');
      expect(link?.textContent).toBe('Target Session');
      expect(link?.getAttribute('data-codian-open-session')).toBe('conv-2');

      const textEl = root?.querySelector('.codian-session-tool-message');
      expect(textEl?.textContent).toBe('Hello from planner');
    });

    it('renders newly created session destination placeholder', () => {
      renderSendMessageContent(container, {
        input: { text: 'Starting new task' },
        result: JSON.stringify({
          sessionId: 'conv-new-1',
          provider: 'codex',
          status: 'started',
        }),
      });

      const link = container.querySelector('button.codian-session-link');
      expect(link?.textContent).toBe('New session');
      expect(link?.getAttribute('data-codian-open-session')).toBe('conv-new-1');
    });
  });

  describe('renderReadSessionContent', () => {
    it('renders read session info and turn counts', () => {
      renderReadSessionContent(container, {
        input: { sessionId: 'conv-3' },
        result: JSON.stringify({
          sessionId: 'conv-3',
          title: 'Review Task',
          provider: 'codex',
          fromTurn: 1,
          toTurn: 5,
          totalTurns: 10,
        }),
      });

      const link = container.querySelector('button.codian-session-link');
      expect(link?.textContent).toBe('Review Task');
      expect(link?.getAttribute('data-codian-open-session')).toBe('conv-3');

      expect(container.textContent).toContain('1–5 of 10');
    });
  });
});
