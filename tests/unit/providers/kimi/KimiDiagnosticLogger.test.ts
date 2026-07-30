import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { KimiDiagnosticLogger } from '@/providers/kimi/runtime/KimiDiagnosticLogger';

describe('KimiDiagnosticLogger', () => {
  let tmpDir: string;
  let logger: KimiDiagnosticLogger;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kimi-logger-test-'));
    logger = new KimiDiagnosticLogger(tmpDir);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { force: true, recursive: true }).catch(() => {});
  });

  it('is disabled by default and produces no file', async () => {
    expect(logger.isEnabled()).toBe(false);
    logger.log('testMethod', { foo: 'bar' });

    // Wait briefly for any async write
    await new Promise(r => setTimeout(r, 50));
    const logPath = await logger.getLogPath();
    expect(logPath).toBeTruthy();
    await expect(fs.stat(logPath!)).rejects.toThrow();
  });

  it('writes JSON line log entry when enabled', async () => {
    logger.setEnabled(true);
    expect(logger.isEnabled()).toBe(true);

    logger.log('syncSessionConfig', { sessionId: 's1', count: 2 });

    const logPath = (await logger.getLogPath())!;

    // Wait briefly for async append
    let content = '';
    for (let i = 0; i < 10; i++) {
      try {
        content = await fs.readFile(logPath, 'utf8');
        if (content) break;
      } catch {
        await new Promise(r => setTimeout(r, 20));
      }
    }

    expect(content).toContain('"method":"syncSessionConfig"');
    expect(content).toContain('"sessionId":"s1"');
    const parsed = JSON.parse(content.trim());
    expect(parsed.method).toBe('syncSessionConfig');
    expect(parsed.data).toEqual({ sessionId: 's1', count: 2 });
    expect(parsed.timestamp).toBeTruthy();
  });
});
