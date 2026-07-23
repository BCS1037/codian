import type { AuxQueryConfig, AuxQueryRunner } from '../../../core/auxiliary/AuxQueryRunner';
import type { ProviderHost } from '../../../core/providers/ProviderHost';
import { NativeAcpChatRuntime } from './NativeAcpChatRuntime';
import type { NativeAcpRuntimeOptions } from './types';

export class NativeAcpAuxQueryRunner implements AuxQueryRunner {
  private runtime: NativeAcpChatRuntime | null = null;

  constructor(
    private readonly plugin: ProviderHost,
    private readonly options: NativeAcpRuntimeOptions,
  ) {}

  async query(config: AuxQueryConfig, prompt: string): Promise<string> {
    this.reset();
    const runtime = new NativeAcpChatRuntime(this.plugin, this.options);
    this.runtime = runtime;
    const abort = () => runtime.cancel();
    config.abortController?.signal.addEventListener('abort', abort, { once: true });

    try {
      if (config.abortController?.signal.aborted) {
        throw new Error('Cancelled');
      }
      const fullPrompt = `${config.systemPrompt.trim()}\n\n${prompt}`.trim();
      let text = '';
      for await (const chunk of runtime.query(
        runtime.prepareTurn({ text: fullPrompt }),
        undefined,
        { model: config.model },
      )) {
        if (chunk.type === 'text') {
          text += chunk.content;
          config.onTextChunk?.(text);
        } else if (chunk.type === 'error') {
          throw new Error(chunk.content);
        }
      }
      return text;
    } finally {
      config.abortController?.signal.removeEventListener('abort', abort);
      runtime.cleanup();
      if (this.runtime === runtime) {
        this.runtime = null;
      }
    }
  }

  reset(): void {
    this.runtime?.cleanup();
    this.runtime = null;
  }
}
