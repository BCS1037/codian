import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';

/** Inputs owned by one requested runtime turn, including live steers. */
export class ClaudeTurnInputs {
  readonly #ids: string[];
  readonly #unconsumed: Set<string>;
  readonly #undeliveredSteers = new Set<string>();
  #settled = false;

  constructor(primaryId: string) {
    if (!primaryId) throw new Error('Claude turn input requires a primary message ID');
    this.#ids = [primaryId];
    this.#unconsumed = new Set([primaryId]);
  }

  get ids(): readonly string[] {
    return this.#ids;
  }

  get settled(): boolean {
    return this.#settled;
  }

  hasSteers(): boolean {
    return this.#ids.length > 1;
  }

  addSteer(id: string): void {
    if (this.#settled) throw new Error('Claude turn inputs are already settled');
    if (!id || this.#ids.includes(id)) throw new Error('Claude steer input ID must be unique');
    this.#ids.push(id);
    this.#unconsumed.add(id);
    this.#undeliveredSteers.add(id);
  }

  hasUndeliveredSteers(): boolean {
    return this.#undeliveredSteers.size > 0;
  }

  isUndeliveredSteer(id: string): boolean {
    return this.#undeliveredSteers.has(id);
  }

  hasUnconsumedSteers(): boolean {
    return this.#ids.slice(1).some(id => this.#unconsumed.has(id));
  }

  wasConsumed(id: string): boolean {
    return this.#ids.includes(id) && !this.#unconsumed.has(id);
  }

  matches(message: SDKMessage): boolean | undefined {
    const ids = getReferencedClaudeUserMessageIds(message);
    if (ids.length === 0) return undefined;
    return ids.some(id => this.#ids.includes(id));
  }

  /** Records replay acknowledgements and native result consumption. */
  observe(message: SDKMessage): string | undefined {
    if (this.#settled) return undefined;

    const replayedId = getReplayedClaudeUserMessageId(message);
    if (replayedId && this.#undeliveredSteers.delete(replayedId)) {
      return replayedId;
    }

    if (message.type !== 'result' || this.matches(message) === false) return undefined;

    const record = message as unknown as Record<string, unknown>;
    const consumedIds = getClaudeResultConsumedIds(record);
    if (consumedIds === null) {
      // Older CLI builds do not echo consumption metadata. Preserve their terminal behavior.
      this.#consumeAll();
      return undefined;
    }

    for (const id of consumedIds) {
      if (!this.#unconsumed.delete(id)) continue;
      this.#undeliveredSteers.delete(id);
    }

    if (
      this.#unconsumed.size === 0
      || (typeof record.queued_turn_count === 'number' && record.queued_turn_count === 0)
    ) {
      this.#settled = true;
    }
    return undefined;
  }

  /** Removes only a steer that the SDK has not replayed into a native turn. */
  removeUndeliveredSteer(id: string): boolean {
    if (!this.#undeliveredSteers.delete(id)) return false;
    this.#unconsumed.delete(id);
    const index = this.#ids.indexOf(id);
    if (index > 0) this.#ids.splice(index, 1);
    return true;
  }

  #consumeAll(): void {
    this.#unconsumed.clear();
    this.#undeliveredSteers.clear();
    this.#settled = true;
  }
}

/** A replay is Claude's acknowledgement that a streamed user message entered a native turn. */
export function getReplayedClaudeUserMessageId(message: SDKMessage): string | undefined {
  if (
    message.type !== 'user'
    || !('isReplay' in message)
    || message.isReplay !== true
    || message.parent_tool_use_id !== null
  ) {
    return undefined;
  }
  return typeof message.uuid === 'string' ? message.uuid : undefined;
}

function getReferencedClaudeUserMessageIds(message: SDKMessage): string[] {
  const record = message as unknown as Record<string, unknown>;
  const ids = Array.isArray(record.user_message_uuids)
    ? record.user_message_uuids.filter((id): id is string => typeof id === 'string')
    : [];
  if (ids.length > 0) return ids;
  return typeof record.user_message_uuid === 'string'
    ? [record.user_message_uuid]
    : [];
}

function getClaudeResultConsumedIds(record: Record<string, unknown>): string[] | null {
  const ids = Array.isArray(record.user_message_uuids)
    ? record.user_message_uuids.filter((id): id is string => typeof id === 'string')
    : [];
  if (ids.length > 0) return ids;
  return typeof record.user_message_uuid === 'string'
    ? [record.user_message_uuid]
    : null;
}
