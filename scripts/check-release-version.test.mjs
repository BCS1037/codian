import assert from 'node:assert/strict';
import test from 'node:test';

import { validateReleaseVersions } from './check-release-version.mjs';

test('accepts matching release metadata across every version source', () => {
  assert.doesNotThrow(() => validateReleaseVersions({
    tag: '2.0.31',
    packageVersion: '2.0.31',
    packageLockVersion: '2.0.31',
    packageLockRootVersion: '2.0.31',
    manifestVersion: '2.0.31',
    manifestMinAppVersion: '1.11.4',
    versions: { '2.0.31': '1.11.4' },
  }));
});

test('rejects version mismatches', () => {
  assert.throws(() => validateReleaseVersions({
    tag: '2.0.32',
    packageVersion: '2.0.31',
    packageLockVersion: '2.0.31',
    packageLockRootVersion: '2.0.31',
    manifestVersion: '2.0.31',
    manifestMinAppVersion: '1.11.4',
    versions: { '2.0.31': '1.11.4' },
  }), /Release version mismatch/);
});

test('rejects package-lock version drift', () => {
  assert.throws(() => validateReleaseVersions({
    tag: '2.0.31',
    packageVersion: '2.0.31',
    packageLockVersion: '2.0.30',
    packageLockRootVersion: '2.0.31',
    manifestVersion: '2.0.31',
    manifestMinAppVersion: '1.11.4',
    versions: { '2.0.31': '1.11.4' },
  }), /Release version mismatch/);
});

test('rejects missing or inconsistent versions.json entries', () => {
  for (const versions of [{}, { '2.0.31': '1.10.0' }]) {
    assert.throws(() => validateReleaseVersions({
      tag: '2.0.31',
      packageVersion: '2.0.31',
      packageLockVersion: '2.0.31',
      packageLockRootVersion: '2.0.31',
      manifestVersion: '2.0.31',
      manifestMinAppVersion: '1.11.4',
      versions,
    }), /versions\.json mismatch/);
  }
});

test('rejects malformed or missing release tags', () => {
  for (const tag of [undefined, '', 'v2.0.31', 'refs/tags/2.0.31']) {
    assert.throws(() => validateReleaseVersions({
      tag,
      packageVersion: '2.0.31',
      packageLockVersion: '2.0.31',
      packageLockRootVersion: '2.0.31',
      manifestVersion: '2.0.31',
      manifestMinAppVersion: '1.11.4',
      versions: { '2.0.31': '1.11.4' },
    }), /Invalid or missing release tag/);
  }
});
