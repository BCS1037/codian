import { PassThrough } from 'node:stream';

import { subscribePiJsonlLines, writePiJsonl } from '@/providers/pi/runtime/PiJsonl';

describe('PiJsonl', () => {
  it('preserves UTF-8 characters split across Buffer chunks', () => {
    const stream = new PassThrough();
    const lines: string[] = [];
    subscribePiJsonlLines(stream, line => lines.push(line));
    const expected = '{"text":"日本語😀"}';

    for (const byte of Buffer.from(`${expected}\n`, 'utf8')) {
      stream.write(Buffer.from([byte]));
    }

    expect(lines).toEqual([expected]);
  });

  it('flushes incomplete UTF-8 bytes as one replacement character on end', async () => {
    const stream = new PassThrough();
    const lines: string[] = [];
    subscribePiJsonlLines(stream, line => lines.push(line));

    stream.write(Buffer.from('{"text":"', 'utf8'));
    stream.write(Buffer.from([0xe6, 0x97]));
    stream.end();
    await new Promise(resolve => setImmediate(resolve));

    expect(lines).toEqual(['{"text":"�']);
  });

  it('accepts string chunks from an encoded readable stream', async () => {
    const stream = new PassThrough();
    stream.setEncoding('utf8');
    const lines: string[] = [];
    subscribePiJsonlLines(stream, line => lines.push(line));
    const expected = '{"text":"漢字😀"}';

    for (const byte of Buffer.from(`${expected}\n`, 'utf8')) {
      stream.write(Buffer.from([byte]));
    }
    stream.end();
    await new Promise(resolve => setImmediate(resolve));

    expect(lines).toEqual([expected]);
  });

  it('stops receiving lines after unsubscribe', () => {
    const stream = new PassThrough();
    const lines: string[] = [];
    const unsubscribe = subscribePiJsonlLines(stream, line => lines.push(line));

    unsubscribe();
    stream.write('{"a":1}\n');

    expect(lines).toEqual([]);
  });

  it('splits only on LF and strips CR', () => {
    const stream = new PassThrough();
    const lines: string[] = [];
    subscribePiJsonlLines(stream, line => lines.push(line));
    const separator = String.fromCharCode(0x2028);
    const paragraphSeparator = String.fromCharCode(0x2029);

    stream.write(`{"a":1}\r\n{"b":"line${separator}separator${paragraphSeparator}still same record"}\n`);

    expect(lines).toEqual([
      '{"a":1}',
      `{"b":"line${separator}separator${paragraphSeparator}still same record"}`,
    ]);
  });

  it('emits trailing buffered records on end', async () => {
    const stream = new PassThrough();
    const lines: string[] = [];
    subscribePiJsonlLines(stream, line => lines.push(line));

    stream.write('{"a":1}');
    stream.end();
    await new Promise(resolve => setImmediate(resolve));

    expect(lines).toEqual(['{"a":1}']);
  });

  it('writes JSONL records', () => {
    const output = new PassThrough();
    const chunks: string[] = [];
    output.on('data', chunk => chunks.push(chunk.toString('utf8')));

    writePiJsonl(output, { type: 'ping' });

    expect(chunks.join('')).toBe('{"type":"ping"}\n');
  });
});
