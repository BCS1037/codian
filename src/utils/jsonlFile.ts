import { constants } from 'node:buffer';
import { createReadStream } from 'node:fs';
import type { Transform } from 'node:stream';
import * as zlib from 'node:zlib';

import { LineBuffer } from '@/utils/LineBuffer';

const DEFAULT_JSONL_IDLE_TIMEOUT_MS = 10_000;
const JSONL_READ_CHUNK_BYTES = 1024 * 1024;

export interface JSONLFileReadOptions {
  /** Rejects on a line longer than this many UTF-16 code units; defaults to V8's string limit. */
  maxLineLength?: number;
  /** Rejects when the file yields no data for this long; total read time is unbounded. */
  idleTimeoutMs?: number;
}

/**
 * Streams a JSONL file one line at a time so files larger than one JavaScript string stay
 * readable. Supports optional zstd-compressed (.zst) JSONL files.
 * Returning false from `onLine` stops the read. I/O failures, idle timeouts and
 * unreadably long lines reject, so callers never receive history with a silently missing record.
 */
export async function forEachJSONLLine(
  filePath: string,
  onLine: (line: string) => boolean | void,
  options: JSONLFileReadOptions = {},
): Promise<void> {
  const idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_JSONL_IDLE_TIMEOUT_MS;
  const lines = new LineBuffer(options.maxLineLength ?? constants.MAX_STRING_LENGTH);
  const isZst = filePath.endsWith('.zst');
  const rawStream = createReadStream(filePath, {
    ...(isZst ? {} : { encoding: 'utf8' }),
    highWaterMark: JSONL_READ_CHUNK_BYTES,
  });

  if (!rawStream) return;

  let decompressor: Transform | null = null;

  if (isZst) {
    if (typeof zlib.createZstdDecompress !== 'function') {
      rawStream?.destroy();
      throw new Error('Zstandard decompression is not supported in this runtime environment.');
    }
    decompressor = zlib.createZstdDecompress();
    rawStream.on('error', err => decompressor?.destroy(err));
    decompressor.on('error', err => rawStream?.destroy(err));
  }

  const input = decompressor
    ? (rawStream.pipe(decompressor).setEncoding('utf8') as NodeJS.ReadableStream)
    : rawStream;

  let timer: number | undefined;
  const armTimer = (): void => {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => {
      const err = new Error('Timed out reading JSONL history.');
      rawStream?.destroy(err);
      decompressor?.destroy(err);
    }, idleTimeoutMs);
  };
  let stopped = false;
  const accept = (line: string): void => {
    if (!stopped && onLine(line) === false) stopped = true;
  };

  try {
    armTimer();
    for await (const chunk of input as AsyncIterable<string>) {
      armTimer();
      lines.push(chunk, accept);
      if (stopped) return;
    }
    if (lines.bufferedLength > 0) accept(lines.take());
  } finally {
    window.clearTimeout(timer);
    rawStream?.destroy();
    decompressor?.destroy();
  }
}
