import {
  buildTitleGenerationSystemPrompt,
  resolveTitleGenerationLocale,
} from '@/core/prompt/titleGeneration';

describe('title generation locale', () => {
  it('uses an explicit title locale before interface locale', () => {
    expect(resolveTitleGenerationLocale({
      locale: 'en',
      titleGenerationLocale: 'zh-CN',
    })).toBe('zh-CN');
    expect(buildTitleGenerationSystemPrompt('zh-CN')).toContain('Simplified Chinese');
  });

  it('falls back to a valid interface locale when title locale is invalid', () => {
    expect(resolveTitleGenerationLocale({
      locale: 'ja',
      titleGenerationLocale: 'not-a-locale',
    })).toBe('ja');
    expect(buildTitleGenerationSystemPrompt('ja')).toContain('Japanese');
  });
});
