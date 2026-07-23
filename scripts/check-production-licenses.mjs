#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const PROHIBITED = /\b(?:AGPL|GPL|SSPL|BUSL)(?:-|\b)/i;

function parseArgs(argv) {
  const options = { repo: process.cwd(), json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--repo') options.repo = path.resolve(argv[++index]);
    else if (arg === '--json') options.json = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function packageName(packagePath, metadata) {
  return metadata.name ?? packagePath.replace(/^.*node_modules\//, '');
}

export function inspectProductionLicenses(repo) {
  const lock = JSON.parse(fs.readFileSync(path.join(repo, 'package-lock.json'), 'utf8'));
  const noticesFile = path.join(repo, 'THIRD_PARTY_NOTICES.md');
  const notices = fs.existsSync(noticesFile) ? fs.readFileSync(noticesFile, 'utf8') : '';
  const errors = [];
  const inventory = [];

  for (const [packagePath, metadata] of Object.entries(lock.packages ?? {})) {
    if (!packagePath || metadata.dev) continue;
    const name = packageName(packagePath, metadata);
    const license = typeof metadata.license === 'string' ? metadata.license.trim() : '';
    inventory.push({ name, version: metadata.version ?? null, license: license || null });
    if (!license) {
      errors.push(`${name}: missing license metadata`);
    } else if (PROHIBITED.test(license)) {
      errors.push(`${name}: prohibited license ${license}`);
    } else if (/^SEE LICENSE IN /i.test(license) && !notices.includes(name)) {
      errors.push(`${name}: special license is absent from THIRD_PARTY_NOTICES.md`);
    }
  }

  inventory.sort((left, right) => left.name.localeCompare(right.name));
  return {
    schemaVersion: 1,
    productionPackages: inventory.length,
    inventory,
    errors,
    valid: errors.length === 0,
  };
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const report = inspectProductionLicenses(options.repo);
  if (options.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else if (report.valid) {
    process.stdout.write(`Production license inventory valid: ${report.productionPackages} packages\n`);
  }
  if (!report.valid) {
    process.stderr.write(`${report.errors.join('\n')}\n`);
    process.exitCode = 1;
  }
}

main();
