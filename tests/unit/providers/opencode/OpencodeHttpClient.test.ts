import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { PassThrough } from 'node:stream';

import {
  OpencodeHttpClient,
  type OpencodeHttpEvent,
  type OpencodeHttpProcessFactory,
} from '@/providers/opencode/http/OpencodeHttpClient';
import { OpencodeHttpClientPool } from '@/providers/opencode/http/OpencodeHttpClientPool';

interface HttpHarness {
  client: OpencodeHttpClient;
  processFactory: jest.MockedFunction<OpencodeHttpProcessFactory>;
}

type RequestHandler = (request: IncomingMessage, response: ServerResponse) => void;

function createHttpHarness(
  handler: RequestHandler,
  readinessUrl?: string,
  requireStartedStreams = false,
): HttpHarness {
  const server = createServer(handler);
  const stdout = new PassThrough();
  const closeListeners = new Set<(error?: Error) => void>();
  let started = false;
  const processFactory = jest.fn<ReturnType<OpencodeHttpProcessFactory>, Parameters<OpencodeHttpProcessFactory>>(
    spec => ({
      get stdout() {
        if (requireStartedStreams && !started) {
          throw new Error('ACP subprocess is not started');
        }
        return stdout;
      },
      onClose(listener) {
        closeListeners.add(listener);
        return () => closeListeners.delete(listener);
      },
      async shutdown() {
        for (const listener of closeListeners) listener();
        await new Promise<void>((resolve) => {
          if (!server.listening) {
            resolve();
            return;
          }
          server.close(() => resolve());
        });
      },
      start() {
        started = true;
        const portIndex = spec.args.indexOf('--port');
        const port = Number(spec.args[portIndex + 1]);
        server.listen(port, '127.0.0.1', () => {
          const address = server.address();
          if (!address || typeof address === 'string') throw new Error('Expected a TCP listener.');
          stdout.write(`opencode server listening on ${readinessUrl ?? `http://127.0.0.1:${address.port}`}\n`);
        });
      },
    }),
  );
  return {
    client: new OpencodeHttpClient(
      '/tools/opencode',
      '/vault/project',
      { PATH: '/tools' },
      processFactory,
    ),
    processFactory,
  };
}

describe('OpencodeHttpClient', () => {
  it('starts the subprocess before accessing its output stream', async () => {
    const harness = createHttpHarness((_request, response) => {
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ ready: true }));
    }, undefined, true);

    await expect(harness.client.request('/api/health')).resolves.toEqual({ ready: true });
    await harness.client.dispose();
  }, 15000);

  it('starts the native server and sends authenticated requests scoped to its workspace', async () => {
    let authorization = '';
    let requestUrl = '';
    let requestBody = '';
    const harness = createHttpHarness((request, response) => {
      authorization = String(request.headers.authorization ?? '');
      requestUrl = request.url ?? '';
      request.on('data', (chunk: Buffer) => { requestBody += chunk.toString('utf8'); });
      request.on('end', () => {
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ accepted: true }));
      });
    });

    await expect(harness.client.request('/api/session', {
      body: { prompt: 'hello' },
      method: 'POST',
    })).resolves.toEqual({ accepted: true });

    const launchSpec = harness.processFactory.mock.calls[0]?.[0];
    if (!launchSpec) throw new Error('Expected the OpenCode server to start.');
    const portIndex = launchSpec.args.indexOf('--port');
    expect(launchSpec.args.slice(0, portIndex + 1)).toEqual([
      'serve', '--hostname', '127.0.0.1', '--port',
    ]);
    expect(Number(launchSpec.args[portIndex + 1])).toBeGreaterThan(0);
    expect(Buffer.from(authorization.replace(/^Basic /u, ''), 'base64').toString('utf8'))
      .toBe(`opencode:${launchSpec.env.OPENCODE_SERVER_PASSWORD}`);
    expect(launchSpec.env).not.toHaveProperty('OPENCODE_PASSWORD');
    expect(requestUrl).toContain('location%5Bdirectory%5D=%2Fvault%2Fproject');
    expect(JSON.parse(requestBody)).toEqual({ prompt: 'hello' });
    expect(launchSpec).toEqual(expect.objectContaining({
      command: '/tools/opencode',
      cwd: '/vault/project',
      env: expect.objectContaining({
        OPENCODE_SERVER_PASSWORD: expect.any(String),
        OPENCODE_SERVER_USERNAME: 'opencode',
      }),
    }));

    await harness.client.dispose();
  });

  it('does not expose response bodies from failed OpenCode requests', async () => {
    const harness = createHttpHarness((_request, response) => {
      response.statusCode = 403;
      response.end('private provider response body');
    });

    let failure: unknown;
    try {
      await harness.client.request('/api/session');
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe('OpenCode HTTP request failed (403).');
    expect((failure as Error).message).not.toContain('private provider response body');
    await harness.client.dispose();
  });

  it('parses server-connected and native event frames from SSE', async () => {
    const harness = createHttpHarness((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.write(`data: ${JSON.stringify({ type: 'server.connected', data: {} })}\n\n`);
      response.write(`data: ${JSON.stringify({ type: 'session.updated', data: { sessionID: 's1' } })}\n\n`);
    });
    const events: Array<{ type: string; data: Record<string, unknown> }> = [];
    const errors: Error[] = [];

    await harness.client.subscribe(event => events.push(event), error => errors.push(error));

    expect(events).toEqual([
      { type: 'server.connected', data: {} },
      { type: 'session.updated', data: { sessionID: 's1' } },
    ]);
    expect(errors).toEqual([]);
    await harness.client.dispose();
  });

  it('normalizes OpenCode properties-based event frames', async () => {
    const harness = createHttpHarness((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.write(`data: ${JSON.stringify({ type: 'server.connected', data: {} })}\n\n`);
      response.write(`data: ${JSON.stringify({
        type: 'message.updated',
        properties: {
          info: { id: 'assistant-1', role: 'assistant' },
          sessionID: 'session-1',
        },
      })}\n\n`);
    });
    const events: OpencodeHttpEvent[] = [];

    await harness.client.subscribe(event => events.push(event), jest.fn());

    expect(events).toContainEqual({
      type: 'message.updated',
      data: {
        info: { id: 'assistant-1', role: 'assistant' },
        sessionID: 'session-1',
      },
    });
    await harness.client.dispose();
  });

  it('shares one native process across active leases until the final lease releases', async () => {
    const harness = createHttpHarness((_request, response) => {
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ ok: true }));
    });
    const pool = new OpencodeHttpClientPool(() => harness.client);
    const first = pool.acquire('/tools/opencode', '/vault/project', { PATH: '/tools' }, 'launch-a');
    const second = pool.acquire('/tools/opencode', '/vault/project', { PATH: '/tools' }, 'launch-a');

    await expect(Promise.all([
      first.request('/api/first'),
      second.request('/api/second'),
    ])).resolves.toEqual([{ ok: true }, { ok: true }]);
    expect(harness.processFactory).toHaveBeenCalledTimes(1);
    const process = harness.processFactory.mock.results[0]?.value;
    if (!process) throw new Error('Expected the shared native process to start.');
    const shutdown = jest.spyOn(process, 'shutdown');

    await first.dispose();
    expect(shutdown).not.toHaveBeenCalled();
    expect(second.isAlive).toBe(true);

    await second.dispose();
    expect(shutdown).toHaveBeenCalledTimes(1);
  });

  it('rejects a server readiness URL outside loopback', async () => {
    const harness = createHttpHarness((_request, response) => response.end('{}'), 'https://example.com');

    await expect(harness.client.request('/api/session')).rejects.toThrow(
      'Invalid OpenCode server readiness response.',
    );
    await harness.client.dispose();
  });
});
