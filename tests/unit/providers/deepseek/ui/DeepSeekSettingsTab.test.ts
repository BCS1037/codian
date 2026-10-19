/**
 * @jest-environment jsdom
 */

import * as fs from 'node:fs';

import { setLocale, t } from '@/i18n/i18n';
import { getDeepSeekProviderSettings } from '@/providers/deepseek/settings';
import { createDeepSeekSettingsTabRenderer } from '@/providers/deepseek/ui/DeepSeekSettingsTab';

const mockGetHostnameKey = jest.fn(() => 'device:current');
const mockRenderProviderModelPicker = jest.fn();
const mockCliResolverReset = jest.fn();
const mockModelCatalogRefresh = jest.fn().mockResolvedValue({ changed: false });

jest.mock('node:fs');
jest.mock('@/shared/settings/ProviderModelPicker', () => ({
  renderProviderModelPicker: (...args: unknown[]) => {
    mockRenderProviderModelPicker(...args);
    return { refresh: jest.fn() };
  },
}));
jest.mock('@/utils/env', () => ({
  ...jest.requireActual('@/utils/env'),
  getHostnameKey: () => mockGetHostnameKey(),
}));

interface MockTextComponent {
  inputEl: HTMLElement & {
    addClass: jest.Mock;
    toggleClass: jest.Mock;
    value: string;
    rows?: number;
    spellcheck?: boolean;
  };
  onChangeCallback: ((value: string) => Promise<void> | void) | null;
  placeholder: string;
  value: string;
  onChange(callback: (value: string) => Promise<void> | void): MockTextComponent;
  setPlaceholder(value: string): MockTextComponent;
  setValue(value: string): MockTextComponent;
}

interface MockToggleComponent {
  onChangeCallback: ((value: boolean) => Promise<void> | void) | null;
  value: boolean;
  onChange(callback: (value: boolean) => Promise<void> | void): MockToggleComponent;
  setValue(value: boolean): MockToggleComponent;
}

interface MockSettingInstance {
  name: string;
  desc: string;
  heading: boolean;
  textComponents: MockTextComponent[];
  toggleComponents: MockToggleComponent[];
  controlEl: HTMLElement;
}

const createdSettings: MockSettingInstance[] = [];

jest.mock('obsidian', () => {
  class MockSetting {
    public name = '';
    public desc = '';
    public heading = false;
    public textComponents: MockTextComponent[] = [];
    public toggleComponents: MockToggleComponent[] = [];
    public controlEl: HTMLElement = document.createElement('div');

    constructor(_container: unknown) {
      createdSettings.push(this);
    }

    setName(value: string) {
      this.name = value;
      return this;
    }

    setDesc(value: string) {
      this.desc = value;
      return this;
    }

    setHeading() {
      this.heading = true;
      return this;
    }

    setClass(_cls: string) {
      return this;
    }

    addText(callback: (component: MockTextComponent) => void) {
      const component = createTextComponent();
      this.textComponents.push(component);
      callback(component);
      return this;
    }

    addTextArea(callback: (component: MockTextComponent) => void) {
      const component = createTextComponent();
      this.textComponents.push(component);
      callback(component);
      return this;
    }

    addToggle(callback: (component: MockToggleComponent) => void) {
      const component = createToggleComponent();
      this.toggleComponents.push(component);
      callback(component);
      return this;
    }
  }

  return { Setting: MockSetting };
});

function createTextComponent(): MockTextComponent {
  const inputEl = document.createElement('input') as unknown as MockTextComponent['inputEl'];
  inputEl.addClass = jest.fn();
  inputEl.toggleClass = jest.fn();
  inputEl.value = '';

  const component: MockTextComponent = {
    inputEl,
    onChangeCallback: null,
    placeholder: '',
    value: '',
    onChange(callback) {
      component.onChangeCallback = callback;
      return component;
    },
    setPlaceholder(value) {
      component.placeholder = value;
      return component;
    },
    setValue(value) {
      component.value = value;
      component.inputEl.value = value;
      return component;
    },
  };

  return component;
}

function createToggleComponent(): MockToggleComponent {
  const component: MockToggleComponent = {
    onChangeCallback: null,
    value: false,
    onChange(callback) {
      component.onChangeCallback = callback;
      return component;
    },
    setValue(value) {
      component.value = value;
      return component;
    },
  };

  return component;
}

describe('DeepSeekSettingsTab', () => {
  beforeEach(() => {
    setLocale('en');
    createdSettings.length = 0;
    mockRenderProviderModelPicker.mockClear();
    mockCliResolverReset.mockClear();
    mockModelCatalogRefresh.mockClear();
    jest.spyOn(fs, 'existsSync').mockReturnValue(true);
    jest.spyOn(fs, 'statSync').mockReturnValue({ isFile: () => true, isDirectory: () => false } as unknown as fs.Stats);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('renders standard Codian section headings and components in en locale', () => {
    const container = document.createElement('div');
    const settingsBag: Record<string, unknown> = {
      providerConfigs: {
        deepseek: {
          enabled: true,
          codeMode: false,
          cliPathsByHost: {},
          presetPlugins: '',
        },
      },
    };

    const host = {
      settings: settingsBag,
      mutateSettings: jest.fn(async (fn: (s: Record<string, unknown>) => void) => fn(settingsBag)),
      getEnvironmentVariablesForScope: jest.fn(() => ''),
      setEnvironmentVariablesForScope: jest.fn(async () => {}),
    };

    const context = {
      plugin: host,
      notifyProviderModelOptionsChanged: jest.fn(),
      renderHiddenProviderCommandSetting: jest.fn(),
    };

    const renderer = createDeepSeekSettingsTabRenderer({
      cliResolver: { reset: mockCliResolverReset } as any,
      modelCatalog: { refresh: mockModelCatalogRefresh } as any,
    });

    renderer.render(container, context as any, 'provider');

    // Section headings
    const headings = createdSettings.filter(s => s.heading).map(s => s.name);
    expect(headings).toContain(t('settings.setup'));
    expect(headings).toContain(t('settings.models'));
    expect(headings).toContain(t('settings.safety'));

    // Verify model picker called
    expect(mockRenderProviderModelPicker).toHaveBeenCalledTimes(1);
    const pickerArgs = mockRenderProviderModelPicker.mock.calls[0][0];
    expect(pickerArgs.providerName).toBe('DeepSeek Harness');
    expect(pickerArgs.emptyCatalogText).toBe(t('settings.providerCatalog.empty', { provider: 'DeepSeek Harness' }));

    // Verify code mode toggle present
    const codeModeSetting = createdSettings.find(s => s.name === t('settings.deepseek.codeMode.name'));
    expect(codeModeSetting).toBeDefined();
    expect(codeModeSetting?.toggleComponents.length).toBe(1);

    // Verify advanced details container does not exist
    const advancedDetails = container.querySelector('details.codian-settings-advanced-details');
    expect(advancedDetails).toBeNull();
  });

  it('renders zh-CN localized section headings and texts', () => {
    setLocale('zh-CN');
    const container = document.createElement('div');
    const settingsBag: Record<string, unknown> = {
      providerConfigs: {
        deepseek: {
          enabled: true,
          codeMode: false,
          cliPathsByHost: {},
          presetPlugins: '',
        },
      },
    };

    const host = {
      settings: settingsBag,
      mutateSettings: jest.fn(async (fn: (s: Record<string, unknown>) => void) => fn(settingsBag)),
      getEnvironmentVariablesForScope: jest.fn(() => ''),
      setEnvironmentVariablesForScope: jest.fn(async () => {}),
    };

    const context = {
      plugin: host,
      notifyProviderModelOptionsChanged: jest.fn(),
    };

    const renderer = createDeepSeekSettingsTabRenderer({
      cliResolver: { reset: mockCliResolverReset } as any,
      modelCatalog: { refresh: mockModelCatalogRefresh } as any,
    });

    renderer.render(container, context as any, 'provider');

    const headings = createdSettings.filter(s => s.heading).map(s => s.name);
    expect(headings).toContain('连接'); // settings.setup in zh-CN
    expect(headings).toContain('模型'); // settings.models in zh-CN
    expect(headings).toContain('权限与隔离'); // settings.safety in zh-CN

    const codeModeSetting = createdSettings.find(s => s.name === '启用代码模式');
    expect(codeModeSetting).toBeDefined();
  });

  it('updates codeMode setting when toggled', async () => {
    const container = document.createElement('div');
    const settingsBag: Record<string, unknown> = {
      providerConfigs: {
        deepseek: {
          enabled: true,
          codeMode: false,
          cliPathsByHost: {},
        },
      },
    };

    const host = {
      settings: settingsBag,
      mutateSettings: jest.fn(async (fn: (s: Record<string, unknown>) => void) => fn(settingsBag)),
      getEnvironmentVariablesForScope: jest.fn(() => ''),
      setEnvironmentVariablesForScope: jest.fn(async () => {}),
    };

    const context = {
      plugin: host,
      notifyProviderModelOptionsChanged: jest.fn(),
    };

    const renderer = createDeepSeekSettingsTabRenderer({
      cliResolver: { reset: mockCliResolverReset } as any,
      modelCatalog: { refresh: mockModelCatalogRefresh } as any,
    });

    renderer.render(container, context as any, 'provider');

    const codeModeSetting = createdSettings.find(s => s.name === t('settings.deepseek.codeMode.name'));
    expect(codeModeSetting).toBeDefined();
    const toggle = codeModeSetting!.toggleComponents[0];
    await toggle.onChangeCallback!(true);

    expect(getDeepSeekProviderSettings(settingsBag).codeMode).toBe(true);
  });
});
