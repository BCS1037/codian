import { projectOpencodeFormQuestions } from '@/providers/opencode/http/OpencodeHttpForms';

describe('projectOpencodeFormQuestions', () => {
  it('maps native question forms into shared question UI fields and preserves native option values', () => {
    expect(projectOpencodeFormQuestions({
      fields: [{
        description: 'Choose a strategy',
        key: 'strategy',
        options: [{ label: 'Fast', value: 'fast', description: 'Lower latency' }],
        title: 'Strategy',
        type: 'string',
      }],
      metadata: { kind: 'question' },
    })).toEqual([{
      id: 'strategy',
      header: 'Strategy',
      question: 'Choose a strategy',
      multiSelect: false,
      isOther: false,
      options: [{ label: 'Fast', value: 'fast', description: 'Lower latency' }],
    }]);
  });

  it('rejects hidden, conditional, and schema-constrained MCP fields instead of changing answer meaning', () => {
    for (const field of [
      { key: 'token', type: 'string', hidden: true },
      { key: 'token', type: 'string', when: ['other'] },
      { key: 'count', type: 'integer', required: true },
      { key: 'name', type: 'string', required: true, minLength: 2 },
    ]) {
      expect(() => projectOpencodeFormQuestions({
        fields: [field],
        metadata: { kind: 'mcp-elicitation' },
      })).toThrow('Unsupported OpenCode form');
    }
  });

  it('rejects empty and unknown form schemas', () => {
    expect(() => projectOpencodeFormQuestions({ fields: [], metadata: { kind: 'question' } }))
      .toThrow('Unsupported OpenCode form');
    expect(() => projectOpencodeFormQuestions({
      fields: [{ key: 'file', type: 'file' }], metadata: { kind: 'question' },
    })).toThrow('Unsupported OpenCode form');
  });
});
