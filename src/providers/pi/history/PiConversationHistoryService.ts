import * as fs from 'node:fs/promises';

import type {
  ProviderConversationHistoryService,
  ProviderHistoryPathContext,
} from '../../../core/providers/types';
import type { ChatMessage, Conversation } from '../../../core/types';
import {
  buildPersistedPiState,
  getPiState,
  type PiPreviousSession,
} from '../types';
import { resolvePiSessionFileHint } from './PiHistoryPathResolver';
import { parsePiSessionContent } from './PiHistoryStore';

export class PiConversationHistoryService implements ProviderConversationHistoryService {
  private hydratedKeys = new Map<string, string>();

  async hydrateConversationHistory(
    conversation: Conversation,
    vaultPath: string | null,
    pathContext?: ProviderHistoryPathContext,
  ): Promise<void> {
    const state = getPiState(conversation.providerState);
    if (this.isPendingForkConversation(conversation)) {
      const sourceSessionFile = resolvePiSessionFileHint(
        state.forkSourceSessionFile,
        state.forkSource!.sessionId,
        vaultPath,
        pathContext,
      );
      this.replaceResolvedPath(
        conversation,
        'forkSourceSessionFile',
        state.forkSourceSessionFile,
        sourceSessionFile,
      );
      if (conversation.messages.length > 0) {
        return;
      }
      if (!sourceSessionFile) {
        this.hydratedKeys.delete(conversation.id);
        return;
      }

      try {
        const content = await fs.readFile(sourceSessionFile, 'utf-8');
        const messages = parsePiSessionContent(content, {
          leafEntryId: state.forkSource!.resumeAt,
          requireLeafEntryId: true,
        });
        if (messages.length === 0) {
          this.hydratedKeys.delete(conversation.id);
          return;
        }

        conversation.messages = messages;
        this.hydratedKeys.set(conversation.id, `fork::${sourceSessionFile}::${state.forkSource!.resumeAt}`);
      } catch {
        this.hydratedKeys.delete(conversation.id);
      }
      return;
    }

    const currentSession: PiPreviousSession = {
      ...(state.leafEntryId ? { leafEntryId: state.leafEntryId } : {}),
      ...(state.sessionFile ? { sessionFile: state.sessionFile } : {}),
      ...((state.sessionId ?? conversation.sessionId)
        ? { sessionId: state.sessionId ?? conversation.sessionId! }
        : {}),
    };
    const sourceSpecs: Array<{
      kind: 'current' | 'previous';
      source: PiPreviousSession;
    }> = [
      ...(state.previousSessions ?? []).map(source => ({ kind: 'previous' as const, source })),
      ...(currentSession.sessionFile || currentSession.sessionId
        ? [{ kind: 'current' as const, source: currentSession }]
        : []),
    ];
    if (sourceSpecs.length === 0) {
      this.hydratedKeys.delete(conversation.id);
      return;
    }

    const resolvedSources = sourceSpecs.flatMap(({ kind, source }) => {
      const sessionFile = resolvePiSessionFileHint(
        source.sessionFile,
        source.sessionId,
        vaultPath,
        pathContext,
      );
      if (kind === 'current') {
        this.replaceResolvedPath(
          conversation,
          'sessionFile',
          source.sessionFile,
          sessionFile,
        );
      }
      return sessionFile
        ? [{ kind, sessionFile, source }]
        : [];
    });
    if (resolvedSources.length === 0) {
      this.hydratedKeys.delete(conversation.id);
      return;
    }

    const hydrationKey = JSON.stringify(resolvedSources.map(({ kind, sessionFile, source }) => ({
      kind,
      leafEntryId: source.leafEntryId ?? null,
      sessionFile,
    })));
    if (
      conversation.messages.length > 0
      && this.hydratedKeys.get(conversation.id) === hydrationKey
    ) {
      return;
    }

    try {
      const messages: ChatMessage[] = [];
      for (const { kind, sessionFile, source } of resolvedSources) {
        try {
          const content = await fs.readFile(sessionFile, 'utf-8');
          messages.push(...parsePiSessionContent(content, {
            leafEntryId: source.leafEntryId,
            requireLeafEntryId: kind === 'previous' && !!source.leafEntryId,
            syntheticIdNamespace: sessionFile,
          }));
        } catch {
          // Ignore unavailable historical segments; current segment may still hydrate.
        }
      }
      if (messages.length === 0) {
        this.hydratedKeys.delete(conversation.id);
        return;
      }

      conversation.messages = dedupeMessages(messages);
      this.hydratedKeys.set(conversation.id, hydrationKey);
    } catch {
      this.hydratedKeys.delete(conversation.id);
    }
  }

  async deleteConversationSession(
    _conversation: Conversation,
    _vaultPath: string | null,
  ): Promise<void> {
    // Never mutate Pi native history.
  }

  resolveSessionIdForConversation(conversation: Conversation | null): string | null {
    const state = getPiState(conversation?.providerState);
    return state.sessionFile
      ?? state.sessionId
      ?? conversation?.sessionId
      ?? state.forkSource?.sessionId
      ?? state.previousSessions?.at(-1)?.sessionFile
      ?? state.previousSessions?.at(-1)?.sessionId
      ?? null;
  }

  isPendingForkConversation(_conversation: Conversation): boolean {
    const state = getPiState(_conversation.providerState);
    return !!state.forkSource && !state.sessionId && !state.sessionFile && !_conversation.sessionId;
  }

  buildForkProviderState(
    sourceSessionId: string,
    resumeAt: string,
    sourceProviderState?: Record<string, unknown>,
  ): Record<string, unknown> {
    const sourceState = getPiState(sourceProviderState);
    const sourceSessionFile = sourceState.sessionFile ?? sourceState.forkSourceSessionFile;
    return buildPersistedPiState({
      forkSource: { sessionId: sourceSessionId, resumeAt },
      ...(sourceSessionFile ? { forkSourceSessionFile: sourceSessionFile } : {}),
    }) as Record<string, unknown>;
  }

  buildPersistedProviderState(
    conversation: Conversation,
  ): Record<string, unknown> | undefined {
    return buildPersistedPiState(getPiState(conversation.providerState)) as Record<string, unknown> | undefined;
  }

  private replaceResolvedPath(
    conversation: Conversation,
    field: 'forkSourceSessionFile' | 'sessionFile',
    persistedPath: string | undefined,
    resolvedPath: string | null,
  ): void {
    if (!persistedPath || persistedPath === resolvedPath) {
      return;
    }

    const nextState = { ...getPiState(conversation.providerState) };
    if (resolvedPath) {
      nextState[field] = resolvedPath;
    } else {
      delete nextState[field];
    }
    conversation.providerState = buildPersistedPiState(nextState) as Record<string, unknown> | undefined;
  }

}

function dedupeMessages(messages: ChatMessage[]): ChatMessage[] {
  const seen = new Set<string>();
  return messages.filter((message) => {
    if (seen.has(message.id)) {
      return false;
    }
    seen.add(message.id);
    return true;
  });
}
