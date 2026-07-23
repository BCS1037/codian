import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import test from 'node:test';

function listTypeScriptFiles(root) {
  const files = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...listTypeScriptFiles(entryPath));
    else if (entry.isFile() && entry.name.endsWith('.ts')) files.push(entryPath);
  }
  return files;
}

function findMatches(roots, pattern) {
  const matches = [];
  for (const root of roots) {
    for (const file of listTypeScriptFiles(root)) {
      if (pattern.test(fs.readFileSync(file, 'utf8'))) {
        matches.push(path.relative(process.cwd(), file));
      }
    }
  }
  return matches;
}

function listImportSpecifiers(contents) {
  const specifiers = [];
  const pattern = /(?:from\s+|import\s*\()\s*['"]([^'"]+)['"]/g;
  for (const match of contents.matchAll(pattern)) specifiers.push(match[1]);
  return specifiers;
}

function resolveSourceImport(file, specifier) {
  if (specifier.startsWith('@/')) {
    return path.join(process.cwd(), 'src', specifier.slice(2));
  }
  if (specifier.startsWith('.')) {
    return path.resolve(path.dirname(file), specifier);
  }
  return null;
}

function isWithin(root, candidate) {
  if (candidate === null) return false;
  const relative = path.relative(root, candidate);
  return relative !== '' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function findImportsWithin(roots, forbiddenRoot) {
  const matches = [];
  for (const root of roots) {
    for (const file of listTypeScriptFiles(root)) {
      const specifiers = listImportSpecifiers(fs.readFileSync(file, 'utf8'));
      if (specifiers.some(specifier => (
        isWithin(forbiddenRoot, resolveSourceImport(file, specifier))
      ))) {
        matches.push(path.relative(process.cwd(), file));
      }
    }
  }
  return matches;
}

const sourceRoot = path.join(process.cwd(), 'src');
const concreteProvidersRoot = path.join(sourceRoot, 'providers');

test('provider boundary guard covers every provider directory', () => {
  const providerDirectories = fs.readdirSync(concreteProvidersRoot, {
    withFileTypes: true,
  })
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)
    .sort();

  const uncoveredProviders = providerDirectories.filter(providerId => (
    !isWithin(
      concreteProvidersRoot,
      resolveSourceImport(
        path.join(sourceRoot, 'features', 'FeatureHost.ts'),
        `@/providers/${providerId}/runtime`,
      ),
    )
  ));

  assert.deepEqual(uncoveredProviders, []);
});

test('core is independent from main, features, and concrete providers', () => {
  const coreRoot = path.join(sourceRoot, 'core');
  const pattern = /from\s+['"][^'"]*(?:main['"]|features\/)/;
  assert.deepEqual(findMatches([coreRoot], pattern), []);
  assert.deepEqual(findImportsWithin([coreRoot], concreteProvidersRoot), []);
});

test('providers are independent from main and features', () => {
  const pattern = /from\s+['"][^'"]*(?:main['"]|features\/)/;
  assert.deepEqual(findMatches([path.join(sourceRoot, 'providers')], pattern), []);
});

test('features are independent from the composition root and app adapters', () => {
  const pattern = /from\s+['"][^'"]*(?:main['"]|app\/)/;
  assert.deepEqual(findMatches([path.join(sourceRoot, 'features')], pattern), []);
});

test('features and shared UI are independent from concrete providers', () => {
  assert.deepEqual(findImportsWithin([
    path.join(sourceRoot, 'features'),
    path.join(sourceRoot, 'shared'),
  ], concreteProvidersRoot), []);
});

test('persisted settings changes use the coordinator boundary', () => {
  const matches = findMatches([sourceRoot], /\.saveSettings\(\)/).filter(file => ![
    'src/main.ts',
    'src/app/providers/ClaudianProviderHost.ts',
  ].includes(file));
  assert.deepEqual(matches, []);
});
