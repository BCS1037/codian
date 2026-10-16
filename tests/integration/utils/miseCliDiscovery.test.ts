import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { findCliBinaryPath } from '@/utils/cliBinaryLocator';
import { getEnhancedPath } from '@/utils/env';

describe('mise-managed CLI discovery', () => {
  const environmentKeys = ['PATH', 'MISE_SHIMS_DIR', 'MISE_DATA_DIR', 'XDG_DATA_HOME'];
  const originalEnvironment = new Map(environmentKeys.map(key => [key, process.env[key]]));
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(tmpdir(), 'codian mise shims '));
    for (const key of environmentKeys) delete process.env[key];
    process.env.PATH = '';
    process.env.MISE_SHIMS_DIR = path.join(tempDir, 'mise shims');
  });

  afterEach(() => {
    for (const [key, value] of originalEnvironment) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('finds and launches a synthetic CLI without installing mise', () => {
    const shimsDir = process.env.MISE_SHIMS_DIR;
    if (!shimsDir) throw new Error('MISE_SHIMS_DIR fixture is missing');

    const binaryName = 'codian-mise-probe';
    const executable = path.join(shimsDir, `${binaryName}${process.platform === 'win32' ? '.exe' : ''}`);
    const enhancedPath = getEnhancedPath();
    mkdirSync(shimsDir, { recursive: true });
    if (process.platform === 'win32') copyFileSync(process.execPath, executable);
    else symlinkSync(process.execPath, executable);

    const resolvedPath = findCliBinaryPath(binaryName);
    if (!resolvedPath) throw new Error('mise-managed CLI was not discovered');

    expect(resolvedPath).toBe(executable);
    expect(enhancedPath.split(path.delimiter)).toContain(shimsDir);
    expect(execFileSync(resolvedPath, ['-p', '"mise probe ok"'], {
      cwd: tempDir,
      env: { ...process.env, PATH: enhancedPath },
      encoding: 'utf8',
    }).trim()).toBe('mise probe ok');
  });
});
