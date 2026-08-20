import { ProviderRegistry } from '../../../core/providers/ProviderRegistry';
import type { ProviderId } from '../../../core/providers/types';
import type { ChatRuntime } from '../../../core/runtime/ChatRuntime';
import type { ChatRuntimeConversationState } from '../../../core/runtime/types';
import type { Conversation } from '../../../core/types';
import type { FeatureHost } from '../../FeatureHost';

export interface TabRuntimeFactoryInput {
  plugin: FeatureHost;
  providerId: ProviderId;
  conversation: Conversation | null;
  selectedModel: string | null;
}

export interface TabRuntimeLease {
  runtime: ChatRuntime;
  unsubscribeReadyState(): void;
  cleanup(): void;
}

/**
 * Atomically prepares the runtime portion of a chat tab.
 * Tab installation and tab-specific lifecycle state remain owned by Tab.ts.
 */
export class TabRuntimeFactory {
  static prepare(input: TabRuntimeFactoryInput): TabRuntimeLease {
    const runtime = ProviderRegistry.createChatRuntime({
      plugin: input.plugin.providerHost,
      providerId: input.providerId,
    });

    let unsubscribeReadyState: (() => void) | null = null;
    let readyStateUnsubscribed = false;
    let cleaned = false;

    const unsubscribe = (): void => {
      if (readyStateUnsubscribed) {
        return;
      }
      readyStateUnsubscribed = true;
      unsubscribeReadyState?.();
    };

    const cleanup = (): void => {
      if (cleaned) {
        return;
      }
      cleaned = true;
      unsubscribe();
      runtime.cleanup();
    };

    try {
      unsubscribeReadyState = runtime.onReadyStateChange(() => {});

      const hasMessages = input.conversation ? input.conversation.messages.length > 0 : false;
      const externalContextPaths = input.conversation && hasMessages
        ? input.conversation.externalContextPaths || []
        : (input.plugin.settings.persistentExternalContextPaths || []);
      const runtimeConversationState: ChatRuntimeConversationState | null = input.conversation
        ?? (input.selectedModel ? { sessionId: null, selectedModel: input.selectedModel } : null);

      // Passive sync: provider process starts only when query() is called.
      runtime.syncConversationState(runtimeConversationState, externalContextPaths);

      return {
        runtime,
        unsubscribeReadyState: unsubscribe,
        cleanup,
      };
    } catch (error) {
      cleanup();
      throw error;
    }
  }
}
