import type {
  ProviderTaskResultInterpreter,
  ProviderTaskTerminalStatus,
} from '../../../core/providers/types';

export class OpencodeTaskResultInterpreter implements ProviderTaskResultInterpreter {
  hasAsyncLaunchMarker(toolUseResult: unknown): boolean {
    if (typeof toolUseResult === 'string') {
      return /The subagent is working in the background \(sessionID: ses_[^)\s]+\)/u.test(toolUseResult);
    }
    const record = asRecord(toolUseResult);
    const metadata = asRecord(record?.metadata);
    return record?.asyncLaunchMarker === true
      || metadata?.status === 'background';
  }

  extractAgentId(toolUseResult: unknown): string | null {
    const record = asRecord(toolUseResult);
    const metadata = asRecord(record?.metadata);
    const directId = nonEmptyString(record?.agentId, record?.sessionID, metadata?.sessionID);
    if (directId) return directId;

    const text = typeof toolUseResult === 'string'
      ? toolUseResult
      : typeof record?.content === 'string' ? record.content : '';
    return /(?:background \()?sessionID[=: ]+['"]?(ses_[A-Za-z0-9_-]+)/u.exec(text)?.[1] ?? null;
  }

  extractStructuredResult(toolUseResult: unknown): string | null {
    const record = asRecord(toolUseResult);
    const result = nonEmptyString(record?.result, record?.output);
    return result ?? null;
  }

  resolveTerminalStatus(
    toolUseResult: unknown,
    fallbackStatus: ProviderTaskTerminalStatus,
  ): ProviderTaskTerminalStatus {
    const record = asRecord(toolUseResult);
    const metadata = asRecord(record?.metadata);
    const status = record?.status ?? metadata?.status;
    if (status === 'completed' || status === 'success' || status === 'succeeded') return 'completed';
    if (status === 'error' || status === 'failed' || status === 'failure') return 'error';
    return fallbackStatus;
  }

  extractTagValue(payload: string, tagName: string): string | null {
    const safeTag = tagName.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
    return new RegExp(`<${safeTag}>([\\s\\S]*?)<\\/${safeTag}>`, 'u').exec(payload)?.[1] ?? null;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function nonEmptyString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}
