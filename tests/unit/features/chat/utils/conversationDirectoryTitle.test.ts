import { formatConversationDirectoryTitle } from '@/features/chat/utils/conversationDirectoryTitle';

describe('formatConversationDirectoryTitle', () => {
  const EMOJI = '😀';

  it('truncates at a surrogate pair boundary without splitting the pair', () => {
    const raw = `${'x'.repeat(76)}${EMOJI}tail`;
    expect(formatConversationDirectoryTitle(raw)).toBe(`${'x'.repeat(76)}...`);
  });

  it('keeps a surrogate pair that fits before the truncation boundary', () => {
    const raw = `${'x'.repeat(75)}${EMOJI}tail`;
    expect(formatConversationDirectoryTitle(raw)).toBe(`${'x'.repeat(75)}${EMOJI}...`);
  });

  it('leaves an exact 80-unit title unchanged', () => {
    const raw = `${'x'.repeat(78)}${EMOJI}`;
    expect(formatConversationDirectoryTitle(raw)).toBe(`${'x'.repeat(78)}${EMOJI}`);
  });

  it('returns empty string for empty input', () => {
    expect(formatConversationDirectoryTitle('')).toBe('');
    expect(formatConversationDirectoryTitle('   \n  \n  ')).toBe('');
  });

  it('preserves Unicode/Chinese characters without truncation if under limit', () => {
    const text = '这是一个中文对话标题，用于测试是否能正常保留字符';
    expect(formatConversationDirectoryTitle(text)).toBe(text);
  });
});
