import type * as zlibType from 'node:zlib';

import type * as fsType from 'fs';
import type * as osType from 'os';
import type * as pathType from 'path';

const fs = jest.requireActual<typeof fsType>('fs');
const os = jest.requireActual<typeof osType>('os');
const path = jest.requireActual<typeof pathType>('path');


import { forEachJSONLLine } from '@/utils/jsonlFile';

describe('forEachJSONLLine', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codian-jsonl-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function write(content: string | Buffer): string {
    const file = path.join(dir, 'history.jsonl');
    fs.writeFileSync(file, content);
    return file;
  }

  async function collect(file: string, maxLineLength?: number): Promise<string[]> {
    const lines: string[] = [];
    await forEachJSONLLine(file, line => { lines.push(line); }, { maxLineLength });
    return lines;
  }

  it('reassembles lines and multibyte characters split across read chunks', async () => {
    // The reader uses 1 MiB chunks; place a 4-byte character across the boundary.
    const first = `${'a'.repeat(1024 * 1024 - 2)}😀b`;
    const file = write(`${first}\r\n{"x":1}\nlast`);

    await expect(collect(file)).resolves.toEqual([first, '{"x":1}', 'last']);
  });

  it('rejects instead of skipping a line longer than the limit', async () => {
    // Skipping would hand consumers a history with a silently missing record.
    const file = write(`short\n${'x'.repeat(50)}\nafter\n`);
    const lines: string[] = [];

    await expect(forEachJSONLLine(file, line => { lines.push(line); }, { maxLineLength: 10 })).rejects.toThrow();
    expect(lines).not.toContain('after');
  });

  it('stops when the handler returns false', async () => {
    const file = write('a\nb\nc\n');
    const lines: string[] = [];

    await forEachJSONLLine(file, line => { lines.push(line); return line !== 'b'; });

    expect(lines).toEqual(['a', 'b']);
  });

  it('rejects when the file cannot be read', async () => {
    await expect(collect(path.join(dir, 'missing.jsonl'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('reads zstd-compressed .zst JSONL files', async () => {
    const zlib = jest.requireActual<typeof zlibType>('node:zlib');
    if (typeof zlib.zstdCompressSync !== 'function') return;
    const raw = '{"line":1}\n{"line":2}\n{"line":3}\n';
    const compressed = zlib.zstdCompressSync(Buffer.from(raw, 'utf-8'));
    const file = path.join(dir, 'history.jsonl.zst');
    fs.writeFileSync(file, compressed);

    await expect(collect(file)).resolves.toEqual(['{"line":1}', '{"line":2}', '{"line":3}']);
  });
});
