#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { execFileSync } from 'node:child_process';

const PATTERNS = [
  { label: 'OpenAI-style API key', regex: /(?:^|[^A-Za-z0-9])sk-[A-Za-z0-9_-]{20,}/ },
  { label: 'AWS access key', regex: /AKIA[0-9A-Z]{16}/ },
  { label: 'GitHub token', regex: /gh[pousr]_[A-Za-z0-9_]{20,}/ },
  { label: 'Google API key', regex: /AIza[0-9A-Za-z_-]{35}/ },
  { label: 'private key block', regex: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
];

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

function git(repo, args) {
  return execFileSync('git', ['-C', repo, ...args], {
    encoding: 'utf8',
    maxBuffer: 128 * 1024 * 1024,
  });
}

function matchingLabel(text) {
  return PATTERNS.find(pattern => pattern.regex.test(text))?.label ?? null;
}

export function inspectSecrets(repo) {
  const errors = [];
  const files = git(repo, ['ls-files', '--cached', '--others', '--exclude-standard', '-z'])
    .split('\0')
    .filter(Boolean);

  for (const relativeFile of files) {
    const file = path.join(repo, relativeFile);
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) continue;
    const buffer = fs.readFileSync(file);
    if (buffer.includes(0)) continue;
    const lines = buffer.toString('utf8').split('\n');
    lines.forEach((line, index) => {
      const label = matchingLabel(line);
      if (label) errors.push(`${relativeFile}:${index + 1}: ${label}`);
    });
  }

  const history = git(repo, ['log', '-p', '--all', '--no-ext-diff', '--text', '--format=']);
  for (const pattern of PATTERNS) {
    if (pattern.regex.test(history)) {
      errors.push(`Git history: ${pattern.label}`);
    }
  }

  return {
    schemaVersion: 1,
    scannedFiles: files.length,
    scannedHistory: true,
    findings: errors,
    valid: errors.length === 0,
  };
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const report = inspectSecrets(options.repo);
  if (options.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else if (report.valid) {
    process.stdout.write(`Secret scan valid: ${report.scannedFiles} files and Git history\n`);
  }
  if (!report.valid) {
    process.stderr.write(`${report.findings.join('\n')}\n`);
    process.exitCode = 1;
  }
}

main();
