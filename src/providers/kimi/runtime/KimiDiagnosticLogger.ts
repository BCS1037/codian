import * as fs from 'node:fs/promises';
import * as path from 'node:path';

const MAX_LOG_SIZE_BYTES = 1_048_576; // 1 MB
const LOG_FILENAME = 'kimi-diagnostics.log';
const CODIAN_DIR = '.codian';

export class KimiDiagnosticLogger {
  private logPath: string | null = null;
  private enabled = false;

  constructor(private readonly vaultPath: string) {
    this.logPath = path.join(vaultPath, CODIAN_DIR, LOG_FILENAME);
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  log(method: string, data: unknown): void {
    if (!this.enabled || !this.logPath) return;
    const entry = {
      data,
      method,
      timestamp: new Date().toISOString(),
    };
    void this.appendEntry(JSON.stringify(entry));
  }

  async getLogPath(): Promise<string | null> {
    return this.logPath;
  }

  private async appendEntry(line: string): Promise<void> {
    if (!this.logPath) return;
    try {
      const dir = path.dirname(this.logPath);
      await fs.mkdir(dir, { recursive: true });
      await this.rotateIfNeeded();
      await fs.appendFile(this.logPath, line + '\n', 'utf8');
    } catch {
      // Swallow write errors silently — diagnostics must not disrupt runtime.
    }
  }

  private async rotateIfNeeded(): Promise<void> {
    if (!this.logPath) return;
    try {
      const stat = await fs.stat(this.logPath);
      if (stat.size > MAX_LOG_SIZE_BYTES) {
        const rotatedPath = this.logPath + '.old';
        await fs.rename(this.logPath, rotatedPath).catch(() => {});
      }
    } catch {
      // File does not exist yet — nothing to rotate.
    }
  }
}
