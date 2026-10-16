import type {
  AcpLoadSessionRequest,
  AcpLoadSessionResponse,
  AcpNewSessionRequest,
  AcpNewSessionResponse,
  AcpPromptRequest,
  AcpPromptResponse,
  AcpSetSessionConfigOptionRequest,
  AcpSetSessionConfigOptionResponse,
} from '../../acp/types';

export interface OpencodeUserTextRange {
  readonly start: number;
  readonly end: number;
}

/** Protocol-neutral session operations consumed by the OpenCode chat runtime. */
export interface OpencodeSessionConnection {
  initialize(): Promise<unknown>;
  newSession(request: AcpNewSessionRequest): Promise<AcpNewSessionResponse>;
  loadSession(request: AcpLoadSessionRequest): Promise<AcpLoadSessionResponse>;
  prompt(
    request: AcpPromptRequest,
    userTextRange?: OpencodeUserTextRange | null,
  ): Promise<AcpPromptResponse>;
  hasPendingPrompt?(): boolean;
  cancel(request: { sessionId: string }): void;
  setConfigOption(
    request: AcpSetSessionConfigOptionRequest,
  ): Promise<AcpSetSessionConfigOptionResponse>;
  dispose(): void | Promise<void>;
}
