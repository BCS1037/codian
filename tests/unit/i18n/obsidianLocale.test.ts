import { resolveObsidianLocale } from '@/i18n/obsidianLocale';

describe('resolveObsidianLocale', () => {
  it.each([
    ['en', 'en'],
    ['zh', 'zh-CN'],
    ['zh-TW', 'zh-TW'],
    ['pt-BR', 'pt'],
    ['ja', 'ja'],
  ])('maps Obsidian language %s to plugin locale %s', (language, expected) => {
    expect(resolveObsidianLocale(language)).toBe(expected);
  });

  it('falls back to English when Obsidian language is unsupported', () => {
    expect(resolveObsidianLocale('id')).toBe('en');
  });
});
