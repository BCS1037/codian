import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { getEnhancedPath, setLoginShellPathEntries } from '../../../src/utils/env';
import { resetLoginShellPathForTesting, resolveLoginShellPath } from '../../../src/utils/loginShellPath';

const describeUnix = process.platform === 'win32' ? describe.skip : describe;

describeUnix('login shell PATH for GUI-launched processes', () => {
  const originalEnv = process.env;
  let directory: string;
  let loginBin: string;

  beforeEach(() => {
    resetLoginShellPathForTesting();
    setLoginShellPathEntries([]);
    directory = mkdtempSync(path.join(tmpdir(), 'codian-login-shell-'));
    loginBin = path.join(directory, 'login-only-bin');
    mkdirSync(loginBin);
    const cli = path.join(loginBin, 'codian-login-probe');
    writeFileSync(cli, '#!/bin/sh\necho ok\n');
    chmodSync(cli, 0o755);
    process.env = { ...originalEnv, HOME: directory, PATH: '/usr/bin:/bin' };
    for (const key of ['FNM_DIR', 'FNM_MULTISHELL_PATH', 'NVM_BIN', 'VOLTA_HOME', 'XDG_DATA_HOME']) {
      delete process.env[key];
    }
  });

  afterEach(() => {
    process.env = originalEnv;
    setLoginShellPathEntries([]);
    rmSync(directory, { recursive: true, force: true });
  });

  function writeShell(body: string): void {
    const shell = path.join(directory, 'fake-shell');
    writeFileSync(shell, `#!/bin/sh\n${body}\n`);
    chmodSync(shell, 0o755);
    process.env.SHELL = shell;
  }

  function writeLoginShell(): void {
    writeShell([
      'echo "profile noise $PATH"',
      'for last; do :; done',
      `PATH='${loginBin}:/usr/bin:/bin'; export PATH`,
      'eval "$last"',
    ].join('\n'));
  }

  it('resolves child PATH from the login shell before launch', async () => {
    writeLoginShell();

    await resolveLoginShellPath();

    const entries = getEnhancedPath('/configured/bin').split(path.delimiter);
    expect(entries[0]).toBe('/configured/bin');
    expect(entries[1]).toBe(loginBin);
    expect(entries.some(entry => entry.includes('profile noise'))).toBe(false);
  });

  it('falls back to guessed locations when the login shell fails', async () => {
    writeShell('echo broken >&2\nexit 1');

    await resolveLoginShellPath();

    const entries = getEnhancedPath().split(path.delimiter);
    expect(entries).toContain(path.join(directory, '.local', 'bin'));
  });
});
