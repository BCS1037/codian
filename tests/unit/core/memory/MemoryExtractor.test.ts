import { MemoryExtractor } from '@/core/memory/MemoryExtractor';

describe('MemoryExtractor', () => {
  const extractor = new MemoryExtractor();

  it('recognizes explicit retain and forget requests', () => {
    expect(extractor.extract('Remember that I prefer concise replies.', []).entries)
      .toMatchObject([{ category: 'User Preferences', content: 'I prefer concise replies.' }]);
    expect(extractor.extractForgetRequest('Forget concise replies')).toBe('concise replies');
  });

  it('recognizes Chinese retain requests', () => {
    expect(extractor.extract('请记住：我偏好简洁的回复', []).entries)
      .toMatchObject([{ category: 'User Preferences', content: '我偏好简洁的回复' }]);
  });

  it('extracts conservative implicit facts and deduplicates them', () => {
    const extracted = extractor.extractImplicit('I usually write tests before a release.', []);

    expect(extracted.entries).toMatchObject([
      { category: 'Work Habits', content: 'Usually write tests before a release.' },
    ]);
    expect(extractor.extractImplicit('I usually write tests before a release.', extracted.entries).entries)
      .toEqual([]);
  });

  it('detects a memory listing request without retaining it', () => {
    expect(extractor.isListRequest('Show all my memories')).toBe(true);
    expect(extractor.extract('Show all my memories', []).entries).toEqual([]);
  });
});
