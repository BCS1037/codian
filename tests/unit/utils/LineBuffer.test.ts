import { LineBuffer } from '@/utils/LineBuffer';

describe('LineBuffer', () => {
  it('buffers and emits complete lines splitting by newline', () => {
    const buffer = new LineBuffer();
    const emitted: string[] = [];
    const onLine = (line: string): void => { emitted.push(line); };

    buffer.push('hello ', onLine);
    expect(emitted).toEqual([]);
    expect(buffer.bufferedLength).toBe(6);

    buffer.push('world\nnext line\npartial', onLine);
    expect(emitted).toEqual(['hello world', 'next line']);
    expect(buffer.bufferedLength).toBe(7);

    buffer.push('\n', onLine);
    expect(emitted).toEqual(['hello world', 'next line', 'partial']);
    expect(buffer.bufferedLength).toBe(0);
  });

  it('strips carriage returns from CRLF', () => {
    const buffer = new LineBuffer();
    const emitted: string[] = [];
    buffer.push('line1\r\nline2\r\n', line => emitted.push(line));
    expect(emitted).toEqual(['line1', 'line2']);
  });

  it('throws when buffered length exceeds maxLength', () => {
    const buffer = new LineBuffer(10);
    expect(() => {
      buffer.push('this line is way too long without newline', () => {});
    }).toThrow('Line exceeded the size limit.');
  });

  it('take() flushes the remaining incomplete line', () => {
    const buffer = new LineBuffer();
    buffer.push('incomplete\r', () => {});
    expect(buffer.bufferedLength).toBe(11);
    expect(buffer.take()).toBe('incomplete');
    expect(buffer.bufferedLength).toBe(0);
  });
});
