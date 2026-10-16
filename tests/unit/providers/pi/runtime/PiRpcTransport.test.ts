import { PassThrough, Writable } from 'node:stream';

import {
  PiRpcResponseError,
  PiRpcTransport,
  PiRpcTransportClosedError,
} from '@/providers/pi/runtime/PiRpcTransport';

function createTransport() {
  const input = new PassThrough();
  const output = new PassThrough();
  const writes: string[] = [];
  output.on('data', chunk => writes.push(chunk.toString('utf8')));
  const transport = new PiRpcTransport({ input, output }, 100);
  transport.start();
  return { input, output, transport, writes };
}

describe('PiRpcTransport', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('writes command requests with string ids', async () => {
    const { input, transport, writes } = createTransport();
    const promise = transport.request('get_state', { foo: 'bar' });

    expect(JSON.parse(writes[0]) as unknown).toEqual({
      foo: 'bar',
      id: 'req_1',
      type: 'get_state',
    });

    input.write('{"type":"response","id":"req_1","success":true,"result":{"ok":true}}\n');
    await expect(promise).resolves.toEqual({ ok: true });
  });

  it('sends fire-and-forget records without pending request tracking', () => {
    const { transport, writes } = createTransport();

    transport.send({ id: 'ui-1', type: 'extension_ui_response', value: 'ok' });

    expect(JSON.parse(writes[0]) as unknown).toEqual({
      id: 'ui-1',
      type: 'extension_ui_response',
      value: 'ok',
    });
  });

  it('resolves concurrent requests by id out of order', async () => {
    const { input, transport } = createTransport();
    const first = transport.request('first');
    const second = transport.request('second');

    input.write('{"type":"response","id":"req_2","success":true,"result":2}\n');
    input.write('{"type":"response","id":"req_1","success":true,"result":1}\n');

    await expect(second).resolves.toBe(2);
    await expect(first).resolves.toBe(1);
  });

  it('unwraps Pi response data when result is absent', async () => {
    const { input, transport } = createTransport();
    const promise = transport.request('get_available_models');

    input.write('{"type":"response","id":"req_1","success":true,"data":{"models":[{"id":"gpt-5"}]}}\n');

    await expect(promise).resolves.toEqual({ models: [{ id: 'gpt-5' }] });
  });

  it('routes non-response events to listeners', () => {
    const { input, transport } = createTransport();
    const events: unknown[] = [];
    transport.onEvent(event => events.push(event));

    input.write('{"type":"message_update","delta":"hi"}\n');

    expect(events).toEqual([{ type: 'message_update', delta: 'hi' }]);
  });

  it('ignores malformed JSON records without failing pending requests', async () => {
    const { input, transport } = createTransport();
    const promise = transport.request('prompt');

    input.write('not-json\n');
    input.write('{"type":"response","id":"req_1","success":true,"result":{"accepted":true}}\n');

    await expect(promise).resolves.toEqual({ accepted: true });
  });

  it('rejects failed responses and pending requests on dispose', async () => {
    const { input, transport } = createTransport();
    const failed = transport.request('prompt');
    input.write('{"type":"response","id":"req_1","success":false,"error":"boom"}\n');

    await expect(failed).rejects.toBeInstanceOf(PiRpcResponseError);

    const pending = transport.request('prompt');
    transport.dispose();
    await expect(pending).rejects.toBeInstanceOf(PiRpcTransportClosedError);
  });

  it('rejects timed-out requests and removes them from the pending set', async () => {
    jest.useFakeTimers();
    const { input, transport } = createTransport();
    const timedOut = transport.request('prompt', {}, 100);

    jest.advanceTimersByTime(100);
    await expect(timedOut).rejects.toThrow('Request timeout: prompt');

    input.write('{"type":"response","id":"req_1","success":true,"result":"late"}\n');
    const next = transport.request('get_state', {}, 100);
    input.write('{"type":"response","id":"req_2","success":true,"result":{"ok":true}}\n');
    await expect(next).resolves.toEqual({ ok: true });
  });

  it('aborts an outstanding RPC request and ignores its late response', async () => {
    const { input, transport } = createTransport();
    const controller = new AbortController();
    const pending = transport.request('prompt', {}, 0, controller.signal);

    controller.abort();
    await expect(pending).rejects.toThrow('Request aborted: prompt');

    const next = transport.request('get_state', {}, 100);
    input.write('{"type":"response","id":"req_1","success":true,"result":"late"}\n');
    input.write('{"type":"response","id":"req_2","success":true,"result":{"ok":true}}\n');
    await expect(next).resolves.toEqual({ ok: true });
  });

  it.each(['write error', 'output close'] as const)('closes pending requests on %s without waiting for a response', async failure => {
    const input = new PassThrough();
    const error = new Error('write EPIPE');
    let failWrite: () => void = () => { throw new Error('No write was issued'); };
    const output = new Writable({ write(_chunk, _encoding, callback) {
      if (failure === 'write error') failWrite = () => callback(error);
      else callback();
    } });
    const transport = new PiRpcTransport({ input, output }, 0);
    const closed = jest.fn();
    transport.onClose(closed);
    const pending = Promise.allSettled([transport.request('prompt'), transport.request('get_state')]);
    try {
      const streamEvent = new Promise<void>(resolve => output.once(failure === 'write error' ? 'error' : 'close', () => resolve()));
      if (failure === 'write error') failWrite();
      else output.destroy();
      await streamEvent;
      expect(transport.isClosed).toBe(true);
      const expected = failure === 'write error' ? error : new PiRpcTransportClosedError('Pi RPC output closed');
      expect(await pending).toEqual([
        { status: 'rejected', reason: expected },
        { status: 'rejected', reason: expected },
      ]);
      await expect(transport.request('prompt')).rejects.toBeInstanceOf(PiRpcTransportClosedError);
      input.destroy();
      await new Promise(resolve => setImmediate(resolve));
      expect(closed).toHaveBeenCalledTimes(1);
    } finally {
      transport.dispose();
      await pending;
      input.destroy();
      output.destroy();
    }
  });

  it('handles an in-flight write error after disposal until the output closes', async () => {
    const input = new PassThrough();
    const error = new Error('write EPIPE');
    let failWrite: () => void = () => { throw new Error('No write was issued'); };
    const output = new Writable({ write(_chunk, _encoding, callback) {
      failWrite = () => callback(error);
    } });
    const unhandledErrors: unknown[] = [];
    const emit = output.emit.bind(output);
    jest.spyOn(output, 'emit').mockImplementation((event, ...args) => {
      // Record the otherwise fatal event so a failing implementation does not crash the test runner.
      if (event === 'error' && output.listenerCount('error') === 0) {
        unhandledErrors.push(args[0]);
        return false;
      }
      return emit(event, ...args);
    });
    const transport = new PiRpcTransport({ input, output }, 0);
    const closed = jest.fn();
    transport.onClose(closed);
    const pending = transport.request('prompt');
    transport.dispose();
    await expect(pending).rejects.toBeInstanceOf(PiRpcTransportClosedError);
    const outputClosed = new Promise<void>(resolve => output.once('close', () => resolve()));
    failWrite();
    await outputClosed;
    expect(unhandledErrors).toEqual([]);
    expect(closed).toHaveBeenCalledTimes(1);
    expect(output.listenerCount('error')).toBe(0);
    input.destroy();
  });
});
