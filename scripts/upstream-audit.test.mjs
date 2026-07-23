import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const scriptPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'upstream-audit.mjs',
);

function git(repo, ...args) {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
}

test('reports commits and changed files between two refs', t => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'codian-upstream-audit-'));
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));

  git(repo, 'init', '-b', 'main');
  git(repo, 'config', 'user.name', 'Codian Test');
  git(repo, 'config', 'user.email', 'codian-test@example.invalid');
  fs.writeFileSync(path.join(repo, 'existing.ts'), 'export const value = 1;\n');
  git(repo, 'add', 'existing.ts');
  git(repo, 'commit', '-m', 'base');
  git(repo, 'tag', 'base');

  fs.writeFileSync(path.join(repo, 'existing.ts'), 'export const value = 2;\n');
  fs.writeFileSync(path.join(repo, 'added.ts'), 'export const added = true;\n');
  git(repo, 'add', 'existing.ts', 'added.ts');
  git(repo, 'commit', '-m', 'target change');
  git(repo, 'tag', 'target');

  const result = spawnSync(process.execPath, [
    scriptPath,
    '--repo', repo,
    '--from', 'base',
    '--to', 'target',
    '--json',
  ], { encoding: 'utf8' });

  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.from.ref, 'base');
  assert.equal(report.to.ref, 'target');
  assert.equal(report.commitCount, 1);
  assert.deepEqual(report.changedFiles, [
    { status: 'A', path: 'added.ts', existsInWorkingTree: true },
    { status: 'M', path: 'existing.ts', existsInWorkingTree: true },
  ]);
  assert.match(report.commits[0].subject, /target change/);
});
