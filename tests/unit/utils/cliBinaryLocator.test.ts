import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { findCliBinaryPath, resolveConfiguredCliPath } from '@/utils/cliBinaryLocator';

describe('cliBinaryLocator', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-binary-locator-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('resolves configured CLI files', () => {
    const cliPath = path.join(tempDir, 'pi');
    fs.writeFileSync(cliPath, '');

    expect(resolveConfiguredCliPath(cliPath)).toBe(cliPath);
  });

  it('finds Windows npm .cmd shims on a PATH entry', () => {
    const binDir = path.join(tempDir, 'bin');
    const shimPath = path.join(binDir, 'pi.cmd');
    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(shimPath, '');

    expect(findCliBinaryPath('pi', binDir, 'win32')).toBe(shimPath);
  });

  it('finds a CLI in the configured mise shims directory', () => {
    const originalEnvironment = { ...process.env };
    const shimsDir = path.join(tempDir, 'mise shims');
    const cliPath = path.join(shimsDir, 'codian-mise-probe');
    fs.mkdirSync(shimsDir, { recursive: true });
    fs.writeFileSync(cliPath, '');
    process.env.MISE_SHIMS_DIR = shimsDir;
    process.env.PATH = '';

    try {
      expect(findCliBinaryPath('codian-mise-probe')).toBe(cliPath);
    } finally {
      Object.keys(process.env).forEach(key => delete process.env[key]);
      Object.assign(process.env, originalEnvironment);
    }
  });

  it('keeps a manually configured CLI directory ahead of mise shims', () => {
    const originalEnvironment = { ...process.env };
    const manualDir = path.join(tempDir, 'manual cli');
    const shimsDir = path.join(tempDir, 'mise shims');
    const manualCliPath = path.join(manualDir, 'codian-mise-probe');
    fs.mkdirSync(manualDir, { recursive: true });
    fs.mkdirSync(shimsDir, { recursive: true });
    fs.writeFileSync(manualCliPath, 'manual');
    fs.writeFileSync(path.join(shimsDir, 'codian-mise-probe'), 'mise');
    process.env.MISE_SHIMS_DIR = shimsDir;
    process.env.PATH = '';

    try {
      expect(findCliBinaryPath('codian-mise-probe', manualDir)).toBe(manualCliPath);
    } finally {
      Object.keys(process.env).forEach(key => delete process.env[key]);
      Object.assign(process.env, originalEnvironment);
    }
  });
});
