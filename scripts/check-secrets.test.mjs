import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const script = path.resolve('scripts/check-secrets.mjs');

function createRepo() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'codian-secret-check-'));
  spawnSync('git', ['init', '-q'], { cwd: repo });
  spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo });
  spawnSync('git', ['config', 'user.name', 'Test'], { cwd: repo });
  return repo;
}

function commit(repo, file, contents, message) {
  fs.writeFileSync(path.join(repo, file), contents);
  spawnSync('git', ['add', file], { cwd: repo });
  spawnSync('git', ['commit', '-qm', message], { cwd: repo });
}

function run(repo) {
  return spawnSync(process.execPath, [script, '--repo', repo, '--json'], { encoding: 'utf8' });
}

test('accepts repository without common credential patterns', () => {
  const repo = createRepo();
  commit(repo, 'safe.txt', 'sk-short-placeholder\n', 'safe');
  const result = run(repo);
  assert.equal(result.status, 0, result.stderr);
});

test('rejects tracked credential patterns without printing secret value', () => {
  const repo = createRepo();
  const secret = `sk-${'a'.repeat(32)}`;
  commit(repo, 'secret.txt', `${secret}\n`, 'secret');
  const result = run(repo);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /secret\.txt:1: OpenAI-style API key/);
  assert.doesNotMatch(result.stderr, new RegExp(secret));
});

test('rejects credentials removed from current tree but retained in history', () => {
  const repo = createRepo();
  commit(repo, 'config.txt', `AKIA${'A'.repeat(16)}\n`, 'add secret');
  commit(repo, 'config.txt', 'removed\n', 'remove secret');
  const result = run(repo);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Git history: AWS access key/);
});

test('current public repository passes secret scan', () => {
  const result = run(process.cwd());
  assert.equal(result.status, 0, result.stderr);
});
