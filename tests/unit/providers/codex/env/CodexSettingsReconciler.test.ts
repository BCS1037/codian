import { TEST_CODEX_CATALOG, TEST_CODEX_MODEL } from '@test/helpers/codexModels';

import { isVersionedRuntimeInputFingerprint } from '@/core/providers/settings/RuntimeInputFingerprint';
import type { Conversation } from '@/core/types';
import {
  codexSettingsReconciler,
  computeCodexEnvHash,
} from '@/providers/codex/env/CodexSettingsReconciler';

function createConversation(): Conversation {
  return {
    providerId: 'codex',
    sessionId: 'thread-123',
    providerState: {
      threadId: 'thread-123',
      sessionFilePath: '/tmp/thread-123.jsonl',
    },
    messages: [],
  } as unknown as Conversation;
}

function createSettings(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    model: TEST_CODEX_MODEL,
    providerConfigs: {
      codex: {
        enabled: true,
        discoveredModels: TEST_CODEX_CATALOG,
        environmentVariables: '',
        environmentHash: '',
        ...overrides,
      },
    },
  };
}

describe('codexSettingsReconciler', () => {
  it('finalizes empty legacy fingerprint before later CLI input changes', () => {
    const settings = createSettings();
    const conversation = createConversation();

    expect(codexSettingsReconciler.normalizeModelVariantSettings(settings)).toBe(true);
    expect(codexSettingsReconciler.reconcileModelWithEnvironment(settings, [conversation]))
      .toEqual({ changed: false, invalidatedConversations: [] });

    (settings.providerConfigs as any).codex.cliPath = '/opt/codex/bin/codex';

    expect(codexSettingsReconciler.normalizeModelVariantSettings(settings)).toBe(false);
    expect(codexSettingsReconciler.reconcileModelWithEnvironment(settings, [conversation]))
      .toMatchObject({ changed: true, invalidatedConversations: [conversation] });
  });

  it('migrates matching legacy environment fingerprint without invalidating history', () => {
    const settings = createSettings({
      environmentVariables: 'OPENAI_BASE_URL=https://same.example.com/v1',
      environmentHash: 'OPENAI_BASE_URL=https://same.example.com/v1',
    });
    const conversation = createConversation();

    expect(codexSettingsReconciler.normalizeModelVariantSettings(settings)).toBe(true);
    expect(codexSettingsReconciler.reconcileModelWithEnvironment(settings, [conversation]))
      .toEqual({ changed: false, invalidatedConversations: [] });
    expect(isVersionedRuntimeInputFingerprint(
      (settings.providerConfigs as any).codex.environmentHash,
    )).toBe(true);
  });

  it('invalidates history when runtime inputs change', () => {
    const settings = createSettings({
      environmentVariables: 'OPENAI_BASE_URL=https://new.example.com/v1',
      environmentHash: 'OPENAI_BASE_URL=https://old.example.com/v1',
    });
    const conversation = createConversation();

    expect(codexSettingsReconciler.reconcileModelWithEnvironment(settings, [conversation]))
      .toMatchObject({ changed: true, invalidatedConversations: [conversation] });
    expect(conversation.sessionId).toBeNull();
    expect(conversation.providerState).toBeUndefined();
  });

  it('persists opaque API-key-sensitive fingerprint', () => {
    const secret = 'codex-test-secret-value';
    const fingerprint = computeCodexEnvHash(`OPENAI_API_KEY=${secret}`);

    expect(isVersionedRuntimeInputFingerprint(fingerprint)).toBe(true);
    expect(fingerprint).not.toContain(secret);
    expect(computeCodexEnvHash('OPENAI_API_KEY=other-test-secret')).not.toBe(fingerprint);
  });
});
