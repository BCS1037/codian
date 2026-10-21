import '@/providers';

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { Notice } from 'obsidian';

import { ProviderWorkspaceRegistry } from '@/core/providers/ProviderWorkspaceRegistry';
import {
  CodianSettingTab,
  getOrderedProviderIds,
  getProviderCardMetadata,
  getProviderCardModelState,
  getSettingsTabIds,
} from '@/features/settings/CodianSettings';
import { setLocale } from '@/i18n/i18n';

import { createMockEl } from '../../../helpers/mockElement';

describe('settings tab order', () => {
  it('groups provider-owned settings under shared top-level categories', () => {
    expect(getSettingsTabIds(['claude', 'codex', 'opencode', 'pi'])).toEqual([
      'general',
      'providers',
      'workspace',
      'about',
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

  it('counts only configured Claude models on the provider card', () => {
    expect(getProviderCardModelState('claude', {})).toEqual({
      count: 0,
      kind: 'manual-models',
    });
    expect(getProviderCardModelState('claude', {
      providerConfigs: {
        claude: {
          thirdPartyServices: [{
            id: 'bailian',
            name: '阿里百炼',
            baseUrl: 'https://coding.dashscope.aliyuncs.com/apps/anthropic',
            authMode: 'auth-token',
            secretId: 'codianz-claude-bailian',
            defaultModel: 'qwen-plus',
            lightweightModel: 'qwen-flash',
            enabled: true,
          }],
        },
      },
    })).toEqual({
      count: 1,
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
    const rule = css.match(/\.codian-settings-default-provider\s*\{([^}]*)\}/)?.[1];

    expect(rule).toContain('align-items: center;');
  });

  it('renders About feedback and sponsorship content without retired media links', () => {
    const source = readFileSync(resolve('src/features/settings/CodianSettings.ts'), 'utf8');

    expect(source).toContain("feedback.appendText(t('settings.about.feedbackPrefix'))");
    expect(source).toContain("this.renderAboutInlineLink(feedback, 'issue', 'https://github.com/BCS1037/codian')");
    expect(source).toContain("this.renderAboutInlineLink(feedback, '维客笔记', 'https://mp.weixin.qq.com/s/gU2gbk9vYhsGfbUQrN333g')");
    expect(source).toContain("text: t('settings.about.sponsorDescription')");
    expect(source).toContain("this.renderAboutLink(sponsor, t('settings.about.afdian'), 'https://ifdian.net/a/bcs1037')");
    expect(source).not.toContain('xiaohongshu.com');
    expect(source).not.toContain('ask.feishu.cn');
  });

  it('aligns About sections with the slogan card edge', () => {
    const css = readFileSync(resolve('src/style/settings/base.css'), 'utf8');
    const rule = css.match(/\.codian-settings-about-section\s*\{([^}]*)\}/)?.[1];
    const headingRule = css.match(/\.codian-settings-about-section \.setting-item-heading\s*\{([^}]*)\}/)?.[1];

    expect(rule).toContain('padding: 0;');
    expect(headingRule).toContain('padding: 0;');
  });

  it('uses compact provider cards that can form three columns in the settings viewport', () => {
    const css = readFileSync(resolve('src/style/settings/base.css'), 'utf8');
    const gridRule = css.match(/\.codian-settings-provider-grid\s*\{([^}]*)\}/)?.[1];
    const cardRule = css.match(/\.codian-settings-provider-card\s*\{([^}]*)\}/)?.[1];

    expect(gridRule).toContain('minmax(180px, 1fr)');
    expect(cardRule).toContain('min-height: 92px;');
    expect(cardRule).toContain('padding: 12px;');
  });

  it('switches tabs by toggling active classes without destroying rendered DOM', () => {
    const plugin = {
      storage: { getAdapter: () => ({ exists: jest.fn(), read: jest.fn() }) },
      notifyAgentSkillsChanged: jest.fn(),
      settings: {},
      providerHost: {},
      getAllViews: () => [],
    };
    const tab = new CodianSettingTab({} as any, plugin as any);
    tab.containerEl = createMockEl('div');
    tab.display();

    const buttons = tab.containerEl.querySelectorAll('.codian-settings-tab');
    const contents = tab.containerEl.querySelectorAll('.codian-settings-tab-content');
    expect(buttons.length).toBe(4);
    expect(contents.length).toBe(4);

    // Initial state: general tab active
    expect(buttons[0].classList.contains('codian-settings-tab--active')).toBe(true);
    expect(contents[0].classList.contains('codian-settings-tab-content--active')).toBe(true);

    // Click 'About' tab (index 3)
    const emptySpy = jest.spyOn(tab.containerEl, 'empty');
    (buttons[3] as HTMLElement).click();

    expect(buttons[3].classList.contains('codian-settings-tab--active')).toBe(true);
    expect(contents[3].classList.contains('codian-settings-tab-content--active')).toBe(true);
    expect(buttons[0].classList.contains('codian-settings-tab--active')).toBe(false);
    expect(contents[0].classList.contains('codian-settings-tab-content--active')).toBe(false);

    // Should NOT have emptied containerEl
    expect(emptySpy).not.toHaveBeenCalled();

    // Click back to 'General' tab
    (buttons[0] as HTMLElement).click();
    expect(buttons[0].classList.contains('codian-settings-tab--active')).toBe(true);
    expect(contents[0].classList.contains('codian-settings-tab-content--active')).toBe(true);
    expect(emptySpy).not.toHaveBeenCalled();
  });

  it('selects provider card in providers tab without re-rendering outer tabs or grid', async () => {
    jest.spyOn(ProviderWorkspaceRegistry, 'ensureInitialized').mockResolvedValue(undefined);
    jest.spyOn(ProviderWorkspaceRegistry, 'prepareSettings').mockResolvedValue(undefined);

    const plugin = {
      storage: { getAdapter: () => ({ exists: jest.fn(), read: jest.fn() }) },
      notifyAgentSkillsChanged: jest.fn(),
      settings: {
        providerConfigs: {},
      },
      providerHost: {
        app: {},
        settings: { providerConfigs: {} },
        storage: { getAdapter: () => ({ exists: jest.fn(), read: jest.fn() }) },
      },
      getAllViews: () => [],
      getConversationList: () => [],
      getConversationById: () => null,
    };
    const tab = new CodianSettingTab({} as any, plugin as any);
    tab.containerEl = createMockEl('div');
    tab.display();

    // Switch to providers tab
    const buttons = tab.containerEl.querySelectorAll('.codian-settings-tab');
    (buttons[1] as HTMLElement).click();

    // Wait for async renderProvidersTab to resolve
    await new Promise((resolve) => setTimeout(resolve, 50));

    const providerCards = tab.containerEl.querySelectorAll('.codian-settings-provider-card');
    expect(providerCards.length).toBeGreaterThan(1);

    // Click second provider card
    const emptySpy = jest.spyOn(tab.containerEl, 'empty');
    (providerCards[1] as HTMLElement).click();
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Outer container was not wiped
    expect(emptySpy).not.toHaveBeenCalled();
    // Second card becomes active, first card is not active
    expect(providerCards[1].classList.contains('codian-settings-provider-card--active')).toBe(true);
    expect(providerCards[0].classList.contains('codian-settings-provider-card--active')).toBe(false);
  });

  it('switches workspace sections without re-rendering outer container or toolbar', async () => {
    jest.spyOn(ProviderWorkspaceRegistry, 'ensureInitialized').mockResolvedValue(undefined);
    jest.spyOn(ProviderWorkspaceRegistry, 'prepareSettings').mockResolvedValue(undefined);

    const plugin = {
      storage: { getAdapter: () => ({ exists: jest.fn(), read: jest.fn() }) },
      notifyAgentSkillsChanged: jest.fn(),
      settings: {},
      providerHost: {
        app: {},
        settings: {},
        storage: { getAdapter: () => ({ exists: jest.fn(), read: jest.fn() }) },
      },
      getAllViews: () => [],
      getConversationList: () => [],
      getConversationById: () => null,
    };
    const tab = new CodianSettingTab({} as any, plugin as any);
    tab.containerEl = createMockEl('div');
    tab.display();

    // Switch to workspace tab
    const buttons = tab.containerEl.querySelectorAll('.codian-settings-tab');
    (buttons[2] as HTMLElement).click();

    // Wait for async renderWorkspaceTab to finish
    await new Promise((resolve) => setTimeout(resolve, 50));

    const nav = tab.containerEl.querySelector('.codian-settings-segmented-nav');
    expect(nav).not.toBeNull();
    const sectionButtons = nav?.children ?? [];
    expect(sectionButtons.length).toBe(4);

    const emptySpy = jest.spyOn(tab.containerEl, 'empty');
    // Click 'Agents' section (index 1)
    (sectionButtons[1] as HTMLElement).click();
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(emptySpy).not.toHaveBeenCalled();
    expect(sectionButtons[1].classList.contains('is-active')).toBe(true);
    expect(sectionButtons[0].classList.contains('is-active')).toBe(false);
  });

  it('displays refresh button and hint in workspace MCP section, and triggers forceRefresh', async () => {
    jest.spyOn(ProviderWorkspaceRegistry, 'ensureInitialized').mockResolvedValue(undefined);
    jest.spyOn(ProviderWorkspaceRegistry, 'prepareSettings').mockResolvedValue(undefined);
    jest.spyOn(ProviderWorkspaceRegistry, 'supportsSettingsSection').mockReturnValue(true);

    const plugin = {
      storage: { getAdapter: () => ({ exists: jest.fn(), read: jest.fn() }) },
      notifyAgentSkillsChanged: jest.fn(),
      settings: {},
      providerHost: {
        app: {},
        settings: {},
        storage: { getAdapter: () => ({ exists: jest.fn(), read: jest.fn() }) },
      },
      getAllViews: () => [],
      getConversationList: () => [],
      getConversationById: () => null,
    };
    const tab = new CodianSettingTab({} as any, plugin as any);
    tab.containerEl = createMockEl('div');
    tab.display();

    // Switch to workspace tab
    const buttons = tab.containerEl.querySelectorAll('.codian-settings-tab');
    (buttons[2] as HTMLElement).click();
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Refresh button should exist
    const refreshBtn = tab.containerEl.querySelector('.codian-settings-resource-refresh-btn');
    expect(refreshBtn).not.toBeNull();

    const hintEl = tab.containerEl.querySelector('.codian-settings-resource-hint');
    expect(hintEl).not.toBeNull();
    // Default section is skills, hint should be hidden
    expect(hintEl?.classList.contains('codian-hidden')).toBe(true);

    // Switch to MCP section (index 2)
    const nav = tab.containerEl.querySelector('.codian-settings-segmented-nav');
    const sectionButtons = nav?.children ?? [];
    (sectionButtons[2] as HTMLElement).click();
    await new Promise((resolve) => setTimeout(resolve, 50));

    // In MCP section, hint should be visible
    expect(hintEl?.classList.contains('codian-hidden')).toBe(false);

    // Click refresh button
    (refreshBtn as HTMLElement).click();
    await new Promise((resolve) => setTimeout(resolve, 150));

    expect(Notice).toHaveBeenCalled();
  });
});
