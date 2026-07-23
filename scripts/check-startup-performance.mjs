#!/usr/bin/env node

import { existsSync, readFileSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mainPath = path.join(root, 'main.js');
const requiredArtifacts = ['main.js', 'manifest.json', 'styles.css'];

export function parsePerformanceThreshold(rawValue, fallback, label) {
  const value = rawValue === undefined ? fallback : Number(rawValue);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${label} must be a positive number.`);
  }
  return value;
}

export function evaluatePerformanceBudget(medianMs, indicatorMs, budgetMs) {
  return {
    warning: medianMs > indicatorMs,
    exceeded: medianMs > budgetMs,
  };
}

function main() {
  const evaluationIndicatorMs = parsePerformanceThreshold(
    process.env.CODIAN_STARTUP_INDICATOR_MS,
    50,
    'CODIAN_STARTUP_INDICATOR_MS',
  );
  const evaluationBudgetMs = parsePerformanceThreshold(
    process.env.CODIAN_STARTUP_BUDGET_MS,
    150,
    'CODIAN_STARTUP_BUDGET_MS',
  );
  if (evaluationBudgetMs < evaluationIndicatorMs) {
    throw new Error('CODIAN_STARTUP_BUDGET_MS must be greater than or equal to CODIAN_STARTUP_INDICATOR_MS.');
  }

  for (const relativePath of requiredArtifacts) {
    const artifactPath = path.join(root, relativePath);
    if (!existsSync(artifactPath)) {
      throw new Error(`Missing production artifact: ${relativePath}`);
    }
    if (relativePath.endsWith('.js')) {
      const syntaxCheck = spawnSync(process.execPath, ['--check', artifactPath], {
        cwd: root,
        encoding: 'utf8',
      });
      if (syntaxCheck.status !== 0) {
        throw new Error(`Invalid production artifact ${relativePath}: ${syntaxCheck.stderr}`);
      }
    }
  }

  const mainContents = readFileSync(mainPath, 'utf8');
  const unsupportedChunkReferences = [
    './chunks/providers/',
    './chunks/locales/',
    './chunks/optional/',
  ].filter(reference => mainContents.includes(reference));
  if (unsupportedChunkReferences.length > 0) {
    throw new Error(
      `main.js depends on files the Obsidian installer does not fetch: ${unsupportedChunkReferences.join(', ')}`,
    );
  }

  const mainBytes = statSync(mainPath).size;
  const childScript = String.raw`
const Module = require('node:module');
const { performance } = require('node:perf_hooks');
const mainPath = process.argv[1];
let universal;
universal = new Proxy(function () { return universal; }, {
  construct() { return {}; },
  get(_target, property) {
    if (property === 'isWin' || property === 'isMacOS' || property === 'isLinux') return false;
    if (property === 'then') return undefined;
    return universal;
  },
});
const obsidian = new Proxy({}, {
  get(_target, property) {
    if (property === 'Platform') return { isWin: false, isMacOS: true, isLinux: false };
    if (property === 'normalizePath') return value => value;
    if (property === 'setIcon') return () => {};
    return universal;
  },
});
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'obsidian') return obsidian;
  if (request === 'electron') return { shell: universal };
  return originalLoad.call(this, request, parent, isMain);
};
const startedAt = performance.now();
require(mainPath);
process.stdout.write(String(performance.now() - startedAt));
`;

  const samples = [];
  for (let index = 0; index < 7; index += 1) {
    const result = spawnSync(process.execPath, ['-e', childScript, mainPath], {
      cwd: root,
      encoding: 'utf8',
    });
    if (result.status !== 0) {
      throw new Error(`Module evaluation harness failed: ${result.stderr || result.stdout}`);
    }
    const sample = Number(result.stdout.trim());
    if (!Number.isFinite(sample)) {
      throw new Error(`Module evaluation harness returned an invalid duration: ${JSON.stringify(result.stdout)}`);
    }
    samples.push(sample);
  }
  samples.sort((left, right) => left - right);
  const medianMs = samples[Math.floor(samples.length / 2)];

  console.log(`main.js ${(mainBytes / 1024 / 1024).toFixed(2)} MiB; median cold evaluation ${medianMs.toFixed(1)} ms`);
  const budget = evaluatePerformanceBudget(medianMs, evaluationIndicatorMs, evaluationBudgetMs);
  if (budget.warning) {
    console.warn(
      `Performance warning: median cold module evaluation is ${medianMs.toFixed(1)} ms; indicator is ${evaluationIndicatorMs} ms.`,
    );
  }
  if (budget.exceeded) {
    throw new Error(
      `Performance budget exceeded: ${medianMs.toFixed(1)} ms is above ${evaluationBudgetMs} ms.`,
    );
  }
}

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main();
}
