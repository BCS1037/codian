import '@/providers';

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  getOrderedProviderIds,
  getProviderCardMetadata,
  getProviderCardModelState,
  getSettingsTabIds,
} from '@/features/settings/ClaudianSettings';
import { setLocale } from '@/i18n/i18n';

describe('settings tab order', () => {
  it('groups provider-owned settings under shared top-level categories', () => {
    expect(getSettingsTabIds(['claude', 'codex', 'opencode', 'pi'])).toEqual([
      'general',
      'providers',
      'workspace',
    ]);
  });

  it('orders native ACP providers between OpenCode and Claude', () => {
    expect(getOrderedProviderIds(['pi', 'kimi', 'claude', 'grok', 'opencode', 'codex'])).toEqual([
      'codex',
      'opencode',
      'grok',
      'kimi',
      'claude',
      'pi',
    ]);
  });
});

describe('settings provider layout', () => {
  afterEach(() => {
    setLocale('en');
  });

  it('describes Kimi models through its discovered visible catalog', () => {
    expect(getProviderCardModelState('kimi', {})).toEqual({
      count: 0,
      kind: 'visible-models',
    });
    expect(getProviderCardModelState('kimi', {
      providerConfigs: {
        kimi: {
          discoveredModels: [{ label: 'Kimi K2.5', rawId: 'kimi-k2.5' }],
          visibleModels: ['kimi-k2.5'],
        },
      },
    })).toEqual({
      count: 1,
      kind: 'visible-models',
    });
  });

  it('describes Grok through its discovered visible-model catalog', () => {
    expect(getProviderCardModelState('grok', {})).toEqual({
      count: 0,
      kind: 'visible-models',
    });
  });

  it('preserves Claude manual model management as a distinct provider capability', () => {
    expect(getProviderCardModelState('claude', {})).toEqual({
      count: expect.any(Number),
      kind: 'manual-models',
    });
  });

  it('shows model count without repeating healthy CLI status', () => {
    setLocale('zh-CN');

    expect(getProviderCardMetadata({ kind: 'visible-models', count: 3 }, true)).toBe('3 个模型');
    expect(getProviderCardMetadata({ kind: 'cli-managed' }, true)).toBe('模型由 CLI 管理');
  });

  it('keeps missing CLI visible as an actionable exception', () => {
    setLocale('zh-CN');

    expect(getProviderCardMetadata({ kind: 'visible-models', count: 3 }, false)).toBe('未检测到 CLI');
  });

  it('vertically centers default provider content inside its pill', () => {
    const css = readFileSync(resolve('src/style/settings/base.css'), 'utf8');
    const rule = css.match(/\.claudian-settings-default-provider\s*\{([^}]*)\}/)?.[1];

    expect(rule).toContain('align-items: center;');
  });

  it('uses compact provider cards that can form three columns in the settings viewport', () => {
    const css = readFileSync(resolve('src/style/settings/base.css'), 'utf8');
    const gridRule = css.match(/\.claudian-settings-provider-grid\s*\{([^}]*)\}/)?.[1];
    const cardRule = css.match(/\.claudian-settings-provider-card\s*\{([^}]*)\}/)?.[1];

    expect(gridRule).toContain('minmax(180px, 1fr)');
    expect(cardRule).toContain('min-height: 92px;');
    expect(cardRule).toContain('padding: 12px;');
  });
});
