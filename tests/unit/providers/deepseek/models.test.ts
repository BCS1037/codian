import {
  decodeDeepSeekModelId,
  encodeDeepSeekModelId,
  normalizeDeepSeekModels,
} from '@/providers/deepseek/models';

describe('DeepSeek models', () => {
  it('encodes and decodes deepseek model IDs', () => {
    const encoded = encodeDeepSeekModelId('deepseek', 'deepseek-chat');
    expect(encoded).toBe('deepseek:deepseek/deepseek-chat');

    const decoded = decodeDeepSeekModelId(encoded);
    expect(decoded).toEqual({
      provider: 'deepseek',
      model: 'deepseek-chat',
    });
  });

  it('rejects invalid model IDs when decoding', () => {
    expect(decodeDeepSeekModelId('invalid:id')).toBeNull();
    expect(decodeDeepSeekModelId('deepseek:notenoughparts')).toBeNull();
    expect(decodeDeepSeekModelId('')).toBeNull();
  });

  it('normalizes deepseek models from catalog output', () => {
    const raw = [
      {
        provider: 'deepseek',
        id: 'deepseek-reasoner',
        label: 'DeepSeek R1',
        description: 'Reasoning model',
        reasoning: [{ id: 'high', name: 'High' }],
      },
    ];

    const normalized = normalizeDeepSeekModels(raw);
    expect(normalized).toHaveLength(1);
    expect(normalized[0]).toMatchObject({
      encodedId: 'deepseek:deepseek/deepseek-reasoner',
      provider: 'deepseek',
      id: 'deepseek-reasoner',
      label: 'DeepSeek R1',
      description: 'Reasoning model',
      reasoning: [{ id: 'high', name: 'High' }],
    });
  });
});
