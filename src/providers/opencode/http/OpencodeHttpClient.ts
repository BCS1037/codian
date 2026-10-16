import { randomBytes } from 'node:crypto';
import { type IncomingMessage, request } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import type { Readable } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';

import {
  AcpSubprocess,
  type AcpSubprocessLaunchSpec,
} from '../../acp/AcpSubprocess';

const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
const MAX_EVENT_BYTES = 32 * 1024 * 1024;
const MAX_STARTUP_OUTPUT_BYTES = 16_384;
const SERVER_START_TIMEOUT_MS = 10_000;
const EVENT_CONNECT_TIMEOUT_MS = 10_000;
const REQUEST_TIMEOUT_MS = 30_000;

export interface OpencodeHttpEvent {
  readonly type: string;
  readonly data: Record<string, unknown>;
}

export interface OpencodeHttpRequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface OpencodeHttpClientConnection {
  readonly isAlive: boolean;
  readonly isClosed: boolean;

  signal(signal?: AbortSignal): AbortSignal;
  request<T = unknown>(route: string, options?: OpencodeHttpRequestOptions): Promise<T>;
  subscribe(
    onEvent: (event: OpencodeHttpEvent) => void,
    onError: (error: Error) => void,
    signal?: AbortSignal,
  ): Promise<void>;
  dispose(): Promise<void>;
}

export class OpencodeHttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = 'OpencodeHttpError';
  }
}

export interface OpencodeHttpProcess {
  readonly stdout: Readable;
  isAlive?(): boolean;
  onClose(listener: (error?: Error) => void): () => void;
  shutdown(): Promise<void>;
  start(): void;
}

export type OpencodeHttpProcessFactory = (
  spec: AcpSubprocessLaunchSpec,
) => OpencodeHttpProcess;

/** Owns one authenticated loopback server for an OpenCode native HTTP session. */
export class OpencodeHttpClient implements OpencodeHttpClientConnection {
  private readonly controller = new AbortController();
  private readonly password = randomBytes(32).toString('base64url');
  private process: OpencodeHttpProcess | null = null;
  private endpoint: Promise<string> | null = null;
  private started = false;

  constructor(
    private readonly cliPath: string,
    private readonly cwd: string,
    private readonly environment: NodeJS.ProcessEnv,
    private readonly processFactory: OpencodeHttpProcessFactory = spec => new AcpSubprocess(spec),
  ) {}

  get isClosed(): boolean {
    return this.controller.signal.aborted;
  }

  get isAlive(): boolean {
    return this.started && !this.isClosed && (this.process?.isAlive?.() ?? true);
  }

  signal(signal?: AbortSignal): AbortSignal {
    return signal ? AbortSignal.any([signal, this.controller.signal]) : this.controller.signal;
  }

  async request<T = unknown>(route: string, options: OpencodeHttpRequestOptions = {}): Promise<T> {
    const response = await this.open(route, options);
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const value of response) {
      const chunk = value as Buffer;
      size += chunk.length;
      if (size > MAX_RESPONSE_BYTES) {
        response.destroy();
        throw new Error('OpenCode HTTP response exceeded the size limit.');
      }
      chunks.push(chunk);
    }

    const text = Buffer.concat(chunks).toString('utf8');
    if (response.statusCode === undefined || response.statusCode < 200 || response.statusCode >= 300) {
      throw new OpencodeHttpError(
        response.statusCode ?? 0,
        `OpenCode HTTP request failed (${response.statusCode ?? 'unknown'}).`,
      );
    }
    return (text ? JSON.parse(text) : undefined) as T;
  }

  /** Resolves after the event stream connects; later disconnects are explicit. */
  async subscribe(
    onEvent: (event: OpencodeHttpEvent) => void,
    onError: (error: Error) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    const subscriptionSignal = this.signal(signal);
    const response = await this.open('/api/event', { signal });
    if (response.statusCode !== 200) {
      response.destroy();
      throw new Error('Could not subscribe to OpenCode events.');
    }

      let connected = false;
      let reportedFailure = false;
      const ready = new Promise<void>((resolve, reject) => {
      const decoder = new StringDecoder('utf8');
      let buffer = '';
      const fail = (error: Error): void => {
        if (reportedFailure || subscriptionSignal.aborted) return;
        reportedFailure = true;
        if (connected) onError(error);
        else reject(error);
      };
      const onData = (chunk: Buffer): void => {
        try {
          buffer += decoder.write(chunk).replace(/\r\n/gu, '\n');
          if (buffer.length > MAX_EVENT_BYTES) {
            throw new Error('OpenCode event exceeded the size limit.');
          }
          let end = buffer.indexOf('\n\n');
          while (end >= 0) {
            const frame = buffer.slice(0, end);
            buffer = buffer.slice(end + 2);
            const payload = frame.split('\n')
              .filter(line => line.startsWith('data:'))
              .map(line => line.slice(5).trimStart())
              .join('\n');
            if (payload) {
              const event: unknown = JSON.parse(payload);
              const data = isRecord(event) && isRecord(event.data)
                ? event.data
                : isRecord(event) && isRecord(event.properties) ? event.properties : undefined;
              if (isRecord(event) && typeof event.type === 'string' && data) {
                const type = event.type.replace(/\.\d+$/u, '');
                if (type === 'server.connected' && !connected) {
                  connected = true;
                  window.clearTimeout(connectTimer);
                  resolve();
                }
                onEvent({ type, data });
              }
            }
            end = buffer.indexOf('\n\n');
          }
        } catch (error) {
          response.destroy(error instanceof Error ? error : new Error(String(error)));
        }
      };
      const connectTimer = window.setTimeout(() => {
        if (!connected) response.destroy(new Error('OpenCode event subscription timed out.'));
      }, EVENT_CONNECT_TIMEOUT_MS);
      response.on('data', onData);
      response.on('error', fail);
      response.on('end', () => fail(new Error(
        'OpenCode event stream closed. Reopen the conversation to reload native history.',
      )));
      response.on('close', () => window.clearTimeout(connectTimer));
    });

    await ready;
  }

  async dispose(): Promise<void> {
    this.controller.abort();
    await this.process?.shutdown();
    this.unregisterProcessClose?.();
    this.unregisterProcessClose = null;
  }

  private async open(route: string, options: {
    method?: string;
    body?: unknown;
    signal?: AbortSignal;
    timeoutMs?: number;
  } = {}): Promise<IncomingMessage> {
    const signal = this.signal(options.signal);
    signal.throwIfAborted();
    this.endpoint ??= this.start();
    const endpoint = await this.endpoint;
    signal.throwIfAborted();
    const url = new URL(route, endpoint);
    if (url.origin !== endpoint) throw new Error('Invalid OpenCode API route.');
    url.searchParams.set('location[directory]', this.cwd);

    return new Promise((resolve, reject) => {
      let settled = false;
      let timer: number | undefined;
      const finish = (error?: Error, response?: IncomingMessage): void => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) window.clearTimeout(timer);
        if (error) reject(error);
        else resolve(response!);
      };
      const req = request(url, {
        method: options.method ?? 'GET',
        signal,
        headers: {
          Authorization: `Basic ${Buffer.from(`opencode:${this.password}`).toString('base64')}`,
          ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
      }, response => finish(undefined, response));
      req.on('error', error => finish(error));
      if (options.timeoutMs !== 0) {
        timer = window.setTimeout(() => {
          req.destroy(new Error('OpenCode HTTP request timed out.'));
        }, options.timeoutMs ?? REQUEST_TIMEOUT_MS);
      }
      req.end(options.body === undefined ? undefined : JSON.stringify(options.body));
    });
  }

  private async start(): Promise<string> {
    this.controller.signal.throwIfAborted();
    const port = await allocateLoopbackPort();
    this.controller.signal.throwIfAborted();
    this.process = this.processFactory({
      args: ['serve', '--hostname', '127.0.0.1', '--port', String(port)],
      command: this.cliPath,
      cwd: this.cwd,
      env: {
        ...this.environment,
        OPENCODE_SERVER_PASSWORD: this.password,
        OPENCODE_SERVER_USERNAME: 'opencode',
      },
    });
    const process = this.process;

    return new Promise((resolve, reject) => {
      let output = '';
      let settled = false;
      let ready = false;
      let stdout: OpencodeHttpProcess['stdout'] | null = null;
      const finish = (error?: Error, url?: string): void => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timeout);
        stdout?.off('data', onData);
        if (!ready) this.unregisterProcessClose?.();
        if (error && !this.controller.signal.aborted) this.controller.abort(error);
        if (error) reject(error);
        else resolve(url!);
      };
      const onClose = (error?: Error): void => {
        if (ready) {
          if (!this.controller.signal.aborted) {
            this.controller.abort(error ?? new Error('OpenCode HTTP server closed.'));
          }
          return;
        }
        finish(error ?? new Error('OpenCode server closed before readiness.'));
      };
      const onData = (chunk: Buffer | string): void => {
        if (settled) return;
        output += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk;
        if (Buffer.byteLength(output, 'utf8') > MAX_STARTUP_OUTPUT_BYTES) {
          finish(new Error('Invalid OpenCode server readiness response.'));
          return;
        }
        let end = output.indexOf('\n');
        while (end >= 0) {
          const line = output.slice(0, end).trim();
          output = output.slice(end + 1);
          const serverOrigin = parseServerOrigin(line, port);
          if (serverOrigin) {
            ready = true;
            finish(undefined, serverOrigin);
            return;
          }
          if (/server listening on /iu.test(line)) {
            finish(new Error('Invalid OpenCode server readiness response.'));
            return;
          }
          end = output.indexOf('\n');
        }
      };
      const timeout = window.setTimeout(() => {
        finish(new Error('OpenCode server startup timed out.'));
      }, SERVER_START_TIMEOUT_MS);
      this.unregisterProcessClose = process.onClose(onClose);
      try {
        this.controller.signal.throwIfAborted();
        process.start();
        this.started = true;
        stdout = process.stdout;
        stdout.on('data', onData);
      } catch {
        finish(new Error('Could not start the OpenCode server.'));
      }
    });
  }

  private unregisterProcessClose: (() => void) | null = null;
}

async function allocateLoopbackPort(): Promise<number> {
  const probe = createNetServer();
  const port = await new Promise<number>((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      if (!address || typeof address === 'string') {
        reject(new Error('Could not allocate an OpenCode loopback port.'));
        return;
      }
      resolve(address.port);
    });
  });
  await new Promise<void>((resolve, reject) => {
    probe.close(error => error ? reject(error) : resolve());
  });
  return port;
}

function parseServerOrigin(line: string, expectedPort: number): string | null {
  let candidate: string | null = null;
  try {
    const response: unknown = JSON.parse(line);
    if (isRecord(response) && typeof response.url === 'string') {
      candidate = response.url;
    }
  } catch {
    const match = /^opencode server listening on (https?:\/\/\S+)$/iu.exec(line);
    candidate = match?.[1] ?? null;
  }
  if (!candidate) return null;

  try {
    const url = new URL(candidate);
    if (
      url.protocol !== 'http:' || url.hostname !== '127.0.0.1'
      || url.port !== String(expectedPort) || url.username || url.password
    ) {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
