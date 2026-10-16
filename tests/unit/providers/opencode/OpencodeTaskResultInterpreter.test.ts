import { OpencodeTaskResultInterpreter } from '@/providers/opencode/auxiliary/OpencodeTaskResultInterpreter';
import { normalizeOpencodeToolUseResult } from '@/providers/opencode/normalization/opencodeToolNormalization';

describe('OpencodeTaskResultInterpreter', () => {
  it('identifies a native background launch and its child session', () => {
    const result = normalizeOpencodeToolUseResult('task', { background: true }, {
      content: [{
        text: 'The subagent is working in the background (sessionID: ses_child).',
        type: 'text',
      }],
      metadata: { sessionID: 'ses_child', status: 'background' },
    });
    const interpreter = new OpencodeTaskResultInterpreter();

    expect(interpreter.hasAsyncLaunchMarker(result)).toBe(true);
    expect(interpreter.extractAgentId(result)).toBe('ses_child');
    expect(interpreter.extractTagValue('<result>Child output</result>', 'result')).toBe('Child output');
  });
});
