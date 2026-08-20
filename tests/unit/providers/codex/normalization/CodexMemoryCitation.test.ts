import { stripCodexMemoryCitationMarkup } from '@/providers/codex/normalization/CodexMemoryCitation';

describe('stripCodexMemoryCitationMarkup', () => {
  it('removes complete and unterminated citation blocks', () => {
    expect(stripCodexMemoryCitationMarkup(
      'Before<oai-mem-citation>internal</oai-mem-citation>After',
    )).toBe('BeforeAfter');
    expect(stripCodexMemoryCitationMarkup(
      'Before<oai-mem-citation>unfinished',
    )).toBe('Before');
  });

  it('preserves partial opening-tag prefixes', () => {
    expect(stripCodexMemoryCitationMarkup('Before<oai-mem-')).toBe('Before<oai-mem-');
  });
});
