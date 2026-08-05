import {
  buildSystemPrompt,
  computeSystemPromptKey,
  type SystemPromptSettings,
} from '../../../core/prompt/mainAgent';

const GROK_PROMPT_OPTIONS = Object.freeze({
  toolGuidanceProfile: 'provider-native' as const,
});

export type GrokSystemPromptSettings = SystemPromptSettings & {
  memoryAppendix?: string;
};

export function buildGrokSystemPrompt(settings: GrokSystemPromptSettings): string {
  return buildSystemPrompt(settings, {
    ...GROK_PROMPT_OPTIONS,
    memoryAppendix: settings.memoryAppendix,
  });
}

export function computeGrokSystemPromptKey(settings: GrokSystemPromptSettings): string {
  return computeSystemPromptKey(settings, {
    ...GROK_PROMPT_OPTIONS,
    memoryAppendix: settings.memoryAppendix,
  });
}
