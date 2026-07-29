#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function extractReleaseNotes(changelog, version) {
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error(`Invalid or missing release version: ${JSON.stringify(version)}`);
  }

  const heading = `## ${version}`;
  const start = changelog.indexOf(heading);
  if (start === -1 || !/^## \d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?(?:\s|$)/m.test(changelog.slice(start))) {
    throw new Error(`Missing changelog entry for release ${version}`);
  }

  const nextHeading = changelog.indexOf('\n## ', start + heading.length);
  const section = changelog.slice(start, nextHeading === -1 ? changelog.length : nextHeading);
  const bodyStart = section.indexOf('\n');
  return `${section.slice(bodyStart + 1).trim()}\n`;
}

function run() {
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const changelog = fs.readFileSync(path.join(scriptDir, '..', 'CHANGELOG.md'), 'utf8');
  process.stdout.write(extractReleaseNotes(changelog, process.argv[2]));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    run();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
