import type {
  OpencodeHttpClient,
  OpencodeHttpEvent,
} from '@/providers/opencode/http/OpencodeHttpClient';
import { OpencodeHttpError } from '@/providers/opencode/http/OpencodeHttpClient';
import {
  OpencodeHttpSessionConnection,
} from '@/providers/opencode/http/OpencodeHttpSessionConnection';

function createClientHarness(
  sessionModel = { providerID: 'openai', id: 'gpt-4.1' },
  catalogs: {
    commands?: Array<Record<string, unknown>>;
    commandSnapshots?: Array<Array<Record<string, unknown>>>;
    skills?: Array<Record<string, unknown>>;
    skillError?: number;
  } = {},
) {
  const requests: Array<{ body?: unknown; method: string; route: string }> = [];
  let onEvent: ((event: OpencodeHttpEvent) => void) | undefined;
  let commandReadIndex = 0;
  const client = {
    async dispose() {},
    async request<T>(route: string, options: { body?: unknown; method?: string } = {}): Promise<T> {
      requests.push({ body: options.body, method: options.method ?? 'GET', route });
      if (route === '/api/model') {
        return {
          data: [{
            id: 'gpt-4.1',
            limit: { context: 128_000 },
            name: 'GPT-4.1',
            providerID: 'openai',
            variants: [{ id: 'low' }, { id: 'high' }],
          }, {
            id: 'nemotron-3-ultra-free',
            name: 'Nemotron 3 Ultra Free',
            providerID: 'opencode',
            variants: [],
          }],
        } as T;
      }
      if (route === '/api/command') {
        const snapshot = catalogs.commandSnapshots?.[
          Math.min(commandReadIndex, (catalogs.commandSnapshots?.length ?? 1) - 1)
        ];
        commandReadIndex += 1;
        return { data: snapshot ?? catalogs.commands ?? [{ name: 'review', description: 'Review changes' }] } as T;
      }
      if (route === '/api/skill') {
        if (catalogs.skillError) throw new OpencodeHttpError(catalogs.skillError, 'Skill route unavailable.');
        return { data: catalogs.skills ?? [] } as T;
      }
      if (route === '/api/session' && options.method === 'POST') {
        return { data: { id: 'native-session-1', model: sessionModel } } as T;
      }
      if (route === '/api/session/native-session-1') {
        return { data: { id: 'native-session-1', model: sessionModel } } as T;
      }
      if (route.endsWith('/prompt') || route.endsWith('/command')) {
        return { data: { id: 'message-1' } } as T;
      }
      return {} as T;
    },
    async subscribe(listener: (event: OpencodeHttpEvent) => void) {
      onEvent = listener;
    },
  } as unknown as OpencodeHttpClient;
  return {
    client,
    emit(event: OpencodeHttpEvent) { onEvent?.(event); },
    requests,
  };
}

describe('OpencodeHttpSessionConnection', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('discovers native models and commands, then opens a resumable v2 session', async () => {
    const harness = createClientHarness();
    const onSessionNotification = jest.fn();
    const connection = new OpencodeHttpSessionConnection(harness.client, '/vault/project', {
      onSessionNotification,
    });

    await connection.initialize();
    const session = await connection.newSession({ cwd: '/vault/project', mcpServers: [] });

    expect(session).toMatchObject({
      sessionId: 'native-session-1',
      models: {
        availableModels: [
          { modelId: 'openai/gpt-4.1', name: 'openai/GPT-4.1' },
          { modelId: 'opencode/nemotron-3-ultra-free', name: 'opencode/Nemotron 3 Ultra Free' },
        ],
      },
    });
    expect(harness.requests).toContainEqual({
      method: 'GET', route: '/api/model',
    });
    expect(harness.requests).not.toContainEqual({
      method: 'GET', route: '/provider',
    });
    expect(onSessionNotification).toHaveBeenCalledWith({
      sessionId: 'native-session-1',
      update: {
        sessionUpdate: 'available_commands_update',
        availableCommands: [{ name: 'review', description: 'Review changes', kind: 'command' }],
      },
    });
    expect(harness.requests).toContainEqual({ method: 'POST', route: '/api/session', body: {
      location: { directory: '/vault/project' },
    } });

    await connection.dispose();
  });

  it('discovers native skills and keeps a same-named command as the slash invocation', async () => {
    const harness = createClientHarness(undefined, {
      commands: [{ name: 'review', description: 'Review changes' }],
      skills: [
        { id: 'review', description: 'Conflicts with command' },
        { id: 'research.deep', description: 'Research a topic' },
      ],
    });
    const onSessionNotification = jest.fn();
    const connection = new OpencodeHttpSessionConnection(harness.client, '/vault/project', {
      onSessionNotification,
    });

    await connection.initialize();
    await connection.newSession({ cwd: '/vault/project', mcpServers: [] });

    expect(harness.requests).toContainEqual({ method: 'GET', route: '/api/skill' });
    expect(onSessionNotification).toHaveBeenCalledWith({
      sessionId: 'native-session-1',
      update: {
        sessionUpdate: 'available_commands_update',
        availableCommands: [
          { name: 'review', description: 'Review changes', kind: 'command' },
          { name: 'research.deep', description: 'Research a topic', kind: 'skill' },
        ],
      },
    });

    await connection.dispose();
  });

  it('submits a selected Skill as a prompt while a colliding native command keeps command routing', async () => {
    const harness = createClientHarness(undefined, {
      commands: [{ name: 'review', description: 'Review changes' }],
      skills: [
        { id: 'review', description: 'Conflicts with command' },
        { id: 'research.deep', description: 'Research a topic' },
      ],
    });
    const connection = new OpencodeHttpSessionConnection(harness.client, '/vault/project', {
      onSessionNotification: jest.fn(),
    });
    await connection.initialize();
    await connection.newSession({ cwd: '/vault/project', mcpServers: [] });

    const skillCompletion = connection.prompt({
      messageId: 'selected-skill',
      prompt: [{ type: 'text', text: '/research.deep' }],
      sessionId: 'native-session-1',
    }, { start: 0, end: '/research.deep'.length });
    await new Promise((resolve) => setImmediate(resolve));

    expect(harness.requests).toContainEqual(expect.objectContaining({
      method: 'POST',
      route: '/api/session/native-session-1/prompt',
      body: expect.objectContaining({
        skills: [{
          id: 'research.deep',
          mention: { end: 14, start: 0, text: '/research.deep' },
        }],
      }),
    }));
    harness.emit({ type: 'session.execution.started', data: { sessionID: 'native-session-1' } });
    harness.emit({ type: 'session.execution.succeeded', data: { sessionID: 'native-session-1' } });
    await expect(skillCompletion).resolves.toMatchObject({ stopReason: 'end_turn' });

    const commandCompletion = connection.prompt({
      messageId: 'selected-command',
      prompt: [{ type: 'text', text: '/review' }],
      sessionId: 'native-session-1',
    }, { start: 0, end: '/review'.length });
    await expect(commandCompletion).resolves.toMatchObject({ stopReason: 'end_turn' });
    expect(harness.requests).toContainEqual(expect.objectContaining({
      method: 'POST',
      route: '/api/session/native-session-1/command',
      body: { name: 'review', text: '' },
    }));

    await connection.dispose();
  });

  it('continues command discovery when an older V2 server has no skill route', async () => {
    const harness = createClientHarness(undefined, { skillError: 404 });
    const onSessionNotification = jest.fn();
    const connection = new OpencodeHttpSessionConnection(harness.client, '/vault/project', {
      onSessionNotification,
    });

    await expect(connection.initialize()).resolves.toBeUndefined();
    await connection.newSession({ cwd: '/vault/project', mcpServers: [] });

    expect(onSessionNotification).toHaveBeenCalledWith(expect.objectContaining({
      update: expect.objectContaining({
        sessionUpdate: 'available_commands_update',
        availableCommands: [{ name: 'review', description: 'Review changes', kind: 'command' }],
      }),
    }));
    await connection.dispose();
  });

  it('waits for the native command catalog to load before publishing commands', async () => {
    jest.useFakeTimers();
    const harness = createClientHarness(undefined, {
      commandSnapshots: [[], [{ name: 'review', description: 'Review changes' }]],
    });
    const onSessionNotification = jest.fn();
    const connection = new OpencodeHttpSessionConnection(harness.client, '/vault/project', {
      onSessionNotification,
    });

    await connection.initialize();
    await connection.newSession({ cwd: '/vault/project', mcpServers: [] });
    expect(onSessionNotification).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(25);

    expect(onSessionNotification).toHaveBeenCalledWith({
      sessionId: 'native-session-1',
      update: {
        sessionUpdate: 'available_commands_update',
        availableCommands: [{ name: 'review', description: 'Review changes', kind: 'command' }],
      },
    });
    await connection.dispose();
  });

  it('maps model, agent, and effort config changes onto native session routes', async () => {
    const harness = createClientHarness();
    const connection = new OpencodeHttpSessionConnection(harness.client, '/vault/project', {
      onSessionNotification: jest.fn(),
    });
    await connection.initialize();
    await connection.newSession({ cwd: '/vault/project', mcpServers: [] });

    await connection.setConfigOption({
      configId: 'model', sessionId: 'native-session-1', type: 'select', value: 'openai/gpt-4.1',
    });
    await connection.setConfigOption({
      configId: 'mode', sessionId: 'native-session-1', type: 'select', value: 'plan',
    });
    const effort = await connection.setConfigOption({
      configId: 'effort', sessionId: 'native-session-1', type: 'select', value: 'high',
    });

    expect(harness.requests).toContainEqual({
      method: 'POST', route: '/api/session/native-session-1/model',
      body: { model: { providerID: 'openai', id: 'gpt-4.1' } },
    });
    expect(harness.requests).toContainEqual({
      method: 'POST', route: '/api/session/native-session-1/agent', body: { agent: 'plan' },
    });
    expect(harness.requests).toContainEqual({
      method: 'POST', route: '/api/session/native-session-1/model',
      body: { model: { providerID: 'openai', id: 'gpt-4.1', variant: 'high' } },
    });
    expect(effort.configOptions).toEqual([expect.objectContaining({
      category: 'thought_level', currentValue: 'high', id: 'effort', type: 'select',
      options: expect.arrayContaining([expect.objectContaining({ value: 'high' })]),
    })]);

    await connection.dispose();
  });

  it('does not offer legacy effort variants for V2 models without V2 variants', async () => {
    const harness = createClientHarness({ providerID: 'opencode', id: 'nemotron-3-ultra-free' });
    const connection = new OpencodeHttpSessionConnection(harness.client, '/vault/project', {
      onSessionNotification: jest.fn(),
    });

    await connection.initialize();
    const session = await connection.newSession({ cwd: '/vault/project', mcpServers: [] });
    const selected = await connection.setConfigOption({
      configId: 'model', sessionId: 'native-session-1', type: 'select',
      value: 'opencode/nemotron-3-ultra-free',
    });

    expect(session.configOptions).toEqual([]);
    expect(selected.configOptions).toEqual([]);
    expect(harness.requests).toContainEqual({
      method: 'POST', route: '/api/session/native-session-1/model',
      body: { model: { providerID: 'opencode', id: 'nemotron-3-ultra-free' } },
    });
    expect(harness.requests).not.toContainEqual(expect.objectContaining({
      route: '/api/session/native-session-1/model',
      body: expect.objectContaining({ model: expect.objectContaining({ variant: 'medium' }) }),
    }));

    await connection.dispose();
  });

  it('routes native child tools and reports background completion against parent task', async () => {
    const harness = createClientHarness();
    const onAsyncSubagentCompletion = jest.fn();
    const childChunks: unknown[] = [];
    const connection = new OpencodeHttpSessionConnection(harness.client, '/vault/project', {
      onAsyncSubagentCompletion,
      onSessionNotification: jest.fn(),
      onSubagentChunk: (chunk) => childChunks.push(chunk),
    });
    await connection.initialize();
    await connection.newSession({ cwd: '/vault/project', mcpServers: [] });

    harness.emit({ type: 'session.tool.input.started', data: {
      assistantMessageID: 'parent-message', id: 'task-1', name: 'task',
      sessionID: 'native-session-1',
    } });
    harness.emit({ type: 'session.tool.called', data: {
      assistantMessageID: 'parent-message', id: 'task-1', input: { background: true }, name: 'task',
      sessionID: 'native-session-1',
    } });
    harness.emit({ type: 'session.tool.progress', data: {
      assistantMessageID: 'parent-message', id: 'task-1',
      metadata: { sessionID: 'native-child-1', status: 'running' },
      sessionID: 'native-session-1',
    } });
    harness.emit({ type: 'session.text.delta', data: {
      assistantMessageID: 'child-message', delta: 'Child ', ordinal: 0,
      sessionID: 'native-child-1',
    } });
    harness.emit({ type: 'session.text.ended', data: {
      assistantMessageID: 'child-message', ordinal: 0, sessionID: 'native-child-1',
      text: 'Child finished',
    } });
    harness.emit({ type: 'session.tool.input.started', data: {
      assistantMessageID: 'child-message', id: 'read-1', name: 'read',
      sessionID: 'native-child-1',
    } });
    harness.emit({ type: 'session.tool.called', data: {
      assistantMessageID: 'child-message', id: 'read-1', input: { filePath: 'notes.md' },
      sessionID: 'native-child-1',
    } });
    harness.emit({ type: 'session.tool.success', data: {
      assistantMessageID: 'child-message', id: 'read-1',
      content: [{ text: 'Contents', type: 'text' }], sessionID: 'native-child-1',
    } });
    harness.emit({ type: 'session.execution.succeeded', data: { sessionID: 'native-child-1' } });
    harness.emit({ type: 'session.text.delta', data: {
      assistantMessageID: 'other-message', delta: 'unrelated', ordinal: 0,
      sessionID: 'unrelated-session',
    } });

    expect(childChunks).toEqual([]);
    expect(onAsyncSubagentCompletion).toHaveBeenCalledWith({
      type: 'async_subagent_completion',
      providerSessionId: 'native-session-1',
      taskId: 'native-child-1',
      toolUseId: 'task-1',
      status: 'completed',
      result: 'Child finished',
    });

    await connection.dispose();
  });

  it('streams synchronous child tool calls into the owning task block', async () => {
    const harness = createClientHarness();
    const childChunks: unknown[] = [];
    const connection = new OpencodeHttpSessionConnection(harness.client, '/vault/project', {
      onSessionNotification: jest.fn(),
      onSubagentChunk: (chunk) => childChunks.push(chunk),
    });
    await connection.initialize();
    await connection.newSession({ cwd: '/vault/project', mcpServers: [] });

    harness.emit({ type: 'session.tool.called', data: {
      assistantMessageID: 'parent-message', id: 'task-sync', input: { background: false },
      sessionID: 'native-session-1', name: 'task',
    } });
    harness.emit({ type: 'session.tool.progress', data: {
      assistantMessageID: 'parent-message', id: 'task-sync',
      metadata: { sessionID: 'native-child-sync', status: 'running' },
      sessionID: 'native-session-1',
    } });
    harness.emit({ type: 'session.tool.called', data: {
      assistantMessageID: 'child-message', id: 'write-1', input: { filePath: 'notes.md' },
      sessionID: 'native-child-sync', name: 'write',
    } });
    harness.emit({ type: 'session.tool.success', data: {
      assistantMessageID: 'child-message', id: 'write-1',
      content: [{ text: 'Saved', type: 'text' }], sessionID: 'native-child-sync',
    } });

    expect(childChunks).toEqual([
      {
        type: 'subagent_tool_use', subagentId: 'task-sync',
        id: 'native-child-sync:write-1', name: 'Write', input: { file_path: 'notes.md' },
      },
      {
        type: 'subagent_tool_result', subagentId: 'task-sync',
        id: 'native-child-sync:write-1', content: 'Saved', isError: false,
        toolUseResult: { filePath: 'notes.md' },
      },
    ]);

    await connection.dispose();
  });

  it('routes child-session permission requests back to the child endpoint', async () => {
    const harness = createClientHarness();
    const requestPermission = jest.fn().mockResolvedValue({
      outcome: { outcome: 'selected', optionId: 'allow_once' },
    });
    const connection = new OpencodeHttpSessionConnection(harness.client, '/vault/project', {
      onSessionNotification: jest.fn(),
      requestPermission,
    });
    await connection.initialize();
    await connection.newSession({ cwd: '/vault/project', mcpServers: [] });
    harness.emit({ type: 'session.tool.called', data: {
      assistantMessageID: 'parent-message', id: 'task-approval', input: { background: true },
      name: 'task', sessionID: 'native-session-1',
    } });
    harness.emit({ type: 'session.tool.progress', data: {
      assistantMessageID: 'parent-message', id: 'task-approval',
      metadata: { sessionID: 'native-child-approval', status: 'running' },
      sessionID: 'native-session-1',
    } });

    harness.emit({ type: 'permission.asked', data: {
      action: 'bash', id: 'approval-child', resources: ['pwd'],
      sessionID: 'native-child-approval',
    } });
    await new Promise((resolve) => setImmediate(resolve));

    expect(requestPermission).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'native-child-approval',
      toolCall: expect.objectContaining({ toolCallId: 'approval-child', title: 'bash' }),
    }));
    expect(harness.requests).toContainEqual({
      method: 'POST', route: '/api/session/native-child-approval/permission/approval-child/reply',
      body: { decision: 'once' },
    });

    await connection.dispose();
  });

  it('projects native text/tool events into existing ACP normalization and resolves prompt on terminal event', async () => {
    const harness = createClientHarness();
    const onSessionNotification = jest.fn();
    const connection = new OpencodeHttpSessionConnection(harness.client, '/vault/project', {
      onSessionNotification,
    });
    await connection.initialize();
    await connection.newSession({ cwd: '/vault/project', mcpServers: [] });

    const completion = connection.prompt({
      messageId: 'user-message-1',
      prompt: [
        { type: 'text', text: 'hello' },
        { type: 'image', data: 'aW1hZ2U=', mimeType: 'image/png' },
      ],
      sessionId: 'native-session-1',
    });
    await Promise.resolve();
    expect(harness.requests).toContainEqual({
      method: 'POST',
      route: '/api/session/native-session-1/prompt',
      body: {
        id: 'user-message-1',
        prompt: {
          text: 'hello',
          files: [{ mime: 'image/png', uri: 'data:image/png;base64,aW1hZ2U=' }],
        },
      },
    });

    harness.emit({ type: 'session.execution.started', data: { sessionID: 'native-session-1' } });
    harness.emit({ type: 'session.text.delta', data: {
      assistantMessageID: 'assistant-1', delta: 'world', ordinal: 0, sessionID: 'native-session-1',
    } });
    harness.emit({ type: 'session.tool.called', data: {
      assistantMessageID: 'assistant-1', id: 'tool-1', input: { command: 'pwd' },
      name: 'bash', sessionID: 'native-session-1',
    } });
    harness.emit({ type: 'session.tool.success', data: {
      assistantMessageID: 'assistant-1', content: [{ text: '/vault/project' }],
      id: 'tool-1', sessionID: 'native-session-1',
    } });
    harness.emit({ type: 'session.execution.succeeded', data: { sessionID: 'native-session-1' } });

    await expect(completion).resolves.toMatchObject({ stopReason: 'end_turn', userMessageId: 'message-1' });
    expect(onSessionNotification).toHaveBeenCalledWith({
      sessionId: 'native-session-1',
      update: {
        sessionUpdate: 'agent_message_chunk',
        messageId: 'assistant-1',
        content: { type: 'text', text: 'world' },
      },
    });
    expect(onSessionNotification).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'native-session-1',
      update: expect.objectContaining({
        sessionUpdate: 'tool_call', toolCallId: 'tool-1', title: 'bash', rawInput: { command: 'pwd' },
      }),
    }));
    expect(onSessionNotification).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'native-session-1',
      update: expect.objectContaining({
        sessionUpdate: 'tool_call_update', toolCallId: 'tool-1', status: 'completed',
      }),
    }));

    await connection.dispose();
  });

  it('streams native message parts and finishes on a completed assistant message', async () => {
    const harness = createClientHarness();
    const onSessionNotification = jest.fn();
    const connection = new OpencodeHttpSessionConnection(harness.client, '/vault/project', {
      onSessionNotification,
    });
    await connection.initialize();
    await connection.newSession({ cwd: '/vault/project', mcpServers: [] });

    const completion = connection.prompt({
      prompt: [{ type: 'text', text: 'hello' }],
      sessionId: 'native-session-1',
    });
    await Promise.resolve();
    harness.emit({ type: 'message.updated', data: {
      info: { id: 'message-1', role: 'user', sessionID: 'native-session-1' },
      sessionID: 'native-session-1',
    } });
    harness.emit({ type: 'message.updated', data: {
      info: { id: 'assistant-1', role: 'assistant', sessionID: 'native-session-1' },
      sessionID: 'native-session-1',
    } });
    harness.emit({ type: 'message.part.updated', data: {
      part: {
        id: 'part-1', messageID: 'assistant-1', sessionID: 'native-session-1', text: 'v2 stream',
        type: 'text',
      },
      sessionID: 'native-session-1',
    } });
    harness.emit({ type: 'message.updated', data: {
      info: {
        id: 'assistant-1', role: 'assistant', sessionID: 'native-session-1',
        time: { completed: 2 },
      },
      sessionID: 'native-session-1',
    } });

    await expect(completion).resolves.toMatchObject({
      stopReason: 'end_turn', userMessageId: 'message-1',
    });
    expect(onSessionNotification).toHaveBeenCalledWith({
      sessionId: 'native-session-1',
      update: {
        sessionUpdate: 'agent_message_chunk',
        messageId: 'assistant-1',
        content: { type: 'text', text: 'v2 stream' },
      },
    });
    await connection.dispose();
  });

  it('streams and completes V2 session.next events', async () => {
    const harness = createClientHarness();
    const onSessionNotification = jest.fn();
    const connection = new OpencodeHttpSessionConnection(harness.client, '/vault/project', {
      onSessionNotification,
    });
    await connection.initialize();
    await connection.newSession({ cwd: '/vault/project', mcpServers: [] });

    const completion = connection.prompt({
      prompt: [{ type: 'text', text: 'synthetic V2 event probe' }],
      sessionId: 'native-session-1',
    });
    await Promise.resolve();
    harness.emit({ type: 'session.next.step.started', data: {
      agent: 'build', assistantMessageID: 'assistant-v2', model: { id: 'nemotron-3-ultra-free' },
      sessionID: 'native-session-1', timestamp: 1,
    } });
    harness.emit({ type: 'session.next.text.started', data: {
      assistantMessageID: 'assistant-v2', sessionID: 'native-session-1', textID: 'text-v2', timestamp: 2,
    } });
    harness.emit({ type: 'session.next.text.delta', data: {
      assistantMessageID: 'assistant-v2', delta: 'V2 native stream', sessionID: 'native-session-1',
      textID: 'text-v2', timestamp: 3,
    } });
    harness.emit({ type: 'session.next.text.ended', data: {
      assistantMessageID: 'assistant-v2', sessionID: 'native-session-1', text: 'V2 native stream',
      textID: 'text-v2', timestamp: 4,
    } });
    harness.emit({ type: 'session.next.step.ended', data: {
      assistantMessageID: 'assistant-v2', finish: 'stop', sessionID: 'native-session-1', timestamp: 5,
    } });

    await expect(completion).resolves.toMatchObject({
      stopReason: 'end_turn', userMessageId: 'message-1',
    });
    expect(onSessionNotification).toHaveBeenCalledWith({
      sessionId: 'native-session-1',
      update: {
        sessionUpdate: 'agent_message_chunk',
        messageId: 'assistant-v2',
        content: { type: 'text', text: 'V2 native stream' },
      },
    });
    await connection.dispose();
  });

  it('attaches native Skills mentioned by the user and ignores context-only slash tokens', async () => {
    const harness = createClientHarness(undefined, {
      skills: [
        { id: 'research.deep', description: 'Research a topic' },
        { id: 'context-only', description: 'Must not be attached' },
      ],
    });
    const connection = new OpencodeHttpSessionConnection(harness.client, '/vault/project', {
      onSessionNotification: jest.fn(),
    });
    await connection.initialize();
    await connection.newSession({ cwd: '/vault/project', mcpServers: [] });

    const typed = 'Please use /research.deep.';
    const text = `${typed}\n\n<current_note>/context-only</current_note>`;
    const completion = connection.prompt({
      messageId: 'user-skill-message',
      prompt: [{ type: 'text', text }],
      sessionId: 'native-session-1',
    }, { start: 0, end: typed.length });
    await new Promise((resolve) => setImmediate(resolve));

    const promptRequest = harness.requests.find((request) => request.route.endsWith('/prompt'));
    expect(promptRequest?.body).toMatchObject({
      prompt: { text },
      skills: [{
        id: 'research.deep',
        mention: {
          end: 25,
          start: 11,
          text: '/research.deep',
        },
      }],
    });
    expect(promptRequest?.body).toMatchObject({
      skills: [{ id: 'research.deep', mention: { text: '/research.deep' } }],
    });
    expect(JSON.stringify(promptRequest?.body)).not.toContain('"id":"context-only"');

    harness.emit({ type: 'session.execution.started', data: { sessionID: 'native-session-1' } });
    harness.emit({ type: 'session.execution.succeeded', data: { sessionID: 'native-session-1' } });
    await expect(completion).resolves.toMatchObject({ stopReason: 'end_turn' });
    await connection.dispose();
  });

  it('does not query or attach a Skill when slash text exists only in appended context', async () => {
    const harness = createClientHarness(undefined, {
      skills: [{ id: 'hidden.context', description: 'Context-only skill' }],
    });
    const connection = new OpencodeHttpSessionConnection(harness.client, '/vault/project', {
      onSessionNotification: jest.fn(),
    });
    await connection.initialize();
    await connection.newSession({ cwd: '/vault/project', mcpServers: [] });
    harness.requests.splice(0);

    const typed = 'Summarize this note';
    const text = `${typed}\n\n<current_note>/hidden.context</current_note>`;
    const completion = connection.prompt({
      messageId: 'user-context-message',
      prompt: [{ type: 'text', text }],
      sessionId: 'native-session-1',
    }, { start: 0, end: typed.length });
    await new Promise((resolve) => setImmediate(resolve));

    const promptRequest = harness.requests.find((request) => request.route.endsWith('/prompt'));
    expect(harness.requests).not.toContainEqual(expect.objectContaining({ route: '/api/skill' }));
    expect(promptRequest?.body).toMatchObject({ prompt: { text } });
    expect(promptRequest?.body).not.toHaveProperty('skills');

    harness.emit({ type: 'session.execution.started', data: { sessionID: 'native-session-1' } });
    harness.emit({ type: 'session.execution.succeeded', data: { sessionID: 'native-session-1' } });
    await expect(completion).resolves.toMatchObject({ stopReason: 'end_turn' });
    await connection.dispose();
  });

  it('interrupts V2 sessions through the native interrupt route', async () => {
    const harness = createClientHarness();
    const connection = new OpencodeHttpSessionConnection(harness.client, '/vault/project', {
      onSessionNotification: jest.fn(),
    });
    await connection.initialize();
    await connection.newSession({ cwd: '/vault/project', mcpServers: [] });

    const completion = connection.prompt({
      prompt: [{ type: 'text', text: 'synthetic cancellation probe' }],
      sessionId: 'native-session-1',
    });
    await Promise.resolve();
    connection.cancel({ sessionId: 'native-session-1' });

    await expect(completion).resolves.toMatchObject({ stopReason: 'cancelled' });
    expect(harness.requests).toContainEqual({
      method: 'POST', route: '/api/session/native-session-1/interrupt', body: undefined,
    });
    expect(harness.requests).not.toContainEqual(expect.objectContaining({
      route: '/api/session/native-session-1/interrupt?resume=false',
    }));
    await connection.dispose();
  });

  it('projects V2 session.next tool events and keeps tool-call steps open', async () => {
    const harness = createClientHarness();
    const onSessionNotification = jest.fn();
    const connection = new OpencodeHttpSessionConnection(harness.client, '/vault/project', {
      onSessionNotification,
    });
    await connection.initialize();
    await connection.newSession({ cwd: '/vault/project', mcpServers: [] });

    const completion = connection.prompt({
      prompt: [{ type: 'text', text: 'synthetic V2 tool probe' }],
      sessionId: 'native-session-1',
    });
    await Promise.resolve();
    harness.emit({ type: 'session.next.step.started', data: {
      assistantMessageID: 'assistant-tool', sessionID: 'native-session-1', timestamp: 1,
    } });
    harness.emit({ type: 'session.next.tool.input.started', data: {
      assistantMessageID: 'assistant-tool', callID: 'tool-v2', name: 'bash',
      sessionID: 'native-session-1', timestamp: 2,
    } });
    harness.emit({ type: 'session.next.tool.input.delta', data: {
      assistantMessageID: 'assistant-tool', callID: 'tool-v2', delta: '{"command":"pwd"}',
      sessionID: 'native-session-1', timestamp: 3,
    } });
    harness.emit({ type: 'session.next.tool.input.ended', data: {
      assistantMessageID: 'assistant-tool', callID: 'tool-v2', text: '{"command":"pwd"}',
      sessionID: 'native-session-1', timestamp: 4,
    } });
    harness.emit({ type: 'session.next.tool.called', data: {
      assistantMessageID: 'assistant-tool', callID: 'tool-v2', input: { command: 'pwd' },
      provider: 'opencode', sessionID: 'native-session-1', timestamp: 5, tool: 'bash',
    } });
    harness.emit({ type: 'session.next.tool.success', data: {
      assistantMessageID: 'assistant-tool', callID: 'tool-v2',
      content: [{ text: '/vault/project', type: 'text' }], provider: 'opencode',
      sessionID: 'native-session-1', timestamp: 6,
    } });
    harness.emit({ type: 'session.next.step.ended', data: {
      assistantMessageID: 'assistant-tool', finish: 'tool-calls', sessionID: 'native-session-1', timestamp: 7,
    } });
    harness.emit({ type: 'session.next.step.started', data: {
      assistantMessageID: 'assistant-final', sessionID: 'native-session-1', timestamp: 8,
    } });
    harness.emit({ type: 'session.next.text.delta', data: {
      assistantMessageID: 'assistant-final', delta: '/vault/project', sessionID: 'native-session-1',
      textID: 'text-final', timestamp: 9,
    } });
    harness.emit({ type: 'session.next.step.ended', data: {
      assistantMessageID: 'assistant-final', finish: 'stop', sessionID: 'native-session-1', timestamp: 10,
    } });

    await expect(completion).resolves.toMatchObject({ stopReason: 'end_turn' });
    expect(onSessionNotification).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'native-session-1',
      update: expect.objectContaining({
        sessionUpdate: 'tool_call', toolCallId: 'tool-v2', title: 'bash', rawInput: { command: 'pwd' },
      }),
    }));
    expect(onSessionNotification).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'native-session-1',
      update: expect.objectContaining({
        sessionUpdate: 'tool_call_update', toolCallId: 'tool-v2', status: 'completed',
        content: [{ type: 'content', content: { type: 'text', text: '/vault/project' } }],
      }),
    }));
    await connection.dispose();
  });

  it('finishes a V2 prompt with a sanitized completed-message API error', async () => {
    const harness = createClientHarness();
    const connection = new OpencodeHttpSessionConnection(harness.client, '/vault/project', {
      onSessionNotification: jest.fn(),
    });
    await connection.initialize();
    await connection.newSession({ cwd: '/vault/project', mcpServers: [] });

    const completion = connection.prompt({
      prompt: [{ type: 'text', text: 'synthetic error probe' }],
      sessionId: 'native-session-1',
    });
    await Promise.resolve();
    harness.emit({ type: 'message.updated', data: {
      info: {
        error: {
          data: { message: 'private provider response body', statusCode: 403 },
          name: 'APIError',
        },
        id: 'assistant-error',
        role: 'assistant',
        sessionID: 'native-session-1',
        time: { completed: 2 },
      },
      sessionID: 'native-session-1',
    } });

    const outcome = await Promise.race([
      completion.then(
        () => 'resolved',
        error => `rejected:${error instanceof Error ? error.message : String(error)}`,
      ),
      new Promise<string>(resolve => setTimeout(() => resolve('pending'), 150)),
    ]);
    expect(outcome).toBe('rejected:OpenCode request failed with HTTP 403.');
    expect(outcome).not.toContain('private provider response body');
    await connection.dispose();
  });

  it('routes native permission requests through existing ACP approval handling', async () => {
    const harness = createClientHarness();
    const requestPermission = jest.fn().mockResolvedValue({
      outcome: { optionId: 'allow_once', outcome: 'selected' },
    });
    const connection = new OpencodeHttpSessionConnection(harness.client, '/vault/project', {
      onSessionNotification: jest.fn(),
      requestPermission,
    });
    await connection.initialize();
    await connection.newSession({ cwd: '/vault/project', mcpServers: [] });
    harness.emit({ type: 'permission.asked', data: {
      action: 'bash', id: 'approval-1', message: 'Run command?', resources: ['pwd'], sessionID: 'native-session-1',
    } });
    await Promise.resolve();
    await Promise.resolve();

    expect(requestPermission).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'native-session-1',
      toolCall: expect.objectContaining({ toolCallId: 'approval-1', title: 'bash' }),
    }));
    expect(harness.requests).toContainEqual(expect.objectContaining({
      method: 'POST', route: '/api/session/native-session-1/permission/approval-1/reply',
      body: { decision: 'once' },
    }));

    await connection.dispose();
  });

  it('routes supported native question forms through the shared question callback', async () => {
    const harness = createClientHarness();
    const askUserQuestion = jest.fn().mockResolvedValue({ strategy: 'fast' });
    const connection = new OpencodeHttpSessionConnection(harness.client, '/vault/project', {
      askUserQuestion,
      onSessionNotification: jest.fn(),
    });
    await connection.initialize();
    await connection.newSession({ cwd: '/vault/project', mcpServers: [] });

    harness.emit({ type: 'form.created', data: { form: {
      fields: [{
        description: 'Choose a strategy', key: 'strategy', title: 'Strategy', type: 'string',
        options: [{ label: 'Fast', value: 'fast' }],
      }],
      id: 'form-1',
      metadata: { kind: 'question' },
      sessionID: 'native-session-1',
    } } });
    await new Promise((resolve) => setImmediate(resolve));

    expect(askUserQuestion).toHaveBeenCalledWith({ questions: [expect.objectContaining({
      id: 'strategy', question: 'Choose a strategy',
    })] }, expect.any(AbortSignal));
    expect(harness.requests).toContainEqual({
      method: 'POST', route: '/api/session/native-session-1/form/form-1/reply',
      body: { answer: { strategy: 'fast' } },
    });

    await connection.dispose();
  });

  it('cancels unsupported native form schemas rather than leaving the session blocked', async () => {
    const harness = createClientHarness();
    const connection = new OpencodeHttpSessionConnection(harness.client, '/vault/project', {
      onSessionNotification: jest.fn(),
    });
    await connection.initialize();
    await connection.newSession({ cwd: '/vault/project', mcpServers: [] });

    harness.emit({ type: 'form.created', data: { form: {
      fields: [{ key: 'secret', type: 'password', hidden: true }],
      id: 'form-unsupported',
      metadata: { kind: 'mcp-elicitation' },
      sessionID: 'native-session-1',
    } } });
    await new Promise((resolve) => setImmediate(resolve));

    expect(harness.requests).toContainEqual({
      method: 'DELETE', route: '/api/session/native-session-1/form/form-unsupported',
    });
    await connection.dispose();
  });
});
