import { randomUUID } from 'node:crypto';

import type { AuxQueryConfig, AuxQueryRunner } from '../../../core/auxiliary/AuxQueryRunner';
import type { ProviderExecutionRequest, ProviderInteractionPort } from '../../../core/execution';
import type { ProviderHost } from '../../../core/providers/ProviderHost';
import { getVaultPath } from '../../../utils/path';
import { getDeepSeekWorkspaceServices } from '../app/DeepSeekWorkspaceServices';
import { DeepSeekExecutionSession } from '../execution/DeepSeekExecutionSession';

const NOOP_INTERACTION_PORT: ProviderInteractionPort = {
  requestApproval: async req => ({ interactionId: req.interactionId, decision: 'deny' }),
  askUserQuestion: async req => ({ interactionId: req.interactionId, answers: null }),
  dismissInteraction: () => {},
};

export class DeepSeekAuxQueryRunner implements AuxQueryRunner {
  constructor(private readonly host: ProviderHost) {}

  async query(config: AuxQueryConfig, prompt: string): Promise<string> {
    const workspace = getDeepSeekWorkspaceServices();
    const session = new DeepSeekExecutionSession(
      this.host,
      {
        lifecycle: 'ephemeral',
        nativePersistence: 'disabled-if-supported',
        vaultWorkingDirectory: getVaultPath(this.host.app) ?? process.cwd(),
        interactionPort: NOOP_INTERACTION_PORT,
      },
      workspace.deepseek,
    );

    const abortController = config.abortController ?? new AbortController();
    const request: ProviderExecutionRequest = {
      inputId: randomUUID(),
      input: [{ type: 'text', text: prompt }],
      configuration: {
        systemInstructions: config.systemPrompt
          ? { kind: 'explicit', instructions: config.systemPrompt }
          : { kind: 'provider-default' },
        model: config.model,
      },
      toolPolicy: { kind: 'passive' },
      signal: abortController.signal,
    };

    let accumulatedText = '';
    try {
      const run = session.execute(request);
      for await (const event of run.events) {
        if (event.type === 'text_delta') {
          accumulatedText += event.text;
          config.onTextChunk?.(accumulatedText);
        } else if (event.type === 'execution_error') {
          throw new Error(event.message);
        }
      }
    } finally {
      await session.dispose();
    }

    return accumulatedText;
  }

  reset(): void {}
}
