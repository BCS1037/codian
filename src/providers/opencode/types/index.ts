export interface OpencodeProviderState {
  databasePath?: string;
  nativeVersion?: 1 | 2;
}

export function getOpencodeState(
  providerState?: Record<string, unknown>,
): OpencodeProviderState {
  return (providerState ?? {});
}
