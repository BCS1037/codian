import type { Readable, Writable } from 'node:stream';

import type { ProviderCapabilities, ProviderId } from '../../../core/providers/types';
import type {
  AcpClientConnection,
  AcpLoadSessionResponse,
  AcpNewSessionResponse,
  AcpSessionConfigOption,
  AcpSubprocessLaunchSpec,
} from '../../acp';

export interface NativeAcpSubprocess {
  readonly stdin: Writable;
  readonly stdout: Readable;
  isAlive(): boolean;
  onClose(listener: (error?: Error) => void): () => void;
  shutdown(): Promise<void>;
  start(): void;
}

export interface NativeAcpRuntimeOptions {
  args: string[];
  capabilities: ProviderCapabilities;
  createSubprocess?: (spec: AcpSubprocessLaunchSpec) => NativeAcpSubprocess;
  defaultCommand: string;
  providerId: ProviderId;
  sessionAdapter?: NativeAcpSessionAdapter;
}

export interface NativeAcpSessionAdapter {
  applySelections(params: {
    connection: AcpClientConnection;
    model?: string;
    sessionId: string;
  }): Promise<void>;
  formatStartError?(error: unknown): string;
  handleConfigOptions?(configOptions: AcpSessionConfigOption[], sessionId: string): Promise<void> | void;
  syncSessionConfig(
    source: AcpNewSessionResponse | (AcpLoadSessionResponse & { sessionId: string }),
  ): Promise<void>;
}
