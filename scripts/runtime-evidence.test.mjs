import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const script = path.resolve('scripts/runtime-evidence.mjs');

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function createRepo() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'codian-runtime-evidence-'));
  fs.writeFileSync(path.join(repo, 'main.js'), 'runtime');
  fs.writeFileSync(path.join(repo, 'manifest.json'), '{}');
  fs.writeFileSync(path.join(repo, 'styles.css'), 'styles');
  spawnSync('git', ['init', '-q'], { cwd: repo });
  spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo });
  spawnSync('git', ['config', 'user.name', 'Test'], { cwd: repo });
  spawnSync('git', ['add', '.'], { cwd: repo });
  spawnSync('git', ['commit', '-qm', 'fixture'], { cwd: repo });
  return repo;
}

function scenario(name) {
  return { name, result: 'pass', evidence: `${name} verified` };
}

function run(repo, input) {
  const inputFile = path.join(repo, 'input.json');
  const outputFile = path.join(repo, 'evidence.json');
  writeJson(inputFile, input);
  const result = spawnSync(process.execPath, [
    script,
    '--repo', repo,
    '--input', inputFile,
    '--output', outputFile,
    '--generated-at', '2026-07-23T00:00:00.000Z',
  ], { encoding: 'utf8' });
  return { result, outputFile };
}

test('creates validated runtime-smoke evidence with artifact hashes', () => {
  const repo = createRepo();
  const { result, outputFile } = run(repo, {
    kind: 'runtime-smoke',
    provider: 'codex',
    evidenceLevel: 'L5',
    cli: { path: '/usr/local/bin/codex', version: '1.2.3' },
    vault: '/tmp/test-vault',
    scenarios: ['reload', 'errors', 'console', 'dom', 'interaction'].map(scenario),
    assets: ['main.js', 'manifest.json', 'styles.css'],
  });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(fs.readFileSync(outputFile, 'utf8'));
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.status, 'passed');
  assert.equal(report.generatedAt, '2026-07-23T00:00:00.000Z');
  assert.match(report.commit, /^[0-9a-f]{40}$/);
  assert.equal(report.assets.length, 3);
  assert.match(report.assets[0].sha256, /^[0-9a-f]{64}$/);
});

test('rejects incomplete provider L4 evidence', () => {
  const repo = createRepo();
  const { result } = run(repo, {
    kind: 'provider-e2e',
    provider: 'claude',
    evidenceLevel: 'L4',
    cli: { path: '/usr/local/bin/claude', version: '1.2.3' },
    vault: '/tmp/test-vault',
    scenarios: ['authentication', 'request'].map(scenario),
    assets: [],
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /missing passing scenario: streaming/);
  assert.match(result.stderr, /missing passing scenario: rollback/);
});

test('rejects runtime-smoke evidence without required assets', () => {
  const repo = createRepo();
  const { result } = run(repo, {
    kind: 'runtime-smoke',
    provider: 'codex',
    evidenceLevel: 'L5',
    cli: { path: '/usr/local/bin/codex', version: '1.2.3' },
    vault: '/tmp/test-vault',
    scenarios: ['reload', 'errors', 'console', 'dom', 'interaction'].map(scenario),
    assets: ['main.js'],
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /missing required asset: manifest\.json/);
  assert.match(result.stderr, /missing required asset: styles\.css/);
});
