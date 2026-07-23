#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

function parseArgs(argv) {
  const options = { repo: process.cwd(), json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--json') {
      options.json = true;
      continue;
    }
    if (['--repo', '--from', '--to'].includes(argument)) {
      const value = argv[index + 1];
      if (!value) throw new Error(`Missing value for ${argument}`);
      options[argument.slice(2)] = value;
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${argument}`);
  }
  if (!options.from || !options.to) {
    throw new Error('Usage: upstream-audit.mjs --from <ref> --to <ref> [--repo <path>] [--json]');
  }
  return options;
}

function git(repo, args) {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
}

function resolveRef(repo, ref) {
  return git(repo, ['rev-parse', `${ref}^{}`]);
}

function listCommits(repo, from, to) {
  const output = git(repo, ['log', '--reverse', '--format=%H%x09%s', `${from}..${to}`]);
  if (!output) return [];
  return output.split('\n').map(line => {
    const separator = line.indexOf('\t');
    return {
      commit: line.slice(0, separator),
      subject: line.slice(separator + 1),
    };
  });
}

function listChangedFiles(repo, from, to) {
  const output = git(repo, ['diff', '--name-status', '--no-renames', from, to]);
  if (!output) return [];
  return output.split('\n').map(line => {
    const [status, ...pathParts] = line.split('\t');
    const relativePath = pathParts.join('\t');
    return {
      status,
      path: relativePath,
      existsInWorkingTree: fs.existsSync(path.join(repo, relativePath)),
    };
  });
}

function buildReport({ repo, from, to }) {
  const commits = listCommits(repo, from, to);
  const changedFiles = listChangedFiles(repo, from, to);
  return {
    generatedAt: new Date().toISOString(),
    repository: path.resolve(repo),
    from: { ref: from, commit: resolveRef(repo, from) },
    to: { ref: to, commit: resolveRef(repo, to) },
    commitCount: commits.length,
    changedFileCount: changedFiles.length,
    overlappingWorkingTreeFileCount: changedFiles.filter(file => file.existsInWorkingTree).length,
    commits,
    changedFiles,
  };
}

function formatText(report) {
  const lines = [
    `Upstream audit: ${report.from.ref} -> ${report.to.ref}`,
    `Commits: ${report.commitCount}`,
    `Changed files: ${report.changedFileCount}`,
    `Paths present in Codian: ${report.overlappingWorkingTreeFileCount}`,
    '',
    'Commits:',
    ...report.commits.map(item => `- ${item.commit.slice(0, 8)} ${item.subject}`),
    '',
    'Changed files:',
    ...report.changedFiles.map(file => (
      `- ${file.status} ${file.path}${file.existsInWorkingTree ? ' [Codian overlap]' : ''}`
    )),
  ];
  return `${lines.join('\n')}\n`;
}

try {
  const options = parseArgs(process.argv.slice(2));
  const report = buildReport(options);
  process.stdout.write(options.json
    ? `${JSON.stringify(report, null, 2)}\n`
    : formatText(report));
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
