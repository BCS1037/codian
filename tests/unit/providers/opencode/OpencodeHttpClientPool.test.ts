import type { OpencodeHttpClientConnection, OpencodeHttpEvent } from '@/providers/opencode/http/OpencodeHttpClient';
import { OpencodeHttpClientPool } from '@/providers/opencode/http/OpencodeHttpClientPool';

interface Subscription {
  onEvent: (event: OpencodeHttpEvent) => void;
  signal?: AbortSignal;
}

function createFakeClient() {
  const subscriptions: Subscription[] = [];
  const dispose = jest.fn(async () => {});
  const client = {
    isAlive: true,
    isClosed: false,
    signal: (signal?: AbortSignal) => signal ?? new AbortController().signal,
    request: jest.fn(async <T>() => ({ ok: true } as T)),
    subscribe: jest.fn(async (
      onEvent: (event: OpencodeHttpEvent) => void,
      _onError: (error: Error) => void,
      signal?: AbortSignal,
    ) => { subscriptions.push({ onEvent, signal }); }),
    dispose,
  } as unknown as OpencodeHttpClientConnection;
  return { client, dispose, subscriptions };
}

describe('OpencodeHttpClientPool', () => {
  it('shares one server across compatible leases and only closes it after final release', async () => {
    const fake = createFakeClient();
    const createClient = jest.fn(() => fake.client);
    const pool = new OpencodeHttpClientPool(createClient);
    const first = pool.acquire(
      '/tools/opencode',
      '/vault/project',
      { HOME: '/home/user', PATH: '/tools' },
      'launch-a',
    );
    const second = pool.acquire(
      '/tools/opencode',
      '/vault/project',
      { PATH: '/tools', HOME: '/home/user' },
      'launch-a',
    );

    expect(createClient).toHaveBeenCalledTimes(1);
    await expect(first.request('/api/model')).resolves.toEqual({ ok: true });
    await first.dispose();
    expect(fake.dispose).not.toHaveBeenCalled();
    expect(first.isClosed).toBe(true);
    expect(second.isAlive).toBe(true);

    await second.dispose();
    expect(fake.dispose).toHaveBeenCalledTimes(1);
  });

  it('separates launches when config, workspace, or environment differs', async () => {
    const clients = [createFakeClient(), createFakeClient(), createFakeClient(), createFakeClient()];
    let nextClientIndex = 0;
    const createClient = jest.fn(() => clients[nextClientIndex++].client);
    const pool = new OpencodeHttpClientPool(createClient);
    const leases = [
      pool.acquire('/tools/opencode', '/vault/project', { PATH: '/tools' }, 'launch-a'),
      pool.acquire('/tools/opencode', '/vault/project', { PATH: '/tools' }, 'launch-b'),
      pool.acquire('/tools/opencode', '/vault/other', { PATH: '/tools' }, 'launch-a'),
      pool.acquire('/tools/opencode', '/vault/project', { PATH: '/other' }, 'launch-a'),
    ];

    expect(createClient).toHaveBeenCalledTimes(4);
    await Promise.all(leases.map(lease => lease.dispose()));
  });

  it('cancels one lease subscription without interrupting peers', async () => {
    const fake = createFakeClient();
    const pool = new OpencodeHttpClientPool(() => fake.client);
    const first = pool.acquire('/tools/opencode', '/vault/project', { PATH: '/tools' }, 'launch-a');
    const second = pool.acquire('/tools/opencode', '/vault/project', { PATH: '/tools' }, 'launch-a');
    const firstEvents: OpencodeHttpEvent[] = [];
    const secondEvents: OpencodeHttpEvent[] = [];
    await first.subscribe(event => firstEvents.push(event), () => {});
    await second.subscribe(event => secondEvents.push(event), () => {});

    await first.dispose();
    expect(fake.subscriptions[0].signal?.aborted).toBe(true);
    expect(fake.subscriptions[1].signal?.aborted).toBe(false);
    fake.subscriptions[0].onEvent({ type: 'session.updated', data: { sessionID: 's1' } });
    fake.subscriptions[1].onEvent({ type: 'session.updated', data: { sessionID: 's1' } });
    expect(firstEvents).toEqual([]);
    expect(secondEvents).toHaveLength(1);
    expect(fake.dispose).not.toHaveBeenCalled();

    await second.dispose();
  });

  it('routes provider-global forms through one live lease', async () => {
    const fake = createFakeClient();
    const pool = new OpencodeHttpClientPool(() => fake.client);
    const first = pool.acquire('/tools/opencode', '/vault/project', { PATH: '/tools' }, 'launch-a');
    const second = pool.acquire('/tools/opencode', '/vault/project', { PATH: '/tools' }, 'launch-a');
    const firstEvents: OpencodeHttpEvent[] = [];
    const secondEvents: OpencodeHttpEvent[] = [];
    await first.subscribe(event => firstEvents.push(event), () => {});
    await second.subscribe(event => secondEvents.push(event), () => {});
    const globalForm: OpencodeHttpEvent = {
      type: 'form.created',
      data: { form: { sessionID: 'global' } },
    };
    for (const subscription of fake.subscriptions) subscription.onEvent(globalForm);
    expect(firstEvents).toEqual([globalForm]);
    expect(secondEvents).toEqual([]);

    await first.dispose();
    for (const subscription of fake.subscriptions.slice(1)) subscription.onEvent(globalForm);
    expect(secondEvents).toEqual([globalForm]);
    await second.dispose();
  });

  it('replaces a closed server entry for the next lease', async () => {
    const old = createFakeClient();
    const fresh = createFakeClient();
    const createClient = jest.fn()
      .mockReturnValueOnce(old.client)
      .mockReturnValueOnce(fresh.client);
    const pool = new OpencodeHttpClientPool(createClient);
    const first = pool.acquire('/tools/opencode', '/vault/project', { PATH: '/tools' }, 'launch-a');
    (old.client as unknown as { isClosed: boolean }).isClosed = true;
    const second = pool.acquire('/tools/opencode', '/vault/project', { PATH: '/tools' }, 'launch-a');

    expect(createClient).toHaveBeenCalledTimes(2);
    expect(old.dispose).toHaveBeenCalledTimes(1);
    await Promise.all([first.dispose(), second.dispose()]);
  });
});
