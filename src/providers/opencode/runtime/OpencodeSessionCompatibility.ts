export type OpencodeNativeVersion = 1 | 2;

export function assertOpencodeSessionCompatibility(
  storedVersion: OpencodeNativeVersion | undefined,
  hasStoredSession = storedVersion !== undefined,
): void {
  if (!hasStoredSession || storedVersion === 2) return;
  if (storedVersion === 1) {
    throw new Error(
      'This conversation was created with OpenCode v1 ACP and cannot resume under V2. Start a new conversation; stored history is preserved.',
    );
  }
  throw new Error(
    'This conversation has no OpenCode V2 session metadata and cannot resume safely. Start a new conversation; stored history is preserved.',
  );
}
