import { randomUUID } from 'node:crypto';

import type {
  AskUserQuestionCallback,
  AsyncSubagentCompletion,
} from '../../../core/runtime/types';
import type { StreamChunk } from '../../../core/types';
import type {
  AcpClientConnectionDelegate,
} from '../../acp/AcpClientConnection';
import type {
  AcpAvailableCommand,
  AcpLoadSessionRequest,
  AcpLoadSessionResponse,
  AcpNewSessionRequest,
  AcpNewSessionResponse,
  AcpPromptRequest,
  AcpPromptResponse,
  AcpRequestPermissionRequest,
  AcpSessionConfigOption,
  AcpSessionModelState,
  AcpSessionModeState,
} from '../../acp/types';
import { getManagedOpencodeModes } from '../modes';
import {
  normalizeOpencodeToolInput,
  normalizeOpencodeToolName,
  normalizeOpencodeToolUseResult,
} from '../normalization/opencodeToolNormalization';
import type { OpencodeUserTextRange } from '../runtime/OpencodeSessionConnection';
import {
  type OpencodeHttpClientConnection,
  OpencodeHttpError,
  type OpencodeHttpEvent,
} from './OpencodeHttpClient';
import { projectOpencodeFormQuestions } from './OpencodeHttpForms';

interface NativeModel extends Record<string, unknown> {
  id: string;
  limit?: Record<string, unknown>;
  name: string;
  providerID: string;
  variants?: Array<{ id: string }>;
}

interface NativeCatalog<T> {
  data: T[];
}

interface NativeSkill extends Record<string, unknown> {
  id: string;
}

interface NativeSkillMention {
  id: string;
  mention: { start: number; end: number; text: string };
}

interface PendingPrompt {
  resolve: (response: AcpPromptResponse) => void;
  reject: (error: Error) => void;
  started: boolean;
  submitted: boolean;
  userMessageId?: string;
}

interface NativeChildSession {
  background: boolean;
  parentTaskToolCallId: string;
  text: Map<string, string>;
}

const COMMAND_CATALOG_TIMEOUT_MS = 5_000;
const COMMAND_CATALOG_POLL_INTERVAL_MS = 25;

export interface OpencodeHttpSessionConnectionDelegate extends AcpClientConnectionDelegate {
  askUserQuestion?: AskUserQuestionCallback;
  onAsyncSubagentCompletion?: (
    completion: AsyncSubagentCompletion,
  ) => void | Promise<void>;
  onClosed?: (error: Error) => void;
  onSubagentChunk?: (
    chunk: Extract<StreamChunk, { type: 'subagent_tool_use' | 'subagent_tool_result' }>,
  ) => void;
}

/** Adapts OpenCode v2 native HTTP/SSE sessions to the existing ACP runtime contract. */
export class OpencodeHttpSessionConnection {
  private readonly models: NativeModel[] = [];
  private readonly commands: AcpAvailableCommand[] = [];
  private readonly nativeCommands: AcpAvailableCommand[] = [];
  private skills: NativeSkill[] = [];
  private readonly tools = new Map<string, { input: unknown; name: string }>();
  private readonly text = new Map<string, string>();
  private readonly formControllers = new Map<string, AbortController>();
  private readonly formsController = new AbortController();
  private readonly children = new Map<string, NativeChildSession>();
  private readonly messageRoles = new Map<string, string>();
  private sessionId: string | null = null;
  private currentModel: { id: string; providerID: string; variant?: string } | null = null;
  private pending: PendingPrompt | null = null;
  private disposed = false;
  private commandCatalogPending = false;
  private commandCatalogTask: Promise<void> | null = null;
  private readonly commandCatalogController = new AbortController();

  constructor(
    private readonly client: OpencodeHttpClientConnection,
    private readonly cwd: string,
    private readonly delegate: OpencodeHttpSessionConnectionDelegate,
  ) {}

  async initialize(): Promise<void> {
    await this.client.subscribe(
      (event) => this.handleEvent(event),
      (error) => this.fail(error),
    );
    const [modelCatalog, commandCatalog, skillCatalog] = await Promise.all([
      this.client.request<NativeCatalog<NativeModel>>('/api/model'),
      this.client.request<NativeCatalog<Record<string, unknown>>>('/api/command'),
      this.readSkillCatalog(),
    ]);
    const discoveredModels = Array.isArray(modelCatalog?.data)
      ? modelCatalog.data.flatMap((value) => {
        if (
          !isRecord(value)
          || typeof value.id !== 'string'
          || typeof value.providerID !== 'string'
          || !value.id.trim()
          || !value.providerID.trim()
          || value.enabled === false
        ) {
          return [];
        }
        const id = value.id.trim();
        const name = typeof value.name === 'string' && value.name.trim()
          ? value.name.trim()
          : id;

        return [{
          ...value,
          id,
          name,
          providerID: value.providerID.trim(),
          variants: normalizeNativeModelVariants(value.variants),
        }];
      })
      : [];
    this.models.splice(0, this.models.length, ...discoveredModels);
    this.skills = skillCatalog.filter((skill) => typeof skill.id === 'string' && !!skill.id.trim());
    const nativeCommands = normalizeNativeCommands(commandCatalog?.data);
    this.replaceCommands(nativeCommands);
    if (nativeCommands.length === 0) this.waitForCommandCatalog();
  }

  getModelState(): AcpSessionModelState {
    return this.buildModelState();
  }

  hasPendingPrompt(): boolean {
    return this.pending !== null;
  }

  async newSession(request: AcpNewSessionRequest): Promise<AcpNewSessionResponse> {
    const response = await this.client.request<{ data?: Record<string, unknown> }>('/api/session', {
      method: 'POST',
      body: { location: { directory: request.cwd || this.cwd } },
    });
    const data = response?.data;
    if (!isRecord(data) || typeof data.id !== 'string' || !data.id) {
      throw new Error('OpenCode returned an invalid v2 session.');
    }
    this.sessionId = data.id;
    this.currentModel = readNativeModel(data.model);
    this.publishCommands(data.id);
    return {
      sessionId: data.id,
      models: this.buildModelState(),
      modes: this.buildModeState(data.agent),
      configOptions: this.buildConfigOptions(),
    };
  }

  async loadSession(request: AcpLoadSessionRequest): Promise<AcpLoadSessionResponse> {
    const response = await this.client.request<{ data?: Record<string, unknown> }>(
      `/api/session/${encodeURIComponent(request.sessionId)}`,
    );
    const data = response?.data;
    if (!isRecord(data) || data.id !== request.sessionId) {
      throw new Error('OpenCode returned a different v2 session id.');
    }
    this.sessionId = data.id;
    this.currentModel = readNativeModel(data.model);
    this.publishCommands(data.id);
    return {
      sessionId: data.id,
      models: this.buildModelState(),
      modes: this.buildModeState(data.agent),
      configOptions: this.buildConfigOptions(),
    };
  }

  async setConfigOption(request: {
    configId: string;
    sessionId: string;
    type: 'boolean' | 'select';
    value: boolean | string;
  }): Promise<{ configOptions: AcpSessionConfigOption[] }> {
    this.assertSession(request.sessionId);
    const route = `/api/session/${encodeURIComponent(request.sessionId)}`;
    if (request.configId === 'mode') {
      if (typeof request.value !== 'string') throw new Error('Invalid OpenCode agent selection.');
      await this.client.request(`${route}/agent`, {
        method: 'POST',
        body: { agent: request.value },
      });
    } else if (request.configId === 'model') {
      this.currentModel = parseModelId(String(request.value));
      await this.client.request(`${route}/model`, {
        method: 'POST',
        body: { model: { providerID: this.currentModel.providerID, id: this.currentModel.id } },
      });
    } else if (request.configId === 'effort') {
      if (!this.currentModel) throw new Error('Choose an OpenCode model before setting effort.');
      const value = String(request.value);
      this.currentModel = {
        ...this.currentModel,
        ...(value === 'default' ? {} : { variant: value }),
      };
      if (value === 'default') delete this.currentModel.variant;
      await this.client.request(`${route}/model`, {
        method: 'POST',
        body: { model: this.currentModel },
      });
    }
    return { configOptions: this.buildConfigOptions() };
  }

  prompt(
    request: AcpPromptRequest,
    userTextRange?: OpencodeUserTextRange | null,
  ): Promise<AcpPromptResponse> {
    this.assertSession(request.sessionId);
    if (this.pending) return Promise.reject(new Error('OpenCode already has an active request.'));
    const text = request.prompt.filter((block) => block.type === 'text')
      .map((block) => block.text).join('\n');
    const files = request.prompt.flatMap((block) => block.type === 'image'
      ? [{ uri: `data:${block.mimeType};base64,${block.data}`, mime: block.mimeType }]
      : []);
    const command = /^\/([^\s]+)(?:\s+([\s\S]*))?$/u.exec(text);

    let resolve!: PendingPrompt['resolve'];
    let reject!: PendingPrompt['reject'];
    const completion = new Promise<AcpPromptResponse>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    const pending: PendingPrompt = { resolve, reject, started: false, submitted: false };
    this.pending = pending;
    void completion.catch(() => undefined);
    const hasTypedSlash = isValidUserTextRange(userTextRange, text.length)
      && text.slice(userTextRange.start, userTextRange.end).includes('/');
    if (!command && !hasTypedSlash) {
      this.postPrompt(request, text, files, command, false, [], pending);
    } else {
      void this.submitPrompt(request, text, files, command, userTextRange, pending);
    }
    return completion;
  }

  cancel(request: { sessionId: string }): void {
    if (!this.isCurrentSession(request.sessionId) || !this.pending) return;
    if (!this.pending.submitted) {
      this.finish('cancelled');
      return;
    }
    void this.client.request(
      `/api/session/${encodeURIComponent(request.sessionId)}/interrupt`,
      { method: 'POST' },
    ).then(() => {
      if (this.pending) this.finish('cancelled');
    }).catch((error) => this.fail(asError(error)));
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.commandCatalogController.abort();
    this.formsController.abort();
    for (const controller of this.formControllers.values()) controller.abort();
    this.formControllers.clear();
    this.children.clear();
    this.pending?.reject(new Error('OpenCode HTTP session disposed.'));
    this.pending = null;
    await this.client.dispose();
  }

  private handleEvent(event: OpencodeHttpEvent): void {
    if (this.disposed) return;
    const data = event.data;
    if (event.type === 'form.replied' || event.type === 'form.cancelled') {
      const formId = stringValue(data.id);
      if (formId) {
        this.formControllers.get(formId)?.abort();
        this.formControllers.delete(formId);
      }
      return;
    }
    if (event.type === 'form.created') {
      const form = isRecord(data.form) ? data.form : undefined;
      if (!form) return;
      const formSessionId = stringValue(form.sessionID) ?? stringValue(data.sessionID);
      if (formSessionId === 'global') {
        void this.handleGlobalForm(form).catch((error) => this.fail(asError(error)));
      } else if (formSessionId && (
        formSessionId === this.sessionId || this.children.has(formSessionId)
      )) {
        void this.handleForm(form, formSessionId).catch((error) => this.fail(asError(error)));
      }
      return;
    }
    const nativeSessionId = readEventSessionId(data);
    if (event.type === 'permission.asked' && nativeSessionId && (
      nativeSessionId === this.sessionId || this.children.has(nativeSessionId)
    )) {
      void this.handlePermissionRequest(data).catch((error) => this.fail(asError(error)));
      return;
    }
    if (!nativeSessionId) return;
    const child = this.children.get(nativeSessionId);
    if (nativeSessionId !== this.sessionId && !child) return;
    if (child) {
      this.handleChildEvent(event, data, nativeSessionId, child);
      return;
    }

    const assistantMessageId = stringValue(data.assistantMessageID);
    switch (event.type) {
      case 'session.status': {
        const status = isRecord(data.status) ? stringValue(data.status.type) : undefined;
        if (status === 'busy' && this.pending) this.pending.started = true;
        if (status === 'idle' && this.pending?.started) this.finish('end_turn');
        return;
      }
      case 'session.idle':
        if (this.pending?.started) this.finish('end_turn');
        return;
      case 'session.error':
        if (this.pending) this.fail(formatNativeTurnError(data.error));
        return;
      case 'message.updated': {
        const info = isRecord(data.info) ? data.info : undefined;
        if (!info) return;
        const messageId = stringValue(info.id);
        const role = stringValue(info.role);
        if (messageId && role) this.messageRoles.set(messageId, role);
        if (role !== 'assistant' || !this.pending) return;
        this.pending.started = true;
        if (isRecord(info.error) && Object.keys(info.error).length > 0) {
          this.fail(formatNativeTurnError(info.error));
          return;
        }
        const time = isRecord(info.time) ? info.time : undefined;
        if (typeof time?.completed === 'number') this.finish('end_turn');
        return;
      }
      case 'message.part.updated': {
        const part = isRecord(data.part) ? data.part : undefined;
        const messageId = stringValue(part?.messageID);
        if (!part || !messageId || this.messageRoles.get(messageId) !== 'assistant') return;
        const partType = stringValue(part.type);
        if (partType !== 'text' && partType !== 'reasoning') return;
        const partId = stringValue(part.id) ?? messageId;
        const key = `part:${nativeSessionId}:${partId}:${partType}`;
        const previous = this.text.get(key) ?? '';
        const fullText = stringValue(part.text);
        const explicitDelta = stringValue(data.delta);
        const delta = explicitDelta ?? (fullText
          ? fullText.startsWith(previous) ? fullText.slice(previous.length) : fullText
          : '');
        if (fullText !== undefined) this.text.set(key, fullText);
        else if (delta) this.text.set(key, previous + delta);
        if (delta) {
          if (this.pending) this.pending.started = true;
          this.notify({
            sessionUpdate: partType === 'reasoning' ? 'agent_thought_chunk' : 'agent_message_chunk',
            messageId,
            content: { type: 'text', text: delta },
          });
        }
        return;
      }
      case 'message.part.delta': {
        const messageId = stringValue(data.messageID);
        const partId = stringValue(data.partID);
        const field = stringValue(data.field);
        const delta = stringValue(data.delta);
        if (!messageId || !partId || !delta || this.messageRoles.get(messageId) !== 'assistant') return;
        if (field !== 'text' && field !== 'reasoning') return;
        const key = `part:${nativeSessionId}:${partId}:${field}`;
        this.text.set(key, (this.text.get(key) ?? '') + delta);
        if (this.pending) this.pending.started = true;
        this.notify({
          sessionUpdate: field === 'reasoning' ? 'agent_thought_chunk' : 'agent_message_chunk',
          messageId,
          content: { type: 'text', text: delta },
        });
        return;
      }
      case 'session.next.step.started':
      case 'session.execution.started':
        if (this.pending) this.pending.started = true;
        return;
      case 'session.next.step.ended': {
        const finish = stringValue(data.finish);
        if (this.pending && finish && ['stop', 'length', 'content_filter'].includes(finish)) {
          this.finish('end_turn');
        }
        return;
      }
      case 'session.next.step.failed':
        if (this.pending) this.fail(formatNativeTurnError(data.error));
        return;
      case 'session.next.text.started':
      case 'session.next.reasoning.started':
        if (this.pending) this.pending.started = true;
        return;
      case 'session.next.text.delta':
      case 'session.next.reasoning.delta': {
        const textId = stringValue(data.textID);
        const delta = stringValue(data.delta);
        if (!assistantMessageId || !textId || !delta || !this.pending) return;
        this.pending.started = true;
        const isReasoning = event.type === 'session.next.reasoning.delta';
        const key = `part:${nativeSessionId}:${assistantMessageId}:${textId}:${isReasoning ? 'reasoning' : 'text'}`;
        this.text.set(key, (this.text.get(key) ?? '') + delta);
        this.notify({
          sessionUpdate: isReasoning ? 'agent_thought_chunk' : 'agent_message_chunk',
          messageId: assistantMessageId,
          content: { type: 'text', text: delta },
        });
        return;
      }
      case 'session.next.text.ended':
      case 'session.next.reasoning.ended': {
        const textId = stringValue(data.textID);
        const fullText = stringValue(data.text);
        if (!assistantMessageId || !textId || !this.pending) return;
        const isReasoning = event.type === 'session.next.reasoning.ended';
        const key = `part:${nativeSessionId}:${assistantMessageId}:${textId}:${isReasoning ? 'reasoning' : 'text'}`;
        const previous = this.text.get(key) ?? '';
        this.text.delete(key);
        const delta = fullText
          ? fullText.startsWith(previous) ? fullText.slice(previous.length) : fullText
          : '';
        if (delta) {
          this.notify({
            sessionUpdate: isReasoning ? 'agent_thought_chunk' : 'agent_message_chunk',
            messageId: assistantMessageId,
            content: { type: 'text', text: delta },
          });
        }
        return;
      }
      case 'session.execution.succeeded':
        if (this.pending) this.finish('end_turn');
        return;
      case 'session.execution.interrupted':
        if (this.pending) this.finish('cancelled');
        return;
      case 'session.execution.failed':
        if (this.pending) this.fail(formatNativeTurnError(data.error));
        return;
      case 'session.text.delta':
      case 'session.reasoning.delta':
      case 'session.text.ended':
      case 'session.reasoning.ended': {
        if (!assistantMessageId) return;
        const isReasoning = event.type.includes('.reasoning.');
        const kind = isReasoning ? 'thought' : 'text';
        const key = `${nativeSessionId}:${assistantMessageId}:${stringValue(data.ordinal)}:${kind}`;
        const previous = this.text.get(key) ?? '';
        const delta = typeof data.delta === 'string'
          ? data.delta
          : typeof data.text === 'string' ? data.text.slice(previous.length) : '';
        if (event.type.endsWith('.ended')) this.text.delete(key);
        else this.text.set(key, previous + delta);
        if (delta) {
          this.notify({
            sessionUpdate: isReasoning ? 'agent_thought_chunk' : 'agent_message_chunk',
            messageId: assistantMessageId,
            content: { type: 'text', text: delta },
          });
        }
        return;
      }
      case 'session.next.tool.input.started':
      case 'session.tool.input.started': {
        const id = stringValue(data.callID) ?? stringValue(data.id);
        if (id) {
          const key = nativeToolKey(nativeSessionId, assistantMessageId, id);
          const previous = this.tools.get(key);
          this.tools.set(key, {
            input: previous?.input ?? {},
            name: stringValue(data.name) ?? previous?.name ?? 'tool',
          });
        }
        return;
      }
      case 'session.next.tool.input.delta': {
        const id = stringValue(data.callID);
        const delta = stringValue(data.delta);
        if (!id || !delta) return;
        const key = nativeToolKey(nativeSessionId, assistantMessageId, id);
        const previous = this.tools.get(key);
        this.tools.set(key, {
          input: `${typeof previous?.input === 'string' ? previous.input : ''}${delta}`,
          name: previous?.name ?? 'tool',
        });
        return;
      }
      case 'session.next.tool.input.ended': {
        const id = stringValue(data.callID);
        if (!id) return;
        const key = nativeToolKey(nativeSessionId, assistantMessageId, id);
        const previous = this.tools.get(key);
        const text = stringValue(data.text);
        this.tools.set(key, {
          input: parseNativeToolInput(text) ?? previous?.input ?? {},
          name: previous?.name ?? 'tool',
        });
        return;
      }
      case 'session.next.tool.called':
      case 'session.tool.called': {
        const id = stringValue(data.callID) ?? stringValue(data.id);
        if (!id) return;
        const key = nativeToolKey(nativeSessionId, assistantMessageId, id);
        const previous = this.tools.get(key);
        const name = stringValue(data.tool) ?? stringValue(data.name) ?? previous?.name ?? 'tool';
        const input = isRecord(data.input)
          ? data.input
          : parseNativeToolInput(previous?.input) ?? {};
        this.tools.set(key, { input, name });
        this.notify({
          sessionUpdate: 'tool_call',
          toolCallId: id,
          title: name,
          status: 'in_progress',
          rawInput: input,
        });
        return;
      }
      case 'session.next.tool.progress':
      case 'session.tool.progress': {
        const id = stringValue(data.callID) ?? stringValue(data.id);
        const tool = id
          ? this.tools.get(nativeToolKey(nativeSessionId, assistantMessageId, id))
          : undefined;
        const metadata = isRecord(data.metadata)
          ? data.metadata
          : isRecord(data.structured) ? data.structured : {};
        const childSessionId = stringValue(metadata.sessionID);
        if (id && tool && isTaskToolName(tool.name) && childSessionId
          && childSessionId !== this.sessionId && !this.children.has(childSessionId)) {
          const input = isRecord(tool.input) ? tool.input : {};
          this.children.set(childSessionId, {
            background: input.run_in_background === true || input.background === true,
            parentTaskToolCallId: id,
            text: new Map(),
          });
        }
        if (tool && typeof metadata.output === 'string') {
          this.notify({
            sessionUpdate: 'tool_call_update',
            toolCallId: id!,
            title: tool.name,
            status: 'in_progress',
            content: [{ type: 'content', content: { type: 'text', text: metadata.output } }],
          });
        }
        return;
      }
      case 'session.next.tool.success':
      case 'session.next.tool.failed':
      case 'session.tool.success':
      case 'session.tool.failed': {
        const id = stringValue(data.callID) ?? stringValue(data.id);
        if (!id) return;
        const key = nativeToolKey(nativeSessionId, assistantMessageId, id);
        const tool = this.tools.get(key);
        const output = extractNativeText(data.content) || errorText(data.error);
        this.notify({
          sessionUpdate: 'tool_call_update',
          toolCallId: id,
          ...(tool ? { title: tool.name, rawInput: tool.input } : {}),
          status: event.type.endsWith('.failed') ? 'failed' : 'completed',
          rawOutput: data,
          content: [{ type: 'content', content: { type: 'text', text: output } }],
        });
        this.tools.delete(key);
        return;
      }
      case 'session.step.ended': {
        const tokens = isRecord(data.tokens) ? data.tokens : {};
        const model = this.findCurrentModel();
        const contextWindow = numeric(model?.limit?.context);
        const input = numeric(tokens.input) + numeric(isRecord(tokens.cache) ? tokens.cache.read : 0)
          + numeric(isRecord(tokens.cache) ? tokens.cache.write : 0);
        const used = input + numeric(tokens.output) + numeric(tokens.reasoning);
        if (contextWindow > 0) {
          this.notify({ sessionUpdate: 'usage_update', size: contextWindow, used });
        }
        return;
      }
      default:
        return;
    }
  }

  private handleChildEvent(
    event: OpencodeHttpEvent,
    data: Record<string, unknown>,
    childSessionId: string,
    child: NativeChildSession,
  ): void {
    const assistantMessageId = stringValue(data.assistantMessageID);
    switch (event.type) {
      case 'session.text.delta':
      case 'session.text.ended': {
        if (!assistantMessageId) return;
        const key = `${assistantMessageId}:${stringValue(data.ordinal)}`;
        const previous = child.text.get(key) ?? '';
        const next = event.type === 'session.text.ended' && typeof data.text === 'string'
          ? data.text
          : previous + (typeof data.delta === 'string'
            ? data.delta
            : typeof data.text === 'string' ? data.text.slice(previous.length) : '');
        child.text.set(key, next);
        return;
      }
      case 'session.execution.succeeded':
      case 'session.execution.interrupted':
      case 'session.execution.failed': {
        if (child.background && this.sessionId) {
          const result = [...child.text.values()].filter(Boolean).join('\n')
            || errorText(data.error);
          const completion: AsyncSubagentCompletion = {
            type: 'async_subagent_completion',
            providerSessionId: this.sessionId,
            taskId: childSessionId,
            toolUseId: child.parentTaskToolCallId,
            status: event.type === 'session.execution.succeeded' ? 'completed' : 'error',
            ...(result ? { result } : {}),
          };
          void Promise.resolve(this.delegate.onAsyncSubagentCompletion?.(completion))
            .catch((error) => this.delegate.onClosed?.(asError(error)));
        }
        this.children.delete(childSessionId);
        return;
      }
      case 'session.tool.input.started': {
        const id = stringValue(data.id);
        if (id) {
          this.tools.set(nativeToolKey(childSessionId, assistantMessageId, id), {
            input: {}, name: stringValue(data.name) ?? 'tool',
          });
        }
        return;
      }
      case 'session.tool.called': {
        const id = stringValue(data.id);
        if (!id || child.background) return;
        const name = stringValue(data.name) ?? 'tool';
        const input = isRecord(data.input) ? data.input : {};
        this.tools.set(nativeToolKey(childSessionId, assistantMessageId, id), { input, name });
        this.delegate.onSubagentChunk?.({
          type: 'subagent_tool_use',
          subagentId: child.parentTaskToolCallId,
          id: `${childSessionId}:${id}`,
          name: normalizeOpencodeToolName(name),
          input: normalizeOpencodeToolInput(name, input),
        });
        return;
      }
      case 'session.tool.success':
      case 'session.tool.failed': {
        const id = stringValue(data.id);
        if (!id) return;
        const key = nativeToolKey(childSessionId, assistantMessageId, id);
        const tool = this.tools.get(key);
        if (tool && !child.background) {
          this.delegate.onSubagentChunk?.({
            type: 'subagent_tool_result',
            subagentId: child.parentTaskToolCallId,
            id: `${childSessionId}:${id}`,
            content: extractNativeText(data.content) || errorText(data.error),
            isError: event.type === 'session.tool.failed',
            ...(normalizeOpencodeToolUseResult(tool.name, isRecord(tool.input) ? tool.input : {}, data)
              ? { toolUseResult: normalizeOpencodeToolUseResult(
                tool.name,
                isRecord(tool.input) ? tool.input : {},
                data,
              ) }
              : {}),
          });
        }
        this.tools.delete(key);
        return;
      }
      default:
        return;
    }
  }

  private async handlePermissionRequest(data: Record<string, unknown>): Promise<void> {
    const id = stringValue(data.id);
    const sessionId = stringValue(data.sessionID);
    if (!id || !sessionId || !this.delegate.requestPermission) {
      if (id && sessionId) await this.replyPermission(sessionId, id, 'reject');
      return;
    }
    const action = stringValue(data.action) ?? 'tool';
    const resources = Array.isArray(data.resources) ? data.resources : [];
    const options = [
      { optionId: 'allow_once', kind: 'allow_once' as const, name: 'Allow once' },
      { optionId: 'allow_always', kind: 'allow_always' as const, name: 'Always allow' },
      { optionId: 'reject_once', kind: 'reject_once' as const, name: 'Reject' },
    ];
    const request: AcpRequestPermissionRequest = {
      sessionId,
      options,
      toolCall: {
        toolCallId: id,
        title: action,
        rawInput: { resources, ...(isRecord(data.metadata) ? data.metadata : {}) },
      },
    };
    const response = await this.delegate.requestPermission(request);
    const selectedOptionId = response.outcome.outcome === 'selected'
      ? response.outcome.optionId
      : undefined;
    const selected = options.find((option) => option.optionId === selectedOptionId);
    await this.replyPermission(sessionId, id, selected?.kind === 'allow_once'
      ? 'once'
      : selected?.kind === 'allow_always' ? 'always' : 'reject');
  }

  private async handleGlobalForm(form: Record<string, unknown>): Promise<void> {
    const id = stringValue(form.id);
    if (!id) return;
    const pending = await this.client.request<NativeCatalog<Record<string, unknown>>>('/api/form');
    if (this.disposed || !pending.data.some((entry) => (
      entry.id === id && entry.sessionID === 'global'
    ))) return;
    await this.handleForm(form, 'global');
  }

  private async handleForm(form: Record<string, unknown>, sessionId: string): Promise<void> {
    const id = stringValue(form.id);
    if (!id || this.formControllers.has(id)) return;
    const controller = new AbortController();
    this.formControllers.set(id, controller);
    const signal = AbortSignal.any([this.formsController.signal, controller.signal]);
    const route = `/api/session/${encodeURIComponent(sessionId)}/form/${encodeURIComponent(id)}`;
    let projectionError: unknown;
    try {
      let questions;
      try {
        questions = projectOpencodeFormQuestions(form);
      } catch (error) {
        projectionError = error;
        await this.client.request(route, { method: 'DELETE' });
        throw error;
      }
      if (!this.delegate.askUserQuestion) {
        await this.client.request(route, { method: 'DELETE' });
        throw new Error('OpenCode asked a question, but no question handler is available.');
      }
      const answers = await this.delegate.askUserQuestion({ questions }, signal);
      if (signal.aborted) return;
      if (answers === null) {
        await this.client.request(route, { method: 'DELETE' });
        return;
      }

      const fields = Array.isArray(form.fields) ? form.fields.filter(isRecord) : [];
      const answer: Record<string, unknown> = {};
      for (const field of fields) {
        const key = stringValue(field.key);
        if (!key) continue;
        const question = questions.find((candidate) => candidate.id === key);
        const value = answers[key] ?? (question ? answers[question.question] : undefined);
        if (value === undefined) continue;
        answer[key] = normalizeFormAnswer(field.type, value);
      }
      await this.client.request(`${route}/reply`, { method: 'POST', body: { answer } });
    } catch (error) {
      if (projectionError || !signal.aborted) throw projectionError ?? error;
    } finally {
      if (this.formControllers.get(id) === controller) this.formControllers.delete(id);
    }
  }

  private replyPermission(sessionId: string, id: string, decision: string): Promise<unknown> {
    return this.client.request(
      `/api/session/${encodeURIComponent(sessionId)}/permission/${encodeURIComponent(id)}/reply`,
      { method: 'POST', body: { decision } },
    );
  }

  private buildModelState(): AcpSessionModelState {
    const currentModelId = this.currentModel
      ? `${this.currentModel.providerID}/${this.currentModel.id}`
      : '';
    return {
      currentModelId,
      availableModels: this.models.map((model) => ({
        modelId: `${model.providerID}/${model.id}`,
        name: `${model.providerID}/${model.name}`,
        ...(typeof model.description === 'string' ? { description: model.description } : {}),
      })),
    };
  }

  private buildModeState(currentMode: unknown): AcpSessionModeState {
    const modes = getManagedOpencodeModes([]).map((mode) => ({
      id: mode.id,
      name: mode.name,
      ...(mode.description ? { description: mode.description } : {}),
    }));
    const modeId = typeof currentMode === 'string' && modes.some((mode) => mode.id === currentMode)
      ? currentMode
      : modes[0]?.id ?? '';
    return { availableModes: modes, currentModeId: modeId };
  }

  private buildConfigOptions(): AcpSessionConfigOption[] {
    const model = this.findCurrentModel();
    const variants = Array.isArray(model?.variants)
      ? model.variants.flatMap((variant) => (
        isRecord(variant) && typeof variant.id === 'string' && variant.id.trim()
          ? [variant.id]
          : []
      ))
      : [];
    if (variants.length === 0) return [];
    const values = [...new Set([...variants, 'default'])];
    return [{
      id: 'effort',
      category: 'thought_level',
      name: 'Effort',
      type: 'select',
      currentValue: this.currentModel?.variant ?? 'default',
      options: values.map((value) => ({ value, name: value })),
    }];
  }

  private async readSkillCatalog(): Promise<NativeSkill[]> {
    try {
      const catalog = await this.client.request<NativeCatalog<NativeSkill>>('/api/skill');
      return Array.isArray(catalog?.data) ? catalog.data : [];
    } catch (error) {
      if (error instanceof OpencodeHttpError && error.status === 404) return [];
      throw error;
    }
  }

  private async submitPrompt(
    request: AcpPromptRequest,
    text: string,
    files: Array<{ uri: string; mime: string }>,
    command: RegExpExecArray | null,
    userTextRange: OpencodeUserTextRange | null | undefined,
    pending: PendingPrompt,
  ): Promise<void> {
    try {
      const [commandCatalog, skills] = await Promise.all([
        command
          ? this.client.request<NativeCatalog<unknown>>('/api/command')
          : Promise.resolve(null),
        this.resolveSkillMentions(text, userTextRange),
      ]);
      if (this.pending !== pending) return;

      if (commandCatalog) this.replaceCommands(normalizeNativeCommands(commandCatalog.data));
      const supportedCommand = command
        && this.nativeCommands.some((item) => item.name === command[1]);
      this.postPrompt(request, text, files, command, !!supportedCommand, skills, pending);
    } catch (error) {
      if (this.pending === pending) this.fail(asError(error));
    }
  }

  private postPrompt(
    request: AcpPromptRequest,
    text: string,
    files: Array<{ uri: string; mime: string }>,
    command: RegExpExecArray | null,
    supportedCommand: boolean,
    skills: NativeSkillMention[],
    pending: PendingPrompt,
  ): void {
    const route = `/api/session/${encodeURIComponent(request.sessionId)}/${supportedCommand ? 'command' : 'prompt'}`;
    const body = supportedCommand && command
      ? { name: command[1], text: command[2] ?? '', ...(files.length ? { files } : {}) }
      : {
        id: request.messageId ?? `msg_${randomUUID().replaceAll('-', '')}`,
        prompt: { text, ...(files.length ? { files } : {}) },
        ...(skills.length ? { skills } : {}),
      };

    pending.submitted = true;
    void this.client.request<{ data?: { id?: string } }>(route, {
      method: 'POST',
      body,
      timeoutMs: 0,
    }).then((response) => {
      if (this.pending !== pending) return;
      pending.userMessageId = response?.data?.id;
      if (supportedCommand) {
        void this.client.request(`/api/experimental/session/${encodeURIComponent(request.sessionId)}/wait`, {
          method: 'POST',
          timeoutMs: 0,
        }).then(() => {
          if (this.pending === pending && !pending.started) this.finish('end_turn');
        }).catch((error) => this.fail(asError(error)));
      }
    }).catch((error) => {
      if (this.pending === pending) this.fail(asError(error));
    });
  }

  private async resolveSkillMentions(
    text: string,
    userTextRange: OpencodeUserTextRange | null | undefined,
  ): Promise<NativeSkillMention[]> {
    if (!isValidUserTextRange(userTextRange, text.length)) return [];
    const typedText = text.slice(userTextRange.start, userTextRange.end);
    if (!typedText.includes('/')) return [];

    const skills = await this.readSkillCatalog();
    this.skills = skills.filter((skill) => typeof skill.id === 'string' && !!skill.id.trim());
    this.replaceCommands([...this.nativeCommands]);

    const ids = this.skills.map((skill) => skill.id).sort((left, right) => right.length - left.length);
    return [...typedText.matchAll(SLASH_TOKEN)].flatMap((match) => {
      const token = match[1];
      const id = ids.find((skillId) => (
        token.startsWith(skillId) && TRAILING_PUNCTUATION.test(token.slice(skillId.length))
      ));
      if (!id || match.index === undefined) return [];
      const start = userTextRange.start + match.index;
      return [{ id, mention: { start, end: start + id.length + 1, text: `/${id}` } }];
    });
  }

  private replaceCommands(commands: AcpAvailableCommand[]): void {
    this.nativeCommands.splice(0, this.nativeCommands.length, ...commands);
    const commandNames = new Set(this.nativeCommands.map((command) => command.name));
    const skills = this.skills.flatMap((skill) => (
      typeof skill.id === 'string' && skill.id.trim() && !commandNames.has(skill.id)
        ? [{
          name: skill.id,
          kind: 'skill' as const,
          ...(typeof skill.description === 'string' ? { description: skill.description } : {}),
        }]
        : []
    ));
    this.commands.splice(0, this.commands.length, ...this.nativeCommands, ...skills);
  }

  private waitForCommandCatalog(): void {
    if (this.commandCatalogTask || this.disposed) return;
    this.commandCatalogPending = true;
    const deadline = Date.now() + COMMAND_CATALOG_TIMEOUT_MS;
    this.commandCatalogTask = (async () => {
      while (!this.disposed && !this.commandCatalogController.signal.aborted) {
        if (Date.now() >= deadline) return;
        await new Promise<void>((resolve) => {
          window.setTimeout(resolve, COMMAND_CATALOG_POLL_INTERVAL_MS);
        });
        if (this.disposed || this.commandCatalogController.signal.aborted) return;
        const catalog = await this.client.request<NativeCatalog<unknown>>('/api/command', {
          signal: this.commandCatalogController.signal,
        });
        const commands = normalizeNativeCommands(catalog?.data);
        if (commands.length > 0) {
          this.replaceCommands(commands);
          return;
        }
      }
    })().catch(() => undefined).finally(() => {
      this.commandCatalogPending = false;
      this.commandCatalogTask = null;
      if (this.sessionId) this.publishCommands(this.sessionId);
    });
  }

  private findCurrentModel(): NativeModel | undefined {
    return this.models.find((model) => model.id === this.currentModel?.id
      && model.providerID === this.currentModel?.providerID);
  }

  private publishCommands(sessionId: string): void {
    if (this.commandCatalogPending) return;
    this.delegate.onSessionNotification?.({
      sessionId,
      update: { sessionUpdate: 'available_commands_update', availableCommands: [...this.commands] },
    });
  }

  private notify(update: Parameters<NonNullable<AcpClientConnectionDelegate['onSessionNotification']>>[0]['update']): void {
    if (!this.sessionId) return;
    this.delegate.onSessionNotification?.({ sessionId: this.sessionId, update });
  }

  private assertSession(sessionId: string): void {
    if (this.disposed || sessionId !== this.sessionId) {
      throw new Error('OpenCode HTTP session is not active.');
    }
  }

  private isCurrentSession(sessionId: string): boolean {
    return !this.disposed && sessionId === this.sessionId;
  }

  private finish(stopReason: 'end_turn' | 'cancelled'): void {
    const pending = this.pending;
    this.pending = null;
    pending?.resolve({ stopReason, userMessageId: pending.userMessageId });
  }

  private fail(error: Error): void {
    if (this.disposed) return;
    for (const controller of this.formControllers.values()) controller.abort(error);
    this.formControllers.clear();
    const pending = this.pending;
    this.pending = null;
    pending?.reject(error);
    if (!pending) this.delegate.onClosed?.(error);
  }
}

function normalizeNativeCommands(value: unknown): AcpAvailableCommand[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((command) => (
    isRecord(command) && typeof command.name === 'string' && command.name.trim()
      ? [{
        name: command.name,
        kind: 'command' as const,
        ...(typeof command.description === 'string' ? { description: command.description } : {}),
        ...(typeof command.argumentHint === 'string'
          ? { input: { hint: command.argumentHint } }
          : {}),
      }]
      : []
  ));
}

const SLASH_TOKEN = /(?<!\S)\/(\S+)/gu;
const TRAILING_PUNCTUATION = /^[.,;:!?)\]}"']*$/u;

function isValidUserTextRange(
  value: OpencodeUserTextRange | null | undefined,
  textLength: number,
): value is OpencodeUserTextRange {
  return !!value
    && Number.isInteger(value.start)
    && Number.isInteger(value.end)
    && value.start >= 0
    && value.end >= value.start
    && value.end <= textLength;
}

function parseModelId(value: string): { providerID: string; id: string } {
  const slash = value.indexOf('/');
  if (slash < 1 || slash === value.length - 1) throw new Error('Invalid OpenCode model selection.');
  return { providerID: value.slice(0, slash), id: value.slice(slash + 1) };
}

function readNativeModel(value: unknown): { id: string; providerID: string; variant?: string } | null {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.providerID !== 'string') return null;
  return {
    id: value.id,
    providerID: value.providerID,
    ...(typeof value.variant === 'string' ? { variant: value.variant } : {}),
  };
}

function parseNativeToolInput(value: unknown): Record<string, unknown> | undefined {
  if (isRecord(value)) return value;
  if (typeof value !== 'string') return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function readEventSessionId(data: Record<string, unknown>): string | undefined {
  const direct = stringValue(data.sessionID) ?? stringValue(data.sessionId);
  if (direct) return direct;
  for (const key of ['info', 'part', 'message']) {
    const nested = data[key];
    if (!isRecord(nested)) continue;
    const sessionId = stringValue(nested.sessionID) ?? stringValue(nested.sessionId);
    if (sessionId) return sessionId;
  }
  return undefined;
}

function formatNativeTurnError(value: unknown): Error {
  const error = isRecord(value) ? value : {};
  const details = isRecord(error.data) ? error.data : {};
  const status = numeric(error.statusCode) || numeric(details.statusCode) || numeric(error.status);
  return new Error(status > 0
    ? `OpenCode request failed with HTTP ${status}.`
    : 'OpenCode request failed.');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizeNativeModelVariants(value: unknown): Array<{ id: string }> {
  if (Array.isArray(value)) {
    return value.flatMap((variant) => (
      isRecord(variant) && typeof variant.id === 'string' && variant.id.trim()
        ? [{ id: variant.id.trim() }]
        : []
    ));
  }

  if (!isRecord(value)) return [];
  return Object.keys(value)
    .filter((id) => id.trim())
    .map((id) => ({ id: id.trim() }));
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function nativeToolKey(sessionId: string, assistantMessageId: string | undefined, toolId: string): string {
  return `${sessionId}:${assistantMessageId ?? ''}:${toolId}`;
}

function isTaskToolName(value: string): boolean {
  return value.trim().toLowerCase() === 'task' || value.trim().toLowerCase() === 'subagent';
}

function numeric(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : 0;
}

function extractNativeText(value: unknown): string {
  return Array.isArray(value)
    ? value.filter(isRecord).map((item) => stringValue(item.text) ?? '').filter(Boolean).join('\n')
    : '';
}

function errorText(value: unknown): string {
  return isRecord(value) && typeof value.message === 'string'
    ? value.message
    : typeof value === 'string' ? value : '';
}

function normalizeFormAnswer(type: unknown, value: string | string[]): unknown {
  if (Array.isArray(value)) return value;
  if (type === 'boolean') return value.toLowerCase() === 'true';
  if (type === 'number' || type === 'integer') return Number(value);
  return value;
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
