import type * as zlibType from 'node:zlib';

import type * as fsType from 'fs';
import type * as osType from 'os';
import type * as pathType from 'path';

const fs = jest.requireActual<typeof fsType>('fs');
const os = jest.requireActual<typeof osType>('os');
const path = jest.requireActual<typeof pathType>('path');


import { testDate } from '@test/helpers/testClock';

import type { Conversation } from '@/core/types';
import { CodexConversationHistoryService } from '@/providers/codex/history/CodexConversationHistoryService';

describe('CodexConversationHistoryService', () => {
  let homeDirSpy: jest.SpyInstance<string, []>;
  let tempHome: string;

  beforeEach(() => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'codian-codex-home-'));
    homeDirSpy = jest.spyOn(os, 'homedir').mockReturnValue(tempHome);
  });

  afterEach(() => {
    homeDirSpy.mockRestore();
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  it.each(['file://vault/path', 'file:///vault/100%notes'])(
    'preserves replay around a failed command with unsupported directory URL %s', async workdir => {
      const sessions = path.join(tempHome, '.codex', 'sessions');
      fs.mkdirSync(sessions, { recursive: true });
      const sessionFilePath = path.join(sessions, 'rollout-thread.jsonl');
      const records = [
        { type: 'session_meta', payload: { id: 'thread' } },
        { type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn' } },
        { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Inspect the vault' }] } },
        { type: 'response_item', payload: { type: 'function_call', name: 'exec_command', call_id: 'bad-directory', arguments: JSON.stringify({ cmd: 'pwd', workdir }) } },
        { type: 'response_item', payload: { type: 'function_call_output', call_id: 'bad-directory', output: 'Error: Cannot run command: working directory does not exist' } },
        { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'The requested directory was unavailable.' }] } },
        { type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn' } },
      ];
      fs.writeFileSync(sessionFilePath, records.map((record, seconds) => JSON.stringify({
        timestamp: testDate({ seconds }).toISOString(), ...record,
      })).join('\n'));

      const conversation: Conversation = {
        id: 'conversation', sessionId: 'thread', messages: [],
        providerId: 'codex', title: 'Imported conversation',
        createdAt: testDate().getTime(), updatedAt: testDate({ seconds: 6 }).getTime(),
        providerState: { threadId: 'thread', sessionFilePath, transcriptRootPath: sessions },
      };
      await new CodexConversationHistoryService().hydrateConversationHistory(conversation, null);

      expect(conversation.messages.map(message => message.content)).toEqual(expect.arrayContaining([
        'Inspect the vault', 'The requested directory was unavailable.',
      ]));
      expect(conversation.messages.flatMap(message => message.toolCalls ?? [])).toContainEqual(expect.objectContaining({
        id: 'bad-directory', name: 'Bash', result: 'Error: Cannot run command: working directory does not exist',
      }));
    },
  );

  it('hydrates history by resolving the transcript path from thread id', async () => {
    const threadId = 'thread-123';
    const sessionsDir = path.join(tempHome, '.codex', 'sessions', '2026', '03', '27');
    fs.mkdirSync(sessionsDir, { recursive: true });

    const transcriptPath = path.join(
      sessionsDir,
      `rollout-2026-03-27T00-00-00-${threadId}.jsonl`,
    );

    fs.writeFileSync(
      transcriptPath,
      [
        JSON.stringify({
          timestamp: '2026-03-27T00:00:00.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'Summarize this file.' }],
          },
        }),
        JSON.stringify({
          timestamp: '2026-03-27T00:00:01.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'Here is the summary.' }],
          },
        }),
      ].join('\n'),
      'utf-8',
    );

    const conversation: Conversation = {
      id: 'conv-1',
      providerId: 'codex',
      title: 'Codex Transcript',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      sessionId: threadId,
      providerState: { threadId },
      messages: [],
    };

    const service = new CodexConversationHistoryService();
    await service.hydrateConversationHistory(conversation, null);

    expect(conversation.messages).toHaveLength(2);
    expect(conversation.messages[0]).toMatchObject({
      role: 'user',
      content: 'Summarize this file.',
    });
    expect(conversation.messages[1]).toMatchObject({
      role: 'assistant',
      content: 'Here is the summary.',
    });
    expect((conversation.providerState as Record<string, unknown>).sessionFilePath).toBe(transcriptPath);
  });

  it('rehydrates when the same conversation id is restored with empty messages', async () => {
    const threadId = 'thread-456';
    const sessionsDir = path.join(tempHome, '.codex', 'sessions', '2026', '03', '27');
    fs.mkdirSync(sessionsDir, { recursive: true });

    const transcriptPath = path.join(
      sessionsDir,
      `rollout-2026-03-27T00-00-00-${threadId}.jsonl`,
    );

    fs.writeFileSync(
      transcriptPath,
      [
        JSON.stringify({
          timestamp: '2026-03-27T00:00:00.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'First prompt' }],
          },
        }),
        JSON.stringify({
          timestamp: '2026-03-27T00:00:01.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'First answer' }],
          },
        }),
      ].join('\n'),
      'utf-8',
    );

    const conversation: Conversation = {
      id: 'conv-2',
      providerId: 'codex',
      title: 'Reloaded Codex Transcript',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      sessionId: threadId,
      providerState: { threadId, sessionFilePath: transcriptPath },
      messages: [],
    };

    const service = new CodexConversationHistoryService();
    await service.hydrateConversationHistory(conversation, null);
    expect(conversation.messages).toHaveLength(2);

    conversation.messages = [];
    await service.hydrateConversationHistory(conversation, null);

    expect(conversation.messages).toHaveLength(2);
    expect(conversation.messages[1]).toMatchObject({
      role: 'assistant',
      content: 'First answer',
    });
  });

  it('recovers orphaned conversations missing threadId and sessionId by matching createdAt to rollout file', async () => {
    const threadId = '01a0ebbe-514a-7213-b418-f534ecdd41ff';
    const createdAt = new Date('2026-09-29T05:58:33.472Z').getTime();
    const date = new Date(createdAt);
    const sessionsDir = path.join(
      tempHome,
      '.codex',
      'sessions',
      String(date.getUTCFullYear()),
      String(date.getUTCMonth() + 1).padStart(2, '0'),
      String(date.getUTCDate()).padStart(2, '0'),
    );
    fs.mkdirSync(sessionsDir, { recursive: true });

    const transcriptPath = path.join(
      sessionsDir,
      `rollout-2026-09-29T05-58-33-${threadId}.jsonl`,
    );

    fs.writeFileSync(
      transcriptPath,
      [
        JSON.stringify({
          timestamp: '2026-09-29T05:58:34.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: '如何进行射频线圈仿真' }],
          },
        }),
        JSON.stringify({
          timestamp: '2026-09-29T05:58:35.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: '仿真步骤如下：' }],
          },
        }),
      ].join('\n'),
      'utf-8',
    );

    const conversation: Conversation = {
      id: 'conv-orphaned',
      providerId: 'codex',
      title: '如何进行射频线圈仿真',
      createdAt,
      updatedAt: createdAt + 1000,
      sessionId: null,
      messages: [],
    };

    const service = new CodexConversationHistoryService();
    await service.hydrateConversationHistory(conversation, null);

    expect(conversation.messages).toHaveLength(2);
    expect(conversation.messages[0]).toMatchObject({
      role: 'user',
      content: '如何进行射频线圈仿真',
    });
    expect(conversation.providerState).toEqual(expect.objectContaining({
      threadId,
      sessionFilePath: transcriptPath,
    }));
  });

  it('recovers and decompresses .jsonl.zst rollout transcripts for orphaned conversations', async () => {
    const zlib = jest.requireActual<typeof zlibType>('node:zlib');
    if (typeof zlib.zstdCompressSync !== 'function') return;

    const threadId = '01a0ebbe-9999-7213-b418-f534ecdd41ff';
    const createdAt = new Date('2026-09-29T05:58:33.472Z').getTime();
    const date = new Date(createdAt);
    const sessionsDir = path.join(
      tempHome,
      '.codex',
      'sessions',
      String(date.getUTCFullYear()),
      String(date.getUTCMonth() + 1).padStart(2, '0'),
      String(date.getUTCDate()).padStart(2, '0'),
    );
    fs.mkdirSync(sessionsDir, { recursive: true });

    const transcriptPath = path.join(
      sessionsDir,
      `rollout-2026-09-29T05-58-33-${threadId}.jsonl.zst`,
    );

    const raw = [
      JSON.stringify({
        timestamp: '2026-09-29T05:58:34.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'Zstd compressed query' }],
        },
      }),
      JSON.stringify({
        timestamp: '2026-09-29T05:58:35.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'Zstd compressed response' }],
        },
      }),
    ].join('\n');

    fs.writeFileSync(transcriptPath, zlib.zstdCompressSync(Buffer.from(raw, 'utf-8')));

    const conversation: Conversation = {
      id: 'conv-orphaned-zst',
      providerId: 'codex',
      title: 'Zstd Query',
      createdAt,
      updatedAt: createdAt + 1000,
      sessionId: null,
      messages: [],
    };

    const service = new CodexConversationHistoryService();
    await service.hydrateConversationHistory(conversation, null);

    expect(conversation.messages).toHaveLength(2);
    expect(conversation.messages[0]).toMatchObject({
      role: 'user',
      content: 'Zstd compressed query',
    });
    expect(conversation.providerState).toEqual(expect.objectContaining({
      threadId,
      sessionFilePath: transcriptPath,
    }));
  });

  it('hydrates by searching transcriptRootPath when sessionFilePath is missing', async () => {

    const threadId = 'thread-rooted';
    const sessionsDir = path.join(tempHome, 'custom-codex-root', 'sessions', '2026', '03', '27');
    fs.mkdirSync(sessionsDir, { recursive: true });

    const transcriptPath = path.join(
      sessionsDir,
      `rollout-2026-03-27T00-00-00-${threadId}.jsonl`,
    );

    fs.writeFileSync(
      transcriptPath,
      [
        JSON.stringify({
          timestamp: '2026-03-27T00:00:00.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'Recovered from transcript root.' }],
          },
        }),
      ].join('\n'),
      'utf-8',
    );

    const conversation: Conversation = {
      id: 'conv-rooted',
      providerId: 'codex',
      title: 'Transcript Root',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      sessionId: threadId,
      providerState: {
        threadId,
        transcriptRootPath: path.join(tempHome, 'custom-codex-root', 'sessions'),
      },
      messages: [],
    };

    const service = new CodexConversationHistoryService();
    await service.hydrateConversationHistory(conversation, null);

    expect(conversation.messages).toHaveLength(1);
    expect(conversation.messages[0]).toMatchObject({
      role: 'assistant',
      content: 'Recovered from transcript root.',
    });
    expect((conversation.providerState as Record<string, unknown>).sessionFilePath).toBe(transcriptPath);
  });

  it('backfills transcriptRootPath from sessionFilePath when only the session path is known', async () => {
    const threadId = 'thread-backfill-root';
    const sessionsDir = path.join(tempHome, 'custom-codex-root', 'sessions', '2026', '03', '28');
    fs.mkdirSync(sessionsDir, { recursive: true });

    const transcriptPath = path.join(
      sessionsDir,
      `rollout-2026-03-28T00-00-00-${threadId}.jsonl`,
    );

    fs.writeFileSync(
      transcriptPath,
      [
        JSON.stringify({
          timestamp: '2026-03-28T00:00:00.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'Recovered from session path.' }],
          },
        }),
      ].join('\n'),
      'utf-8',
    );

    const conversation: Conversation = {
      id: 'conv-backfill-root',
      providerId: 'codex',
      title: 'Backfill Transcript Root',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      sessionId: threadId,
      providerState: {
        threadId,
        sessionFilePath: transcriptPath,
      },
      messages: [],
    };

    const service = new CodexConversationHistoryService();
    await service.hydrateConversationHistory(conversation, null);

    expect(conversation.messages).toHaveLength(1);
    expect((conversation.providerState as Record<string, unknown>).transcriptRootPath).toBe(
      path.join(tempHome, 'custom-codex-root', 'sessions'),
    );
  });

  it('does not open an out-of-root metadata path and re-resolves by thread id', async () => {
    const threadId = 'thread-untrusted-path';
    const trustedDir = path.join(tempHome, '.codex', 'sessions', '2026', '07', '11');
    const outsideDir = path.join(tempHome, 'synced-other-device');
    fs.mkdirSync(trustedDir, { recursive: true });
    fs.mkdirSync(outsideDir, { recursive: true });
    const trustedPath = path.join(trustedDir, `rollout-${threadId}.jsonl`);
    const outsidePath = path.join(outsideDir, `rollout-${threadId}.jsonl`);
    fs.writeFileSync(trustedPath, JSON.stringify({
      timestamp: '2026-07-11T00:00:00.000Z',
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'Trusted transcript.' }],
      },
    }));
    fs.writeFileSync(outsidePath, JSON.stringify({
      timestamp: '2026-07-11T00:00:00.000Z',
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'Untrusted transcript.' }],
      },
    }));
    const conversation: Conversation = {
      id: 'conv-untrusted-path',
      providerId: 'codex',
      title: 'Synced metadata path',
      createdAt: 1,
      updatedAt: 1,
      sessionId: threadId,
      providerState: { threadId, sessionFilePath: outsidePath },
      messages: [],
    };

    await new CodexConversationHistoryService().hydrateConversationHistory(
      conversation,
      null,
      { environment: { HOME: tempHome } },
    );

    expect(conversation.messages.map(message => message.content)).toEqual(['Trusted transcript.']);
    expect((conversation.providerState as Record<string, unknown>).sessionFilePath).toBe(trustedPath);
  });

  it('accepts a metadata path under the explicitly configured Codex home', async () => {
    const configuredHome = path.join(tempHome, 'configured-codex-home');
    const transcriptPath = path.join(configuredHome, 'sessions', 'session.jsonl');
    fs.mkdirSync(path.dirname(transcriptPath), { recursive: true });
    fs.writeFileSync(transcriptPath, JSON.stringify({
      timestamp: '2026-07-11T00:00:00.000Z',
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'Configured transcript.' }],
      },
    }));
    const conversation: Conversation = {
      id: 'conv-configured-path',
      providerId: 'codex',
      title: 'Configured path',
      createdAt: 1,
      updatedAt: 1,
      sessionId: 'configured-thread',
      providerState: { threadId: 'configured-thread', sessionFilePath: transcriptPath },
      messages: [],
    };

    await new CodexConversationHistoryService().hydrateConversationHistory(
      conversation,
      null,
      { environment: { CODEX_HOME: configuredHome, HOME: tempHome } },
    );

    expect(conversation.messages.map(message => message.content)).toEqual(['Configured transcript.']);
  });

  describe('buildForkProviderState', () => {
    it('stores forkSource with sessionId and resumeAt in providerState', () => {
      const service = new CodexConversationHistoryService();
      const result = service.buildForkProviderState('source-thread-id', 'turn-uuid-2');

      expect(result).toEqual({
        forkSource: { sessionId: 'source-thread-id', resumeAt: 'turn-uuid-2' },
      });
    });

    it('preserves source transcript hints when provided', () => {
      const service = new CodexConversationHistoryService();
      const result = service.buildForkProviderState(
        'source-thread-id',
        'turn-uuid-2',
        {
          sessionFilePath: '\\\\wsl$\\Ubuntu\\home\\user\\.codex\\sessions\\2026\\03\\27\\rollout-thread.jsonl',
          transcriptRootPath: '\\\\wsl$\\Ubuntu\\home\\user\\.codex\\sessions',
        },
      );

      expect(result).toEqual({
        forkSource: { sessionId: 'source-thread-id', resumeAt: 'turn-uuid-2' },
        forkSourceSessionFilePath: '\\\\wsl$\\Ubuntu\\home\\user\\.codex\\sessions\\2026\\03\\27\\rollout-thread.jsonl',
        forkSourceTranscriptRootPath: '\\\\wsl$\\Ubuntu\\home\\user\\.codex\\sessions',
      });
    });

    it('preserves workspace dependency tool provenance from the source thread', () => {
      const service = new CodexConversationHistoryService();
      const result = service.buildForkProviderState(
        'source-thread-id',
        'turn-uuid-2',
        { workspaceDependencyToolVersion: 1 },
      );

      expect(result).toEqual({
        forkSource: { sessionId: 'source-thread-id', resumeAt: 'turn-uuid-2' },
        workspaceDependencyToolVersion: 1,
      });
    });

    it('derives the source transcript root from sessionFilePath when only the session path is stored', () => {
      const service = new CodexConversationHistoryService();
      const result = service.buildForkProviderState(
        'source-thread-id',
        'turn-uuid-2',
        {
          sessionFilePath: '\\\\wsl$\\Ubuntu\\home\\user\\.codex\\sessions\\2026\\03\\27\\rollout-thread.jsonl',
        },
      );

      expect(result).toEqual({
        forkSource: { sessionId: 'source-thread-id', resumeAt: 'turn-uuid-2' },
        forkSourceSessionFilePath: '\\\\wsl$\\Ubuntu\\home\\user\\.codex\\sessions\\2026\\03\\27\\rollout-thread.jsonl',
        forkSourceTranscriptRootPath: '\\\\wsl$\\Ubuntu\\home\\user\\.codex\\sessions',
      });
    });
  });

  describe('isPendingForkConversation', () => {
    it('returns true when forkSource exists, no threadId, no sessionId', () => {
      const service = new CodexConversationHistoryService();
      const conversation: Conversation = {
        id: 'conv-fork',
        providerId: 'codex',
        title: 'Pending Fork',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        sessionId: null,
        providerState: { forkSource: { sessionId: 'source', resumeAt: 'turn-1' } },
        messages: [],
      };

      expect(service.isPendingForkConversation(conversation)).toBe(true);
    });

    it('returns false when threadId exists (established fork)', () => {
      const service = new CodexConversationHistoryService();
      const conversation: Conversation = {
        id: 'conv-fork-est',
        providerId: 'codex',
        title: 'Established Fork',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        sessionId: null,
        providerState: {
          threadId: 'fork-thread-1',
          forkSource: { sessionId: 'source', resumeAt: 'turn-1' },
        },
        messages: [],
      };

      expect(service.isPendingForkConversation(conversation)).toBe(false);
    });

    it('returns false when no forkSource', () => {
      const service = new CodexConversationHistoryService();
      const conversation: Conversation = {
        id: 'conv-normal',
        providerId: 'codex',
        title: 'Normal',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        sessionId: 'thread-1',
        providerState: { threadId: 'thread-1' },
        messages: [],
      };

      expect(service.isPendingForkConversation(conversation)).toBe(false);
    });
  });

  describe('resolveSessionIdForConversation', () => {
    it('falls back to forkSource.sessionId', () => {
      const service = new CodexConversationHistoryService();
      const conversation: Conversation = {
        id: 'conv-fork-resolve',
        providerId: 'codex',
        title: 'Fork Resolve',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        sessionId: null,
        providerState: { forkSource: { sessionId: 'source-thread', resumeAt: 'turn-1' } },
        messages: [],
      };

      expect(service.resolveSessionIdForConversation(conversation)).toBe('source-thread');
    });

    it('prefers threadId over forkSource.sessionId', () => {
      const service = new CodexConversationHistoryService();
      const conversation: Conversation = {
        id: 'conv-fork-pref',
        providerId: 'codex',
        title: 'Fork Pref',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        sessionId: null,
        providerState: {
          threadId: 'my-thread',
          forkSource: { sessionId: 'source-thread', resumeAt: 'turn-1' },
        },
        messages: [],
      };

      expect(service.resolveSessionIdForConversation(conversation)).toBe('my-thread');
    });
  });

  describe('pending-fork hydration', () => {
    it('hydrates from source transcript truncated at resumeAt', async () => {
      const sourceThreadId = 'source-thread-pf';
      const sessionsDir = path.join(tempHome, '.codex', 'sessions', '2026', '03', '27');
      fs.mkdirSync(sessionsDir, { recursive: true });

      const transcriptPath = path.join(
        sessionsDir,
        `rollout-2026-03-27T00-00-00-${sourceThreadId}.jsonl`,
      );

      fs.writeFileSync(
        transcriptPath,
        [
          JSON.stringify({ timestamp: '2026-03-27T00:00:00.000Z', type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-uuid-1' } }),
          JSON.stringify({ timestamp: '2026-03-27T00:00:00.500Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Turn 1' }] } }),
          JSON.stringify({ timestamp: '2026-03-27T00:00:01.000Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Reply 1' }] } }),
          JSON.stringify({ timestamp: '2026-03-27T00:00:02.000Z', type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn-uuid-1' } }),
          JSON.stringify({ timestamp: '2026-03-27T00:00:03.000Z', type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-uuid-2' } }),
          JSON.stringify({ timestamp: '2026-03-27T00:00:03.500Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Turn 2' }] } }),
          JSON.stringify({ timestamp: '2026-03-27T00:00:04.000Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Reply 2' }] } }),
          JSON.stringify({ timestamp: '2026-03-27T00:00:05.000Z', type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn-uuid-2' } }),
          JSON.stringify({ timestamp: '2026-03-27T00:00:06.000Z', type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-uuid-3' } }),
          JSON.stringify({ timestamp: '2026-03-27T00:00:06.500Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Turn 3' }] } }),
          JSON.stringify({ timestamp: '2026-03-27T00:00:07.000Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Reply 3' }] } }),
          JSON.stringify({ timestamp: '2026-03-27T00:00:08.000Z', type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn-uuid-3' } }),
        ].join('\n'),
        'utf-8',
      );

      const conversation: Conversation = {
        id: 'conv-pf',
        providerId: 'codex',
        title: 'Pending Fork',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        sessionId: null,
        providerState: { forkSource: { sessionId: sourceThreadId, resumeAt: 'turn-uuid-2' } },
        messages: [],
      };

      const service = new CodexConversationHistoryService();
      await service.hydrateConversationHistory(conversation, null);

      // Should only have messages from turn 1 and turn 2 (truncated at resumeAt)
      expect(conversation.messages).toHaveLength(4);
      expect(conversation.messages[0].content).toBe('Turn 1');
      expect(conversation.messages[1].content).toBe('Reply 1');
      expect(conversation.messages[2].content).toBe('Turn 2');
      expect(conversation.messages[3].content).toBe('Reply 2');
    });

    it('does not widen pending-fork history when resumeAt is missing', async () => {
      const sourceThreadId = 'source-thread-pf-missing';
      const sessionsDir = path.join(tempHome, '.codex', 'sessions', '2026', '03', '27');
      fs.mkdirSync(sessionsDir, { recursive: true });

      fs.writeFileSync(
        path.join(sessionsDir, `rollout-2026-03-27T00-00-00-${sourceThreadId}.jsonl`),
        [
          JSON.stringify({ timestamp: '2026-03-27T00:00:00.000Z', type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-uuid-1' } }),
          JSON.stringify({ timestamp: '2026-03-27T00:00:00.500Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Turn 1' }] } }),
          JSON.stringify({ timestamp: '2026-03-27T00:00:01.000Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Reply 1' }] } }),
          JSON.stringify({ timestamp: '2026-03-27T00:00:02.000Z', type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn-uuid-1' } }),
          JSON.stringify({ timestamp: '2026-03-27T00:00:03.000Z', type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-uuid-2' } }),
          JSON.stringify({ timestamp: '2026-03-27T00:00:03.500Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Turn 2' }] } }),
          JSON.stringify({ timestamp: '2026-03-27T00:00:04.000Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Reply 2' }] } }),
          JSON.stringify({ timestamp: '2026-03-27T00:00:05.000Z', type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn-uuid-2' } }),
        ].join('\n'),
        'utf-8',
      );

      const conversation: Conversation = {
        id: 'conv-pf-missing',
        providerId: 'codex',
        title: 'Pending Fork Missing Checkpoint',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        sessionId: null,
        providerState: { forkSource: { sessionId: sourceThreadId, resumeAt: 'turn-uuid-missing' } },
        messages: [],
      };

      const service = new CodexConversationHistoryService();
      await service.hydrateConversationHistory(conversation, null);

      expect(conversation.messages).toEqual([]);
    });

    it('keeps in-memory messages on pending fork', async () => {
      const conversation: Conversation = {
        id: 'conv-pf-mem',
        providerId: 'codex',
        title: 'Pending Fork In Memory',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        sessionId: null,
        providerState: { forkSource: { sessionId: 'nonexistent', resumeAt: 'turn-1' } },
        messages: [
          { id: 'msg-1', role: 'user', content: 'Cloned message', timestamp: Date.now() },
        ],
      };

      const service = new CodexConversationHistoryService();
      await service.hydrateConversationHistory(conversation, null);

      expect(conversation.messages).toHaveLength(1);
      expect(conversation.messages[0].content).toBe('Cloned message');
    });
  });

  describe('established-fork hydration', () => {
    it('hydrates as source prefix through resumeAt plus fork-only turns', async () => {
      const sourceThreadId = 'source-thread-ef';
      const forkThreadId = 'fork-thread-ef';
      const sessionsDir = path.join(tempHome, '.codex', 'sessions', '2026', '03', '27');
      fs.mkdirSync(sessionsDir, { recursive: true });

      // Source transcript: 3 turns
      fs.writeFileSync(
        path.join(sessionsDir, `rollout-2026-03-27T00-00-00-${sourceThreadId}.jsonl`),
        [
          JSON.stringify({ timestamp: '2026-03-27T00:00:00.000Z', type: 'event_msg', payload: { type: 'task_started', turn_id: 'src-turn-1' } }),
          JSON.stringify({ timestamp: '2026-03-27T00:00:00.500Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'SrcQ1' }] } }),
          JSON.stringify({ timestamp: '2026-03-27T00:00:01.000Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'SrcA1' }] } }),
          JSON.stringify({ timestamp: '2026-03-27T00:00:02.000Z', type: 'event_msg', payload: { type: 'task_complete', turn_id: 'src-turn-1' } }),
          JSON.stringify({ timestamp: '2026-03-27T00:00:03.000Z', type: 'event_msg', payload: { type: 'task_started', turn_id: 'src-turn-2' } }),
          JSON.stringify({ timestamp: '2026-03-27T00:00:03.500Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'SrcQ2' }] } }),
          JSON.stringify({ timestamp: '2026-03-27T00:00:04.000Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'SrcA2' }] } }),
          JSON.stringify({ timestamp: '2026-03-27T00:00:05.000Z', type: 'event_msg', payload: { type: 'task_complete', turn_id: 'src-turn-2' } }),
          JSON.stringify({ timestamp: '2026-03-27T00:00:06.000Z', type: 'event_msg', payload: { type: 'task_started', turn_id: 'src-turn-3' } }),
          JSON.stringify({ timestamp: '2026-03-27T00:00:06.500Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'SrcQ3' }] } }),
          JSON.stringify({ timestamp: '2026-03-27T00:00:07.000Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'SrcA3' }] } }),
          JSON.stringify({ timestamp: '2026-03-27T00:00:08.000Z', type: 'event_msg', payload: { type: 'task_complete', turn_id: 'src-turn-3' } }),
        ].join('\n'),
        'utf-8',
      );

      // Fork transcript: copied turns 1-3 + new fork turn
      fs.writeFileSync(
        path.join(sessionsDir, `rollout-2026-03-27T00-00-00-${forkThreadId}.jsonl`),
        [
          // Copied source turns (have same turn IDs)
          JSON.stringify({ timestamp: '2026-03-27T00:00:00.000Z', type: 'event_msg', payload: { type: 'task_started', turn_id: 'src-turn-1' } }),
          JSON.stringify({ timestamp: '2026-03-27T00:00:00.500Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'SrcQ1' }] } }),
          JSON.stringify({ timestamp: '2026-03-27T00:00:01.000Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'SrcA1' }] } }),
          JSON.stringify({ timestamp: '2026-03-27T00:00:02.000Z', type: 'event_msg', payload: { type: 'task_complete', turn_id: 'src-turn-1' } }),
          JSON.stringify({ timestamp: '2026-03-27T00:00:03.000Z', type: 'event_msg', payload: { type: 'task_started', turn_id: 'src-turn-2' } }),
          JSON.stringify({ timestamp: '2026-03-27T00:00:03.500Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'SrcQ2' }] } }),
          JSON.stringify({ timestamp: '2026-03-27T00:00:04.000Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'SrcA2' }] } }),
          JSON.stringify({ timestamp: '2026-03-27T00:00:05.000Z', type: 'event_msg', payload: { type: 'task_complete', turn_id: 'src-turn-2' } }),
          // New fork-only turn
          JSON.stringify({ timestamp: '2026-03-27T01:00:00.000Z', type: 'event_msg', payload: { type: 'task_started', turn_id: 'fork-turn-1' } }),
          JSON.stringify({ timestamp: '2026-03-27T01:00:00.500Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'ForkQ1' }] } }),
          JSON.stringify({ timestamp: '2026-03-27T01:00:01.000Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ForkA1' }] } }),
          JSON.stringify({ timestamp: '2026-03-27T01:00:02.000Z', type: 'event_msg', payload: { type: 'task_complete', turn_id: 'fork-turn-1' } }),
        ].join('\n'),
        'utf-8',
      );

      const conversation: Conversation = {
        id: 'conv-ef',
        providerId: 'codex',
        title: 'Established Fork',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        sessionId: null,
        providerState: {
          threadId: forkThreadId,
          sessionFilePath: path.join(sessionsDir, `rollout-2026-03-27T00-00-00-${forkThreadId}.jsonl`),
          forkSource: { sessionId: sourceThreadId, resumeAt: 'src-turn-2' },
        },
        messages: [],
      };

      const service = new CodexConversationHistoryService();
      await service.hydrateConversationHistory(conversation, null);

      // Expected: source prefix (turns 1+2) + fork-only turn
      // = SrcQ1, SrcA1, SrcQ2, SrcA2, ForkQ1, ForkA1
      expect(conversation.messages).toHaveLength(6);
      expect(conversation.messages[0].content).toBe('SrcQ1');
      expect(conversation.messages[1].content).toBe('SrcA1');
      expect(conversation.messages[2].content).toBe('SrcQ2');
      expect(conversation.messages[3].content).toBe('SrcA2');
      expect(conversation.messages[4].content).toBe('ForkQ1');
      expect(conversation.messages[5].content).toBe('ForkA1');
    });

    it('does not widen established-fork history when resumeAt is missing', async () => {
      const sourceThreadId = 'source-thread-ef-missing';
      const forkThreadId = 'fork-thread-ef-missing';
      const sessionsDir = path.join(tempHome, '.codex', 'sessions', '2026', '03', '27');
      fs.mkdirSync(sessionsDir, { recursive: true });

      fs.writeFileSync(
        path.join(sessionsDir, `rollout-2026-03-27T00-00-00-${sourceThreadId}.jsonl`),
        [
          JSON.stringify({ timestamp: '2026-03-27T00:00:00.000Z', type: 'event_msg', payload: { type: 'task_started', turn_id: 'src-turn-1' } }),
          JSON.stringify({ timestamp: '2026-03-27T00:00:00.500Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'SrcQ1' }] } }),
          JSON.stringify({ timestamp: '2026-03-27T00:00:01.000Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'SrcA1' }] } }),
          JSON.stringify({ timestamp: '2026-03-27T00:00:02.000Z', type: 'event_msg', payload: { type: 'task_complete', turn_id: 'src-turn-1' } }),
          JSON.stringify({ timestamp: '2026-03-27T00:00:03.000Z', type: 'event_msg', payload: { type: 'task_started', turn_id: 'src-turn-2' } }),
          JSON.stringify({ timestamp: '2026-03-27T00:00:03.500Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'SrcQ2' }] } }),
          JSON.stringify({ timestamp: '2026-03-27T00:00:04.000Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'SrcA2' }] } }),
          JSON.stringify({ timestamp: '2026-03-27T00:00:05.000Z', type: 'event_msg', payload: { type: 'task_complete', turn_id: 'src-turn-2' } }),
        ].join('\n'),
        'utf-8',
      );

      fs.writeFileSync(
        path.join(sessionsDir, `rollout-2026-03-27T00-00-00-${forkThreadId}.jsonl`),
        [
          JSON.stringify({ timestamp: '2026-03-27T00:00:00.000Z', type: 'event_msg', payload: { type: 'task_started', turn_id: 'src-turn-1' } }),
          JSON.stringify({ timestamp: '2026-03-27T00:00:00.500Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'SrcQ1' }] } }),
          JSON.stringify({ timestamp: '2026-03-27T00:00:01.000Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'SrcA1' }] } }),
          JSON.stringify({ timestamp: '2026-03-27T00:00:02.000Z', type: 'event_msg', payload: { type: 'task_complete', turn_id: 'src-turn-1' } }),
          JSON.stringify({ timestamp: '2026-03-27T01:00:00.000Z', type: 'event_msg', payload: { type: 'task_started', turn_id: 'fork-turn-1' } }),
          JSON.stringify({ timestamp: '2026-03-27T01:00:00.500Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'ForkQ1' }] } }),
          JSON.stringify({ timestamp: '2026-03-27T01:00:01.000Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ForkA1' }] } }),
          JSON.stringify({ timestamp: '2026-03-27T01:00:02.000Z', type: 'event_msg', payload: { type: 'task_complete', turn_id: 'fork-turn-1' } }),
        ].join('\n'),
        'utf-8',
      );

      const conversation: Conversation = {
        id: 'conv-ef-missing',
        providerId: 'codex',
        title: 'Established Fork Missing Checkpoint',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        sessionId: null,
        providerState: {
          threadId: forkThreadId,
          sessionFilePath: path.join(sessionsDir, `rollout-2026-03-27T00-00-00-${forkThreadId}.jsonl`),
          forkSource: { sessionId: sourceThreadId, resumeAt: 'src-turn-missing' },
        },
        messages: [],
      };

      const service = new CodexConversationHistoryService();
      await service.hydrateConversationHistory(conversation, null);

      expect(conversation.messages).toEqual([]);
    });
  });

  it('retries hydration after an empty transcript parse', async () => {
    const threadId = 'thread-789';
    const sessionsDir = path.join(tempHome, '.codex', 'sessions', '2026', '03', '27');
    fs.mkdirSync(sessionsDir, { recursive: true });

    const transcriptPath = path.join(
      sessionsDir,
      `rollout-2026-03-27T00-00-00-${threadId}.jsonl`,
    );

    fs.writeFileSync(transcriptPath, '', 'utf-8');

    const conversation: Conversation = {
      id: 'conv-3',
      providerId: 'codex',
      title: 'Eventually Written Transcript',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      sessionId: threadId,
      providerState: { threadId, sessionFilePath: transcriptPath },
      messages: [],
    };

    const service = new CodexConversationHistoryService();
    await service.hydrateConversationHistory(conversation, null);
    expect(conversation.messages).toEqual([]);

    fs.writeFileSync(
      transcriptPath,
      [
        JSON.stringify({
          timestamp: '2026-03-27T00:00:00.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'Second prompt' }],
          },
        }),
        JSON.stringify({
          timestamp: '2026-03-27T00:00:01.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'Second answer' }],
          },
        }),
      ].join('\n'),
      'utf-8',
    );

    await service.hydrateConversationHistory(conversation, null);

    expect(conversation.messages).toHaveLength(2);
    expect(conversation.messages[0]).toMatchObject({
      role: 'user',
      content: 'Second prompt',
    });
  });

  it.each(['normal', 'pending fork', 'established fork'])(
    'rejects %s hydration when a transcript exists but cannot be read',
    async (mode) => {
      const sessions = path.join(tempHome, '.codex', 'sessions');
      fs.mkdirSync(sessions, { recursive: true });
      // A directory opens like a file but fails to read, standing in for oversized or unreadable transcripts.
      const unreadable = path.join(sessions, 'rollout-unreadable.jsonl');
      fs.mkdirSync(unreadable, { recursive: true });
      const readable = path.join(sessions, 'rollout-fork.jsonl');
      fs.writeFileSync(readable, [
        { type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn' } },
        { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Hello' }] } },
      ].map((record, seconds) => JSON.stringify({ timestamp: `2026-03-27T00:00:0${seconds}.000Z`, ...record })).join('\n'));
      const forkSource = { sessionId: 'source', resumeAt: 'turn' };
      const providerState = mode === 'normal'
        ? { threadId: 'thread', sessionFilePath: unreadable }
        : mode === 'pending fork'
          ? { forkSource, forkSourceSessionFilePath: unreadable }
          : { threadId: 'fork', sessionFilePath: readable, forkSource, forkSourceSessionFilePath: unreadable };
      const conversation: Conversation = {
        id: 'unreadable', providerId: 'codex', title: 'Unreadable',
        createdAt: Date.now(), updatedAt: Date.now(),
        sessionId: mode === 'pending fork' ? null : (providerState.threadId as string | null),
        providerState, messages: [],
      };

      await expect(new CodexConversationHistoryService().hydrateConversationHistory(conversation, null))
        .rejects.toMatchObject({ code: 'EISDIR' });
    },
  );
});
