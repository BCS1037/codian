#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

function parseArgs(argv) {
  const options = { repo: process.cwd(), json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--repo') {
      options.repo = path.resolve(argv[++index]);
    } else if (arg === '--json') {
      options.json = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return options;
}

function resolveImport(fromFile, specifier) {
  if (!specifier.startsWith('.')) {
    return null;
  }
  const base = path.resolve(path.dirname(fromFile), specifier);
  const candidates = [base, `${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts')];
  return candidates.find(candidate => fs.existsSync(candidate)) ?? `${base}.ts`;
}

function importMap(source, sourceFile) {
  const imports = new Map();
  const pattern = /import\s+(?:type\s+)?{([^}]+)}\s+from\s+['"]([^'"]+)['"]/g;
  for (const match of source.matchAll(pattern)) {
    const target = resolveImport(sourceFile, match[2]);
    for (const item of match[1].split(',')) {
      const [imported, alias] = item.trim().split(/\s+as\s+/);
      if (imported) {
        imports.set(alias ?? imported, target);
      }
    }
  }
  return imports;
}

function listFiles(root) {
  if (!fs.existsSync(root)) {
    return [];
  }
  return fs.readdirSync(root, { withFileTypes: true }).flatMap(entry => {
    const target = path.join(root, entry.name);
    return entry.isDirectory() ? listFiles(target) : [target];
  });
}

function flattenKeys(value, prefix = '') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return prefix ? [prefix] : [];
  }
  return Object.entries(value).flatMap(([key, child]) => {
    const next = prefix ? `${prefix}.${key}` : key;
    return flattenKeys(child, next);
  });
}

function inspectLocales(repo, errors) {
  const localeRoot = path.join(repo, 'src/i18n/locales');
  const localeFiles = listFiles(localeRoot).filter(file => file.endsWith('.json')).sort();
  const referenceFile = localeFiles.find(file => path.basename(file) === 'en.json');
  if (!referenceFile) {
    errors.push('missing reference locale src/i18n/locales/en.json');
    return false;
  }
  const referenceKeys = new Set(flattenKeys(JSON.parse(fs.readFileSync(referenceFile, 'utf8'))));
  for (const file of localeFiles) {
    const keys = new Set(flattenKeys(JSON.parse(fs.readFileSync(file, 'utf8'))));
    for (const key of referenceKeys) {
      if (!keys.has(key)) {
        errors.push(`${path.basename(file)}: missing locale key ${key}`);
      }
    }
    for (const key of keys) {
      if (!referenceKeys.has(key)) {
        errors.push(`${path.basename(file)}: unexpected locale key ${key}`);
      }
    }
  }
  return errors.length === 0;
}

export function inspectProviderInventory(repo) {
  const errors = [];
  const indexFile = path.join(repo, 'src/providers/index.ts');
  const indexSource = fs.readFileSync(indexFile, 'utf8');
  const defaultsSource = fs.readFileSync(path.join(repo, 'src/providers/defaultProviderConfigs.ts'), 'utf8');
  const indexImports = importMap(indexSource, indexFile);
  const catalog = indexSource.match(/BUILT_IN_PROVIDER_MODULES\s*=\s*\[([\s\S]*?)]/)?.[1] ?? '';
  const registrations = catalog
    .split(',')
    .map(symbol => symbol.trim())
    .filter(Boolean)
    .map(symbol => indexImports.get(symbol));
  const providers = [];

  for (const registrationFile of registrations) {
    if (!registrationFile || !fs.existsSync(registrationFile)) {
      errors.push(`missing provider registration ${registrationFile ?? 'unknown'}`);
      continue;
    }
    const source = fs.readFileSync(registrationFile, 'utf8');
    const id = source.match(/\bid:\s*['"]([^'"]+)['"]/)?.[1];
    if (!id) {
      errors.push(`${path.relative(repo, registrationFile)}: missing literal provider id`);
      continue;
    }
    const imports = importMap(source, registrationFile);
    const providerErrors = [];
    for (const field of ['capabilities', 'chatUIConfig', 'workspace']) {
      const symbol = source.match(new RegExp(`\\b${field}:\\s*([A-Za-z_$][\\w$]*)`))?.[1];
      if (!symbol) {
        providerErrors.push(`missing ${field} registration field`);
        continue;
      }
      const importedFile = imports.get(symbol);
      if (!importedFile || !fs.existsSync(importedFile)) {
        providerErrors.push(`missing imported file for ${field}: ${importedFile ?? symbol}`);
      }
    }
    if (!new RegExp(`\\b${id}\\s*:`).test(defaultsSource)) {
      providerErrors.push('missing default provider config');
    }
    const testRoot = path.join(repo, 'tests/unit/providers', id);
    const tests = listFiles(testRoot).filter(file => file.endsWith('.test.ts'));
    if (tests.length === 0) {
      providerErrors.push('missing provider tests');
    }
    errors.push(...providerErrors.map(error => `${id}: ${error}`));
    providers.push({
      id,
      registration: path.relative(repo, registrationFile),
      tests: tests.length,
      complete: providerErrors.length === 0,
    });
  }

  const localeErrorsBefore = errors.length;
  inspectLocales(repo, errors);
  return {
    schemaVersion: 1,
    providers,
    localeKeyParity: errors.length === localeErrorsBefore,
    errors,
    valid: errors.length === 0,
  };
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const report = inspectProviderInventory(options.repo);
  if (options.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else if (report.valid) {
    process.stdout.write(`Provider inventory valid: ${report.providers.length} providers\n`);
  }
  if (!report.valid) {
    process.stderr.write(`${report.errors.join('\n')}\n`);
    process.exitCode = 1;
  }
}

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main();
}
