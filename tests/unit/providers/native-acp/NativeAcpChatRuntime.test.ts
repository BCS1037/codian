import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { PassThrough } from 'node:stream';

import { NativeAcpChatRuntime } from '@/providers/native-acp/runtime/NativeAcpChatRuntime';
import type { NativeAcpSubprocess } from '@/providers/native-acp/runtime/types';

function createPlugin(basePath = '/tmp/codian-vault'): any {
  return {
    app: { vault: { adapter: { basePath } } },
    getResolvedProviderCliPath: jest.fn(() => null),
    settings: {},
  };
}

function createAcpAgent(
  respondToPrompt?: (prompt: Array<{ type: string }>) => string,
  options: {
    onClientResponse?: (message: any) => void;
    onPrompt?: (message: any, stdout: PassThrough) => void;
    initializeError?: string;
    sessionId?: string;
  } = {},
): NativeAcpSubprocess {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  let buffer = '';

  stdin.on('data', (chunk) => {
    buffer += chunk.toString();
    while (buffer.includes('\n')) {
      const newline = buffer.indexOf('\n');
      const message = JSON.parse(buffer.slice(0, newline));
      buffer = buffer.slice(newline + 1);
      if (message.method === 'initialize') {
        stdout.write(`${JSON.stringify({
          jsonrpc: '2.0',
          id: message.id,
          ...(options.initializeError
            ? { error: { code: -32000, message: options.initializeError } }
            : { result: { protocolVersion: 1, agentCapabilities: {} } }),
        })}\n`);
      } else if (message.method === 'session/new') {
        stdout.write(`${JSON.stringify({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: options.sessionId ?? 'native-session-1',
            update: {
              sessionUpdate: 'available_commands_update',
              availableCommands: [{
                name: 'compact',
                description: 'Compact context',
                input: { hint: 'optional focus' },
              }],
            },
          },
        })}\n`);
        stdout.write(`${JSON.stringify({
          jsonrpc: '2.0',
          id: message.id,
          result: { sessionId: options.sessionId ?? 'native-session-1' },
        })}\n`);
      } else if (message.method === 'session/load') {
        stdout.write(`${JSON.stringify({
          jsonrpc: '2.0',
          id: message.id,
          result: { sessionId: message.params.sessionId },
        })}\n`);
      } else if (message.method === 'session/prompt') {
        options.onPrompt?.(message, stdout);
        stdout.write(`${JSON.stringify({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: message.params.sessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              messageId: 'assistant-1',
              content: {
                type: 'text',
                text: respondToPrompt?.(message.params.prompt) ?? 'Hello from ACP',
              },
            },
          },
        })}\n`);
        stdout.write(`${JSON.stringify({
          jsonrpc: '2.0',
          id: message.id,
          result: { stopReason: 'end_turn' },
        })}\n`);
      } else if ('result' in message) {
        options.onClientResponse?.(message);
      }
    }
  });

  return {
    stdin,
    stdout,
    isAlive: () => true,
    onClose: () => () => {},
    shutdown: async () => {},
    start: () => {},
  };
}

describe('NativeAcpChatRuntime', () => {
  it('starts Grok through ACP and creates a native session', async () => {
    const launchSpecs: Array<{ args: string[]; command: string; cwd: string }> = [];
    const runtime = new NativeAcpChatRuntime(createPlugin(), {
      args: ['agent', 'stdio'],
      capabilities: { providerId: 'grok' } as any,
      createSubprocess: (spec) => {
        launchSpecs.push(spec);
        return createAcpAgent();
      },
      defaultCommand: 'grok',
      providerId: 'grok',
    });

    await expect(runtime.ensureReady()).resolves.toBe(true);
    expect(runtime.getSessionId()).toBe('native-session-1');
    expect(launchSpecs).toEqual([{
      args: ['agent', 'stdio'],
      command: 'grok',
      cwd: '/tmp/codian-vault',
      env: expect.any(Object),
    }]);

    runtime.cleanup();
  });

  it('streams native ACP messages through provider-neutral chunks', async () => {
    const runtime = new NativeAcpChatRuntime(createPlugin(), {
      args: ['acp'],
      capabilities: { providerId: 'kimi' } as any,
      createSubprocess: () => createAcpAgent(),
      defaultCommand: 'kimi',
      providerId: 'kimi',
    });

    const chunks = [];
    for await (const chunk of runtime.query(runtime.prepareTurn({ text: 'Hello' }))) {
      chunks.push(chunk);
    }

    expect(chunks).toEqual([
      { itemId: 'assistant-1', type: 'assistant_message_start' },
      { content: 'Hello from ACP', type: 'text' },
      { type: 'done' },
    ]);

    runtime.cleanup();
  });

  it('exposes commands announced by native ACP sessions', async () => {
    const runtime = new NativeAcpChatRuntime(createPlugin(), {
      args: ['agent', 'stdio'],
      capabilities: { providerId: 'grok' } as any,
      createSubprocess: () => createAcpAgent(),
      defaultCommand: 'grok',
      providerId: 'grok',
    });

    await runtime.ensureReady();

    await expect(runtime.getSupportedCommands()).resolves.toEqual([{
      argumentHint: 'optional focus',
      content: '',
      description: 'Compact context',
      id: 'acp:compact',
      name: 'compact',
      source: 'sdk',
    }]);

    runtime.cleanup();
  });

  it('sends image attachments as native ACP content blocks', async () => {
    const runtime = new NativeAcpChatRuntime(createPlugin(), {
      args: ['acp'],
      capabilities: { providerId: 'kimi' } as any,
      createSubprocess: () => createAcpAgent(prompt => prompt.map(block => block.type).join(',')),
      defaultCommand: 'kimi',
      providerId: 'kimi',
    });

    const text = [];
    const turn = runtime.prepareTurn({
      text: 'Inspect image',
      images: [{ data: 'aGVsbG8=', mediaType: 'image/png' } as any],
    });
    for await (const chunk of runtime.query(turn)) {
      if (chunk.type === 'text') {
        text.push(chunk.content);
      }
    }

    expect(text.join('')).toBe('text,image');
    runtime.cleanup();
  });

  it('reloads the requested native session when the active conversation changes', async () => {
    const launchedSessions: string[] = [];
    const runtime = new NativeAcpChatRuntime(createPlugin(), {
      args: ['acp'],
      capabilities: { providerId: 'kimi' } as any,
      createSubprocess: () => {
        const sessionId = `native-session-${launchedSessions.length + 1}`;
        launchedSessions.push(sessionId);
        return createAcpAgent(undefined, { sessionId });
      },
      defaultCommand: 'kimi',
      providerId: 'kimi',
    });

    await runtime.ensureReady();
    runtime.syncConversationState({ sessionId: 'saved-session', providerState: {}, selectedModel: '' });
    await runtime.ensureReady();

    expect(launchedSessions).toHaveLength(2);
    expect(runtime.getSessionId()).toBe('saved-session');
    runtime.cleanup();
  });

  it('maps native ACP approval options including allow-always selections', async () => {
    const clientResponses: any[] = [];
    const approvalCallback = jest.fn().mockResolvedValue('allow-always');
    const runtime = new NativeAcpChatRuntime(createPlugin(), {
      args: ['agent', 'stdio'],
      capabilities: { providerId: 'grok' } as any,
      createSubprocess: () => createAcpAgent(undefined, {
        onClientResponse: message => clientResponses.push(message),
        onPrompt: (message, stdout) => {
          stdout.write(`${JSON.stringify({
            jsonrpc: '2.0',
            id: 'permission-1',
            method: 'session/request_permission',
            params: {
              sessionId: message.params.sessionId,
              options: [
                { kind: 'allow_once', name: 'Allow once', optionId: 'once' },
                { kind: 'allow_always', name: 'Always allow', optionId: 'always' },
                { kind: 'reject_once', name: 'Reject', optionId: 'reject' },
              ],
              toolCall: { title: 'Shell', rawInput: { command: 'pwd' } },
            },
          })}\n`);
        },
      }),
      defaultCommand: 'grok',
      providerId: 'grok',
    });
    runtime.setApprovalCallback(approvalCallback);

    const chunks = [];
    for await (const chunk of runtime.query(runtime.prepareTurn({ text: 'Run pwd' }))) {
      chunks.push(chunk);
    }
    expect(chunks.at(-1)).toEqual({ type: 'done' });

    expect(approvalCallback).toHaveBeenCalledWith(
      'Shell',
      { command: 'pwd' },
      'Shell',
      { decisionOptions: [
        { decision: 'allow', label: 'Allow once', value: 'once' },
        { decision: 'allow-always', label: 'Always allow', value: 'always' },
        { label: 'Reject', value: 'reject' },
      ] },
    );
    expect(clientResponses).toContainEqual(expect.objectContaining({
      id: 'permission-1',
      result: { outcome: { optionId: 'always', outcome: 'selected' } },
    }));
    runtime.cleanup();
  });

  it('resolves ACP file requests against the session cwd and honors line ranges', async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'codian-native-acp-'));
    await fs.writeFile(path.join(cwd, 'notes.md'), 'one\ntwo\nthree\n', 'utf8');
    const clientResponses: any[] = [];
    const runtime = new NativeAcpChatRuntime(createPlugin(cwd), {
      args: ['acp'],
      capabilities: { providerId: 'kimi' } as any,
      createSubprocess: () => createAcpAgent(undefined, {
        onClientResponse: message => clientResponses.push(message),
        onPrompt: (message, stdout) => {
          stdout.write(`${JSON.stringify({
            jsonrpc: '2.0',
            id: 'read-1',
            method: 'fs/read_text_file',
            params: { sessionId: message.params.sessionId, path: 'notes.md', line: 2, limit: 1 },
          })}\n`);
          stdout.write(`${JSON.stringify({
            jsonrpc: '2.0',
            id: 'write-1',
            method: 'fs/write_text_file',
            params: {
              sessionId: message.params.sessionId,
              path: 'nested/result.md',
              content: 'written',
            },
          })}\n`);
        },
      }),
      defaultCommand: 'kimi',
      providerId: 'kimi',
    });

    const streamedChunks = [];
    for await (const chunk of runtime.query(runtime.prepareTurn({ text: 'Read and write' }))) {
      streamedChunks.push(chunk);
    }
    expect(streamedChunks.at(-1)).toEqual({ type: 'done' });
    for (let attempt = 0; attempt < 20 && clientResponses.length < 2; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }

    expect(clientResponses).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'read-1', result: { content: 'two' } }),
      expect.objectContaining({ id: 'write-1', result: {} }),
    ]));
    await expect(fs.readFile(path.join(cwd, 'nested/result.md'), 'utf8')).resolves.toBe('written');
    runtime.cleanup();
    await fs.rm(cwd, { recursive: true, force: true });
  });

  it('surfaces the provider ACP startup error in the chat stream', async () => {
    const runtime = new NativeAcpChatRuntime(createPlugin(), {
      args: ['acp'],
      capabilities: { providerId: 'kimi' } as any,
      createSubprocess: () => createAcpAgent(undefined, { initializeError: 'Login required' }),
      defaultCommand: 'kimi',
      providerId: 'kimi',
    });

    const chunks = [];
    for await (const chunk of runtime.query(runtime.prepareTurn({ text: 'Hello' }))) {
      chunks.push(chunk);
    }

    expect(chunks).toEqual([
      { type: 'error', content: 'Failed to start kimi: Login required' },
      { type: 'done' },
    ]);
    runtime.cleanup();
  });
});
