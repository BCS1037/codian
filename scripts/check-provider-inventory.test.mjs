import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const script = path.resolve('scripts/check-provider-inventory.mjs');

function write(root, relativePath, contents) {
  const target = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, contents);
}

function createFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codian-provider-inventory-'));
  write(root, 'src/providers/index.ts', "import { alphaProviderRegistration } from './alpha/registration';\nexport const BUILT_IN_PROVIDER_MODULES = [alphaProviderRegistration];\n");
  write(root, 'src/providers/defaultProviderConfigs.ts', "export const defaults = { alpha: {} };\n");
  write(root, 'src/providers/alpha/registration.ts', [
    "import { ALPHA_CAPABILITIES } from './capabilities';",
    "import { alphaWorkspace } from './app/AlphaWorkspaceServices';",
    "import { alphaChatUIConfig } from './ui/AlphaChatUIConfig';",
    'export const alphaProviderRegistration = {',
    "  id: 'alpha',",
    '  capabilities: ALPHA_CAPABILITIES,',
    '  chatUIConfig: alphaChatUIConfig,',
    '  workspace: alphaWorkspace,',
    '};',
  ].join('\n'));
  write(root, 'src/providers/alpha/capabilities.ts', "export const ALPHA_CAPABILITIES = { providerId: 'alpha' };\n");
  write(root, 'src/providers/alpha/app/AlphaWorkspaceServices.ts', 'export const alphaWorkspace = {};\n');
  write(root, 'src/providers/alpha/ui/AlphaChatUIConfig.ts', 'export const alphaChatUIConfig = {};\n');
  write(root, 'tests/unit/providers/alpha/registration.test.ts', 'export {};\n');
  write(root, 'src/i18n/locales/en.json', '{"settings":{"title":"Settings"}}\n');
  write(root, 'src/i18n/locales/zh-CN.json', '{"settings":{"title":"设置"}}\n');
  return root;
}

function run(root) {
  return spawnSync(process.execPath, [script, '--repo', root, '--json'], { encoding: 'utf8' });
}

test('accepts complete provider registration inventory', () => {
  const root = createFixture();
  const result = run(root);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.deepEqual(report.providers.map(provider => provider.id), ['alpha']);
  assert.equal(report.localeKeyParity, true);
});

test('rejects missing provider capabilities and test coverage', () => {
  const root = createFixture();
  fs.rmSync(path.join(root, 'src/providers/alpha/capabilities.ts'));
  fs.rmSync(path.join(root, 'tests/unit/providers/alpha'), { recursive: true });
  const result = run(root);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /alpha: missing imported file .*capabilities/);
  assert.match(result.stderr, /alpha: missing provider tests/);
});

test('rejects locale key drift', () => {
  const root = createFixture();
  write(root, 'src/i18n/locales/zh-CN.json', '{"settings":{}}\n');
  const result = run(root);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /zh-CN\.json: missing locale key settings\.title/);
});

test('current repository satisfies provider inventory', () => {
  const result = run(process.cwd());
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.deepEqual(report.providers.map(provider => provider.id), [
    'claude',
    'codex',
    'grok',
    'opencode',
    'kimi',
    'pi',
  ]);
});
