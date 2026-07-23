import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const script = path.resolve('scripts/check-production-licenses.mjs');

function run(packages, notices = '') {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'codian-license-check-'));
  fs.writeFileSync(path.join(repo, 'package-lock.json'), JSON.stringify({
    lockfileVersion: 3,
    packages: { '': { name: 'fixture', version: '1.0.0' }, ...packages },
  }));
  fs.writeFileSync(path.join(repo, 'THIRD_PARTY_NOTICES.md'), notices);
  return spawnSync(process.execPath, [script, '--repo', repo, '--json'], { encoding: 'utf8' });
}

test('accepts permissive production licenses', () => {
  const result = run({
    'node_modules/alpha': { version: '1.0.0', license: 'MIT' },
    'node_modules/dev-only': { version: '1.0.0', license: 'GPL-3.0', dev: true },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).productionPackages, 1);
});

test('rejects missing and prohibited production licenses', () => {
  const result = run({
    'node_modules/missing': { version: '1.0.0' },
    'node_modules/copyleft': { version: '1.0.0', license: 'AGPL-3.0' },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /missing: missing license metadata/);
  assert.match(result.stderr, /copyleft: prohibited license AGPL-3\.0/);
});

test('requires special license packages in third-party notices', () => {
  const missing = run({
    'node_modules/vendor-sdk': { version: '1.0.0', license: 'SEE LICENSE IN LICENSE.md' },
  });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /vendor-sdk: special license is absent from THIRD_PARTY_NOTICES\.md/);

  const present = run({
    'node_modules/vendor-sdk': { version: '1.0.0', license: 'SEE LICENSE IN LICENSE.md' },
  }, '# Notices\n\n## vendor-sdk\n');
  assert.equal(present.status, 0, present.stderr);
});

test('current production dependency inventory passes', () => {
  const result = spawnSync(process.execPath, [script, '--repo', process.cwd(), '--json'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).valid, true);
});
