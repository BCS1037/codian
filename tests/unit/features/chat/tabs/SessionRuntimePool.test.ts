import { SessionRuntimePool } from '../../../../../src/features/chat/tabs/SessionRuntimePool';
import { TabSession } from '../../../../../src/features/chat/tabs/TabSession';
import type { TabData } from '../../../../../src/features/chat/tabs/types';

function createSession(conversationId: string) {
  const session = new TabSession({
    id: `tab-${conversationId}`,
    conversationId,
    draftModel: null,
    lifecycleState: 'bound_active',
    providerId: 'claude',
  });
  const tab = {
    id: session.id,
    session,
    conversationId,
    lifecycleState: 'bound_active',
    state: {
      isStreaming: true,
      isRewinding: false,
      isCreatingConversation: false,
      isSwitchingConversation: false,
      queuedMessage: null,
      requiresAction: false,
    },
    services: { subagentManager: { hasActiveWork: false } },
    controllers: {},
  } as unknown as TabData;

  return { session, tab };
}

describe('SessionRuntimePool', () => {
  it('keeps unread attention for history sessions without creating a tab runtime', () => {
    const pool = new SessionRuntimePool(jest.fn(async () => {}));

    expect(pool.getConversationAttention('conversation-history')).toBeUndefined();

    pool.setConversationAttention('conversation-history', {
      kind: 'review',
      outcome: 'completed',
      since: 123,
    });

    expect(pool.getConversationAttention('conversation-history')).toEqual({
      kind: 'review',
      outcome: 'completed',
      since: 123,
    });

    pool.setConversationAttention('conversation-history', null);
    expect(pool.getConversationAttention('conversation-history')).toBeUndefined();
  });

  it('retains a running session and reattaches the same execution state by conversation', () => {
    const dispose = jest.fn(async () => {});
    const pool = new SessionRuntimePool(dispose);
    const { session, tab } = createSession('conversation-a');
    session.activeTurn = Promise.resolve();

    expect(pool.detach(tab)).toBe(true);
    expect(pool.isConversationRunning('conversation-a')).toBe(true);

    const reattached = pool.takeByConversation('conversation-a');
    expect(reattached).toBe(tab);
    expect(reattached?.session).toBe(session);
    expect(dispose).not.toHaveBeenCalled();
  });

  it('does not let one session settling evict a different active session', async () => {
    const dispose = jest.fn(async () => {});
    const pool = new SessionRuntimePool(dispose);
    const first = createSession('conversation-a');
    const second = createSession('conversation-b');
    first.session.activeTurn = Promise.resolve();
    second.session.activeTurn = Promise.resolve();
    pool.detach(first.tab);
    pool.detach(second.tab);

    first.tab.state.isStreaming = false;
    first.session.activeTurn = null;
    first.session.notifyWorkStateChanged();
    await pool.whenDisposed(first.session.id);

    expect(pool.isConversationRunning('conversation-a')).toBe(false);
    expect(pool.isConversationRunning('conversation-b')).toBe(true);
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(dispose).toHaveBeenCalledWith(first.tab);
  });

  it('keeps approval, queued input, and subagent state isolated per session', () => {
    const dispose = jest.fn(async () => {});
    const pool = new SessionRuntimePool(dispose);
    const first = createSession('conversation-approval');
    const second = createSession('conversation-subagent');
    first.tab.state.isStreaming = false;
    (first.tab.state as any).requiresAction = true;
    (first.tab.state as any).queuedMessage = {
      content: 'queued',
      images: undefined,
      editorContext: null,
      canvasContext: null,
    };
    (first.tab.services.subagentManager as any).hasActiveWork = true;
    second.tab.state.isStreaming = false;
    (second.tab.services.subagentManager as any).hasActiveWork = true;

    expect(pool.detach(first.tab)).toBe(true);
    expect(pool.detach(second.tab)).toBe(true);
    expect(pool.takeByConversation('conversation-approval')).toBe(first.tab);
    expect(pool.takeByConversation('conversation-subagent')).toBe(second.tab);
    expect(first.tab.state.requiresAction).toBe(true);
    expect(first.tab.state.queuedMessage).toMatchObject({ content: 'queued' });
    expect(first.tab.services.subagentManager.hasActiveWork).toBe(true);
    expect(second.tab.services.subagentManager.hasActiveWork).toBe(true);
    expect(dispose).not.toHaveBeenCalled();
  });

  it('retires deleted sessions after their active turn settles without making them reattachable', async () => {
    const dispose = jest.fn(async () => {});
    const pool = new SessionRuntimePool(dispose);
    const { session, tab } = createSession('conversation-a');
    session.activeTurn = Promise.resolve();
    pool.detach(tab);

    const retirement = pool.retire(tab);
    expect(pool.takeByConversation('conversation-a')).toBeNull();
    expect(dispose).not.toHaveBeenCalled();

    tab.state.isStreaming = false;
    session.activeTurn = null;
    session.notifyWorkStateChanged();
    await retirement;

    expect(dispose).toHaveBeenCalledWith(tab);
    expect(pool.isConversationRunning('conversation-a')).toBe(false);
  });

  it('does not retain idle sessions and cancels detached work during plugin shutdown', async () => {
    const dispose = jest.fn(async () => {});
    const pool = new SessionRuntimePool(dispose);
    const idle = createSession('conversation-idle');
    idle.tab.state.isStreaming = false;
    expect(pool.detach(idle.tab)).toBe(false);

    const active = createSession('conversation-active');
    active.session.activeTurn = Promise.resolve();
    expect(pool.detach(active.tab)).toBe(true);
    pool.beginShutdown();
    expect(pool.detach(createSession('conversation-new').tab)).toBe(false);
    await pool.dispose();

    expect(dispose).toHaveBeenCalledTimes(1);
    expect(dispose).toHaveBeenCalledWith(active.tab);
    expect(pool.size).toBe(0);
  });
});
