import assert from 'node:assert/strict';
import test from 'node:test';

import { extractReleaseNotes } from './generate-release-notes.mjs';

const changelog = `# Changelog

## 1.2.0 — 2026-07-27

### Added

- Current release.

## 1.1.4 — 2026-07-27

- Older release.
`;

test('extracts only requested release section', () => {
  assert.equal(
    extractReleaseNotes(changelog, '1.2.0'),
    '### Added\n\n- Current release.\n',
  );
});

test('rejects missing release section', () => {
  assert.throws(
    () => extractReleaseNotes(changelog, '1.2.1'),
    /Missing changelog entry for release 1.2.1/,
  );
});
