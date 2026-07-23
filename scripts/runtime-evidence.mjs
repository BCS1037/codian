#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { execFileSync } from 'node:child_process';

const REQUIRED_SCENARIOS = {
  'provider-e2e': ['authentication', 'request', 'streaming', 'tool', 'resume', 'switching', 'rollback'],
  'runtime-smoke': ['reload', 'errors', 'console', 'dom', 'interaction'],
};

const REQUIRED_ASSETS = ['main.js', 'manifest.json', 'styles.css'];

function parseArgs(argv) {
  const options = { repo: process.cwd(), generatedAt: new Date().toISOString() };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--repo') {
      options.repo = path.resolve(argv[++index]);
    } else if (arg === '--input') {
      options.input = path.resolve(argv[++index]);
    } else if (arg === '--output') {
      options.output = path.resolve(argv[++index]);
    } else if (arg === '--generated-at') {
      options.generatedAt = argv[++index];
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!options.input || !options.output) {
    throw new Error('Usage: runtime-evidence.mjs --input <json> --output <json> [--repo <path>]');
  }
  return options;
}

function git(repo, args) {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function validateInput(input) {
  const errors = [];
  if (!Object.hasOwn(REQUIRED_SCENARIOS, input.kind)) {
    errors.push(`unsupported evidence kind: ${input.kind ?? 'missing'}`);
  }
  if (typeof input.provider !== 'string' || !input.provider.trim()) {
    errors.push('missing provider');
  }
  if (!/^L[0-5]$/.test(input.evidenceLevel ?? '')) {
    errors.push(`invalid evidence level: ${input.evidenceLevel ?? 'missing'}`);
  }
  if (typeof input.cli?.path !== 'string' || typeof input.cli?.version !== 'string') {
    errors.push('missing CLI path or version');
  }
  if (typeof input.vault !== 'string' || !input.vault.trim()) {
    errors.push('missing vault');
  }
  if (!Array.isArray(input.scenarios)) {
    errors.push('missing scenarios');
  }
  if (!Array.isArray(input.assets)) {
    errors.push('missing assets');
  }
  return errors;
}

export function createRuntimeEvidence({ repo, input, generatedAt }) {
  const errors = validateInput(input);
  const passedScenarios = new Set(
    Array.isArray(input.scenarios)
      ? input.scenarios.filter(item => item?.result === 'pass' && item?.evidence).map(item => item.name)
      : [],
  );
  for (const name of REQUIRED_SCENARIOS[input.kind] ?? []) {
    if (!passedScenarios.has(name)) {
      errors.push(`missing passing scenario: ${name}`);
    }
  }

  const assetPaths = Array.isArray(input.assets) ? input.assets : [];
  if (input.kind === 'runtime-smoke') {
    const assetNames = new Set(assetPaths.map(asset => path.basename(asset)));
    for (const name of REQUIRED_ASSETS) {
      if (!assetNames.has(name)) {
        errors.push(`missing required asset: ${name}`);
      }
    }
  }

  const assets = [];
  for (const asset of assetPaths) {
    const file = path.isAbsolute(asset) ? asset : path.resolve(repo, asset);
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
      errors.push(`asset not found: ${asset}`);
      continue;
    }
    assets.push({
      path: path.isAbsolute(asset) ? file : path.relative(repo, file),
      sha256: sha256(file),
      bytes: fs.statSync(file).size,
    });
  }

  let commit = null;
  let dirty = null;
  try {
    commit = git(repo, ['rev-parse', 'HEAD']);
    dirty = git(repo, ['status', '--porcelain']).length > 0;
  } catch {
    errors.push('repository has no readable Git commit');
  }

  return {
    schemaVersion: 1,
    generatedAt,
    status: errors.length === 0 ? 'passed' : 'incomplete',
    commit,
    dirty,
    kind: input.kind ?? null,
    provider: input.provider ?? null,
    evidenceLevel: input.evidenceLevel ?? null,
    cli: input.cli ?? null,
    vault: input.vault ?? null,
    scenarios: Array.isArray(input.scenarios) ? input.scenarios : [],
    assets,
    errors,
  };
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const input = JSON.parse(fs.readFileSync(options.input, 'utf8'));
  const report = createRuntimeEvidence({ repo: options.repo, input, generatedAt: options.generatedAt });
  fs.mkdirSync(path.dirname(options.output), { recursive: true });
  fs.writeFileSync(options.output, `${JSON.stringify(report, null, 2)}\n`);
  if (report.status !== 'passed') {
    process.stderr.write(`${report.errors.join('\n')}\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write(`${options.output}\n`);
  }
}

main();
