import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';

import { ClaudeTurnInputs, getReplayedClaudeUserMessageId } from '@/providers/claude/runtime/ClaudeTurnInputs';

function resultMessage(fields: Record<string, unknown>): SDKMessage {
  return {
    type: 'result',
    subtype: 'success',
    ...fields,
  } as unknown as SDKMessage;
}

describe('ClaudeTurnInputs', () => {
  it('tracks each steer separately and waits until all native inputs are consumed', () => {
    const inputs = new ClaudeTurnInputs('primary');
    inputs.addSteer('steer-1');
    inputs.addSteer('steer-2');

    inputs.observe(resultMessage({
      user_message_uuids: ['primary'],
      queued_turn_count: 2,
    }));
    expect(inputs.wasConsumed('primary')).toBe(true);
    expect(inputs.settled).toBe(false);

    inputs.observe(resultMessage({
      user_message_uuids: ['steer-1', 'steer-2'],
      queued_turn_count: 0,
    }));
    expect(inputs.wasConsumed('steer-1')).toBe(true);
    expect(inputs.wasConsumed('steer-2')).toBe(true);
    expect(inputs.settled).toBe(true);
  });

  it('uses single-message SDK result IDs and keeps a queued steer open', () => {
    const inputs = new ClaudeTurnInputs('primary');
    inputs.addSteer('steer-1');

    inputs.observe(resultMessage({
      user_message_uuid: 'primary',
      queued_turn_count: 1,
    }));
    expect(inputs.settled).toBe(false);

    inputs.observe(resultMessage({
      user_message_uuid: 'steer-1',
      queued_turn_count: 0,
    }));
    expect(inputs.settled).toBe(true);
  });

  it('treats only the first matching replay as steer delivery acknowledgement', () => {
    const inputs = new ClaudeTurnInputs('primary');
    inputs.addSteer('steer-1');
    const replay = {
      type: 'user',
      uuid: 'steer-1',
      parent_tool_use_id: null,
      isReplay: true,
    } as unknown as SDKMessage;

    expect(getReplayedClaudeUserMessageId(replay)).toBe('steer-1');
    expect(inputs.observe(replay)).toBe('steer-1');
    expect(inputs.isUndeliveredSteer('steer-1')).toBe(false);
    expect(inputs.observe(replay)).toBeUndefined();
    expect(inputs.settled).toBe(false);
  });

  it('ignores results explicitly owned by a different native input', () => {
    const inputs = new ClaudeTurnInputs('primary');
    inputs.addSteer('steer-1');

    const unrelated = resultMessage({
      user_message_uuids: ['other-session-input'],
      queued_turn_count: 0,
    });
    expect(inputs.matches(unrelated)).toBe(false);
    inputs.observe(unrelated);
    expect(inputs.wasConsumed('primary')).toBe(false);
    expect(inputs.settled).toBe(false);
  });

  it('falls back to the first result when an older CLI has no consumption metadata', () => {
    const inputs = new ClaudeTurnInputs('primary');
    inputs.addSteer('steer-1');

    inputs.observe(resultMessage({}));

    expect(inputs.wasConsumed('primary')).toBe(true);
    expect(inputs.wasConsumed('steer-1')).toBe(true);
    expect(inputs.settled).toBe(true);
  });

  it('recalls only a steer that has not been replayed by Claude', () => {
    const inputs = new ClaudeTurnInputs('primary');
    inputs.addSteer('steer-1');
    inputs.addSteer('steer-2');
    inputs.observe({
      type: 'user',
      uuid: 'steer-1',
      parent_tool_use_id: null,
      isReplay: true,
    } as unknown as SDKMessage);

    expect(inputs.removeUndeliveredSteer('steer-1')).toBe(false);
    expect(inputs.removeUndeliveredSteer('steer-2')).toBe(true);
    expect(inputs.ids).toEqual(['primary', 'steer-1']);
    expect(inputs.hasUndeliveredSteers()).toBe(false);
  });
});
