import type {
  ProviderConversationHistoryService,
  ProviderSettingsReconciler,
  ProviderTaskResultInterpreter,
  ProviderTaskTerminalStatus,
} from '../../core/providers/types';
import type { Conversation } from '../../core/types';

export class NativeAcpConversationHistoryService implements ProviderConversationHistoryService {
  async hydrateConversationHistory(_conversation: Conversation): Promise<void> {}
  async deleteConversationSession(_conversation: Conversation): Promise<void> {}

  resolveSessionIdForConversation(conversation: Conversation | null): string | null {
    return conversation?.sessionId ?? null;
  }

  isPendingForkConversation(_conversation: Conversation): boolean {
    return false;
  }

  buildForkProviderState(): Record<string, unknown> {
    return {};
  }
}

export class NativeAcpTaskResultInterpreter implements ProviderTaskResultInterpreter {
  hasAsyncLaunchMarker(_toolUseResult: unknown): boolean { return false; }
  extractAgentId(_toolUseResult: unknown): string | null { return null; }
  extractStructuredResult(_toolUseResult: unknown): string | null { return null; }
  extractTagValue(_payload: string, _tagName: string): string | null { return null; }

  resolveTerminalStatus(
    _toolUseResult: unknown,
    fallbackStatus: ProviderTaskTerminalStatus,
  ): ProviderTaskTerminalStatus {
    return fallbackStatus;
  }
}

export const nativeAcpSettingsReconciler: ProviderSettingsReconciler = {
  invalidateConversationSessions() {
    return [];
  },
  reconcileModelWithEnvironment() {
    return { changed: false, invalidatedConversations: [] };
  },
  normalizeModelVariantSettings() {
    return false;
  },
};
