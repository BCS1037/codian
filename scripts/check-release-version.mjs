#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function validateReleaseVersions({
  tag,
  packageVersion,
  packageLockVersion,
  packageLockRootVersion,
  manifestVersion,
  manifestMinAppVersion,
  versions,
}) {
  if (typeof tag !== 'string' || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(tag)) {
    throw new Error(`Invalid or missing release tag: ${JSON.stringify(tag)}`);
  }
  if (
    tag !== packageVersion
    || tag !== packageLockVersion
    || tag !== packageLockRootVersion
    || tag !== manifestVersion
  ) {
    throw new Error(
      'Release version mismatch: '
      + `tag=${tag}, package.json=${packageVersion}, package-lock.json=${packageLockVersion}, `
      + `package-lock root=${packageLockRootVersion}, manifest.json=${manifestVersion}`,
    );
  }
  if (versions?.[tag] !== manifestMinAppVersion) {
    throw new Error(
      `versions.json mismatch: ${tag}=${JSON.stringify(versions?.[tag])}, `
      + `manifest minAppVersion=${manifestMinAppVersion}`,
    );
  }
}

function run() {
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const rootDir = path.resolve(scriptDir, '..');
  const packageJson = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8'));
  const packageLockJson = JSON.parse(
    fs.readFileSync(path.join(rootDir, 'package-lock.json'), 'utf8'),
  );
  const manifestJson = JSON.parse(fs.readFileSync(path.join(rootDir, 'manifest.json'), 'utf8'));
  const versionsJson = JSON.parse(fs.readFileSync(path.join(rootDir, 'versions.json'), 'utf8'));
  validateReleaseVersions({
    tag: process.argv[2],
    packageVersion: packageJson.version,
    packageLockVersion: packageLockJson.version,
    packageLockRootVersion: packageLockJson.packages?.['']?.version,
    manifestVersion: manifestJson.version,
    manifestMinAppVersion: manifestJson.minAppVersion,
    versions: versionsJson,
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    run();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
