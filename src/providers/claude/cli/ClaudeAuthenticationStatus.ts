import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export async function isClaudeAuthenticated(cliPath: string | null): Promise<boolean> {
  if (!cliPath) {
    return false;
  }

  try {
    const { stdout } = await execFileAsync(cliPath, ['auth', 'status', '--json'], {
      timeout: 5_000,
      windowsHide: true,
    });
    const status = JSON.parse(stdout) as { loggedIn?: unknown };
    return status.loggedIn === true;
  } catch {
    return false;
  }
}
