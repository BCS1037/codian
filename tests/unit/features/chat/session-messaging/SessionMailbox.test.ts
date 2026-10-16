import type { SessionMessage } from '@/core/session-tools/sessionMessageEnvelope';
import {
  SessionMailbox,
  type SessionMailboxRuntime,
  type SessionMailboxRuntimeModel,
  type SessionMessageDelivery,
  type SessionMessageUnsentReason,
} from '@/features/chat/session-messaging/SessionMailbox';

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
const message = (text: string): SessionMessage => ({ from: 'Sender', sessionId: 'sender', text });
const signal = new AbortController().signal;

function setup() {
  let available = true;
  let userQueued = false;
  let activeTurn = false;
  let isIdle = true;
  let isWorking = false;
  const hasBackgroundWork = false;
  let acceptsIntents = true;
  const admitsOperations = true;

  const hydrate = deferred<void>();
  const sent: string[] = [];
  const completions: Array<ReturnType<typeof deferred<void>>> = [];
  const callbacks: Array<{
    assertBeforeHandoff(): void;
    onUnsent(reason: SessionMessageUnsentReason): void;
  }> = [];
  const stops = jest.fn();

  const model: SessionMailboxRuntimeModel = {
    inputController: {
      get canStartSessionMessage() {
        return !userQueued && !activeTurn;
      },
      steerSessionMessage: jest.fn().mockResolvedValue('not-sent'),
      sendSessionMessage: async (entry, options) => {
        callbacks.push(options);
        activeTurn = true;
        isWorking = true;
        isIdle = false;
        try {
          options.assertBeforeHandoff();
          sent.push(entry.text);
          const done = deferred<void>();
          completions.push(done);
          await done.promise;
        } finally {
          activeTurn = false;
          isWorking = false;
          if (mailbox.hasPending === false) {
            isIdle = true;
          }
        }
      },
      interruptForSessionMessage: stops,
    },
  };

  const runtime: SessionMailboxRuntime & {
    isIdle: boolean;
    isWorking: boolean;
    cancelTurn(reason: string): void;
    beginShutdown(): void;
    notifyChanged(): void;
    dispose(): Promise<void>;
  } = {
    get isIdle() {
      return isIdle && !mailbox.hasPending && !activeTurn;
    },
    get isWorking() {
      return isWorking || activeTurn;
    },
    get acceptsIntents() {
      return acceptsIntents;
    },
    get admitsConversationOperations() {
      return admitsOperations;
    },
    get hasBackgroundWork() {
      return hasBackgroundWork;
    },
    hasPendingInteraction: false,
    get hasActiveTurn() {
      return activeTurn;
    },
    hasMainBackgroundWork: false,
    turns: {
      get isActive() {
        return activeTurn;
      },
    },
    peekModel: model,
    withModel: async (operation) => {
      await hydrate.promise;
      return operation(model);
    },
    stopMainBackgroundWork: stops,
    publish: () => {},
    cancelTurn: () => {
      mailbox.clear();
    },
    beginShutdown: () => {
      acceptsIntents = false;
      mailbox.clear();
    },
    notifyChanged: () => {
      mailbox.wake();
    },
    dispose: async () => {
      acceptsIntents = false;
      mailbox.clear();
    },
  };

  const discarded = jest.fn();
  const mailbox = new SessionMailbox({
    runtime,
    isTargetAvailable: () => available,
    onDiscard: discarded,
  });

  const send = (
    text: string,
    mode?: 'interrupt',
    commitSwitch?: SessionMessageDelivery['commitSwitch'],
  ) => mailbox.deliver({ message: message(text), mode, signal, commitSwitch });

  return {
    runtime,
    mailbox,
    send,
    stops,
    hydrate,
    sent,
    completions,
    callbacks,
    discarded,
    setAvailable: (value: boolean) => {
      available = value;
    },
    setUserQueued: (value: boolean) => {
      userQueued = value;
      runtime.notifyChanged();
    },
  };
}

describe('SessionMailbox lifetime and dispatch', () => {
  it('hydrates headlessly once and delivers FIFO with user work taking precedence', async () => {
    const h = setup();
    expect(await h.send('first')).toBe('started');
    expect(await h.send('second')).toBe('queued');
    expect(h.runtime.isIdle).toBe(false);
    expect(h.runtime.isWorking).toBe(false);

    h.setUserQueued(true);
    h.hydrate.resolve();
    await flush();
    expect(h.sent).toEqual([]);

    h.setUserQueued(false);
    await flush();
    expect(h.sent).toEqual(['first']);

    h.completions[0].resolve();
    await flush();
    expect(h.sent).toEqual(['first', 'second']);

    h.completions[1].resolve();
    await flush();
    expect(h.runtime.isIdle).toBe(true);
    await h.runtime.dispose();
  });

  it.each(['stop', 'shutdown', 'archived'] as const)(
    'fences pending hydration after %s',
    async (action) => {
      const h = setup();
      void h.send('pending');
      if (action === 'stop') h.runtime.cancelTurn('user');
      else if (action === 'shutdown') h.runtime.beginShutdown();
      else {
        h.setAvailable(false);
        h.runtime.notifyChanged();
      }
      h.hydrate.resolve();
      await flush();
      expect(h.sent).toEqual([]);
      expect(h.mailbox.hasPending).toBe(false);
      expect(h.discarded).toHaveBeenCalledWith([message('pending')]);
      await h.runtime.dispose();
    },
  );

  it('discards terminal hydration failure instead of retrying it', async () => {
    const h = setup();
    void h.send('failed');
    h.hydrate.reject(new Error('Provider initialization failed'));
    await flush();
    expect(h.discarded).toHaveBeenCalledWith([message('failed')]);
    expect(h.sent).toEqual([]);
    expect(h.mailbox.hasPending).toBe(false);
    expect(h.runtime.isIdle).toBe(true);
    await h.runtime.dispose();
  });

  it('discards a terminal unsent turn and advances to the next entry once', async () => {
    const h = setup();
    h.hydrate.resolve();
    void h.send('failed');
    void h.send('next');
    await flush();
    h.callbacks[0].onUnsent('failed');
    h.completions[0].resolve();
    await flush();
    expect(h.sent).toEqual(['failed', 'next']);
    expect(h.discarded).toHaveBeenCalledWith([message('failed')]);
    h.completions[1].resolve();
    await flush();
    await h.runtime.dispose();
  });

  it('rechecks eligibility when competing work settles before a deferred attempt unwinds', async () => {
    const h = setup();
    h.hydrate.resolve();
    void h.send('first');
    await flush();
    h.setUserQueued(true);
    h.callbacks[0].onUnsent('deferred');
    h.setUserQueued(false);
    h.completions[0].resolve();
    await flush();
    expect(h.sent).toEqual(['first', 'first']);
    expect(h.discarded).not.toHaveBeenCalled();
    h.completions[1].resolve();
    await flush();
    expect(h.mailbox.hasPending).toBe(false);
    await h.runtime.dispose();
  });

  it('does not resurrect a deferred return after Stop clears its generation', async () => {
    const h = setup();
    h.hydrate.resolve();
    void h.send('first');
    await flush();
    void h.send('second');
    h.runtime.cancelTurn('user');
    h.callbacks[0].onUnsent('deferred');
    h.completions[0].resolve();
    await flush();
    expect(h.sent).toEqual(['first']);
    expect(h.mailbox.hasPending).toBe(false);
    await h.runtime.dispose();
  });

  it('delivers an interrupt first when an older dispatch is still hydrating', async () => {
    const h = setup();
    expect(await h.send('older')).toBe('started');
    expect(await h.send('interrupt', 'interrupt')).toBe('queued');
    h.hydrate.resolve();
    await flush();
    expect(h.sent).toEqual(['interrupt']);
    h.completions[0].resolve();
    await flush();
    expect(h.sent).toEqual(['interrupt', 'older']);
    h.completions[1].resolve();
    await flush();
    await h.runtime.dispose();
  });

  it('lets nothing overtake a held interrupt while its switch commits, and stops only once it is admitted', async () => {
    const h = setup();
    void h.send('older');
    const switching = deferred<void>();
    const interrupt = h.send('interrupt', 'interrupt', async (admission) => {
      await switching.promise;
      admission.commit();
    });
    h.hydrate.resolve();
    await flush();
    expect(h.sent).toEqual([]);
    expect(h.stops).not.toHaveBeenCalled();
    switching.resolve();
    expect(await interrupt).toBe('started');
    expect(h.stops).toHaveBeenCalledTimes(1);
    await flush();
    expect(h.sent).toEqual(['interrupt']);
    h.completions[0].resolve();
    await flush();
    expect(h.sent).toEqual(['interrupt', 'older']);
    h.completions[1].resolve();
    await flush();
    await h.runtime.dispose();
  });

  it('returns a deferred older entry behind an interrupt admitted meanwhile', async () => {
    const h = setup();
    h.hydrate.resolve();
    void h.send('older');
    await flush();
    expect(await h.send('interrupt', 'interrupt')).toBe('interrupted');
    expect(h.stops).toHaveBeenCalledTimes(1);
    h.callbacks[0].onUnsent('deferred');
    h.completions[0].resolve();
    await flush();
    expect(h.sent).toEqual(['older', 'interrupt']);
    h.completions[1].resolve();
    await flush();
    expect(h.sent).toEqual(['older', 'interrupt', 'older']);
    h.completions[2].resolve();
    await flush();
    await h.runtime.dispose();
  });

  it('keeps a deferred newer interrupt ahead of older ones, behind interrupts admitted during its attempt', async () => {
    const h = setup();
    h.hydrate.resolve();
    void h.send('running');
    await flush();
    for (const text of ['old interrupt', 'new interrupt']) {
      await h.send(text, 'interrupt');
    }
    h.completions[0].resolve();
    await flush();
    expect(h.sent).toEqual(['running', 'new interrupt']);
    await h.send('newest interrupt', 'interrupt');
    h.callbacks[1].onUnsent('deferred');
    h.completions[1].resolve();
    await flush();
    for (const index of [2, 3, 4]) {
      h.completions[index].resolve();
      await flush();
    }
    expect(h.sent).toEqual([
      'running',
      'new interrupt',
      'newest interrupt',
      'new interrupt',
      'old interrupt',
    ]);
    await h.runtime.dispose();
  });

  it('does not dispatch an admitted interrupt before its stop, even if hydration finishes as the switch commits', async () => {
    const h = setup();
    void h.send('older');
    const sentAtStop: string[][] = [];
    h.stops.mockImplementation(() => {
      sentAtStop.push([...h.sent]);
    });
    const settling = deferred<void>();
    const interrupt = h.send('interrupt', 'interrupt', async (admission) => {
      admission.commit();
      await settling.promise;
    });
    h.hydrate.resolve();
    await flush();
    expect(h.sent).toEqual([]);
    settling.resolve();
    expect(await interrupt).toBe('started');
    await flush();
    expect(sentAtStop).toEqual([[]]);
    expect(h.sent).toEqual(['interrupt']);
    h.completions[0].resolve();
    await flush();
    expect(h.sent).toEqual(['interrupt', 'older']);
    h.completions[1].resolve();
    await flush();
    await h.runtime.dispose();
  });
});
