import { spawn } from 'node:child_process';

import * as os from 'os';
import * as path from 'path';

import { setLoginShellPathEntries } from './env';
import { parsePathEntries } from './path';

const LOGIN_SHELL_TIMEOUT_MS = 10_000;
const PATH_MARKER = '__CODIAN_LOGIN_PATH__';

let resolution: Promise<void> | null = null;

/**
 * GUI-launched apps do not inherit the PATH that shell profiles build (version managers,
 * custom bins). Reads it once from an interactive login shell; failure keeps guessed paths.
 */
export function resolveLoginShellPath(): Promise<void> {
  resolution ??= readLoginShellPath().then(setLoginShellPathEntries);
  return resolution;
}

export function resetLoginShellPathForTesting(): void {
  resolution = null;
}

async function readLoginShellPath(): Promise<string[]> {
  if (process.platform === 'win32') return [];
  const shell = getLoginShell();
  if (!shell) return [];
  // printenv reports the exported PATH colon-joined in every shell, including fish.
  const script = `printf '%s' '${PATH_MARKER}'; /usr/bin/printenv PATH; printf '%s' '${PATH_MARKER}'`;
  const output = await runShellProbe(shell, script, LOGIN_SHELL_TIMEOUT_MS);
  const value = output?.split(PATH_MARKER)[1];
  return value ? parsePathEntries(value.trim()).filter(entry => path.isAbsolute(entry)) : [];
}

function getLoginShell(): string | null {
  let shell = process.env.SHELL;
  if (!shell) {
    try {
      shell = os.userInfo().shell ?? undefined;
    } catch {
      return null;
    }
  }
  return shell && path.isAbsolute(shell) ? shell : null;
}

function runShellProbe(shell: string, script: string, timeoutMs: number): Promise<string | null> {
  return new Promise((resolve) => {
    let settled = false;
    let proc: ReturnType<typeof spawn> | null = null;
    const output: Buffer[] = [];
    let outputBytes = 0;

    function finish(result: string | null): void {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      if (proc && !proc.killed) {
        try {
          proc.kill('SIGTERM');
        } catch {
          // ignore
        }
      }
      resolve(result);
    }

    const timer = window.setTimeout(() => finish(null), timeoutMs);

    try {
      proc = spawn(shell, ['-i', '-l', '-c', script], {
        cwd: os.homedir(),
        env: { ...process.env, CODIAN_RESOLVING_ENVIRONMENT: '1' },
        stdio: ['ignore', 'pipe', 'ignore'],
      });

      proc.on('error', () => finish(null));
      proc.on('close', (code) => {
        finish(code === 0 ? Buffer.concat(output).toString('utf8') : null);
      });

      proc.stdout?.on('data', (chunk: Buffer | string) => {
        if (settled) return;
        const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
        outputBytes += bytes.length;
        if (outputBytes > 65_536) {
          finish(null);
          return;
        }
        output.push(bytes);
      });
    } catch {
      finish(null);
    }
  });
}
