import * as fs from 'fs';

import { DEFAULT_CLAUDE_PROVIDER_SETTINGS } from '@/providers/claude/settings';
import { claudeSettingsTabRenderer } from '@/providers/claude/ui/ClaudeSettingsTab';

const mockRenderEnvironmentSettingsSection = jest.fn();
const mockRenderClaudeServiceSettings = jest.fn();
const mockRenderProviderModelPicker = jest.fn((_options: unknown) => ({ refresh: jest.fn() }));
const mockSaveSettings = jest.fn().mockResolvedValue(undefined);
const mockGetClaudeSettingsModelEnvironment = jest.fn(() => ({}));
const mockIsClaudeAuthenticated = jest.fn().mockResolvedValue(true);

jest.mock('fs');
jest.mock('@/core/providers/ProviderSettingsCoordinator', () => ({
  ProviderSettingsCoordinator: {
    reconcileTitleGenerationModelSelection: jest.fn((settings: Record<string, unknown>) => {
      const titleGenerationModel = settings.titleGenerationModel;
      const customModels = (
        settings.providerConfigs as { claude?: { customModels?: string } } | undefined
      )?.claude?.customModels ?? '';
      if (titleGenerationModel === 'claude-opus-4-6' && customModels !== 'claude-opus-4-6') {
        settings.titleGenerationModel = '';
        return true;
      }
      return false;
    }),
  },
}));

jest.mock('obsidian', () => {
  class MockSetting {
    public name = '';
    public desc = '';
    public heading = false;
    public textComponents: MockTextComponent[] = [];
    public textAreaComponents: MockTextAreaComponent[] = [];
    public dropdownComponents: MockDropdownComponent[] = [];
    public toggleComponents: MockToggleComponent[] = [];

    constructor(_container: unknown) {
      createdSettings.push(this);
    }

    setName(name: string) {
      this.name = name;
      return this;
    }

    setDesc(desc: string) {
      this.desc = desc;
      return this;
    }

    setHeading() {
      this.heading = true;
      return this;
    }

    addText(callback: (text: MockTextComponent) => void) {
      const component = createTextComponent();
      this.textComponents.push(component);
      callback(component);
      return this;
    }

    addTextArea(callback: (text: MockTextAreaComponent) => void) {
      const component = createTextAreaComponent();
      this.textAreaComponents.push(component);
      callback(component);
      return this;
    }

    addDropdown(callback: (dropdown: MockDropdownComponent) => void) {
      const component = createDropdownComponent();
      this.dropdownComponents.push(component);
      callback(component);
      return this;
    }

    addToggle(callback: (toggle: MockToggleComponent) => void) {
      const component = createToggleComponent();
      this.toggleComponents.push(component);
      callback(component);
      return this;
    }
  }

  return {
    Setting: MockSetting,
  };
});
jest.mock('@/shared/settings/EnvironmentSettingsSection', () => ({
  renderEnvironmentSettingsSection: (...args: unknown[]) => mockRenderEnvironmentSettingsSection(...args),
}));

jest.mock('@/providers/claude/ui/ClaudeServiceSettings', () => ({
  renderClaudeServiceSettings: (...args: unknown[]) => mockRenderClaudeServiceSettings(...args),
}));

jest.mock('@/providers/claude/config/ClaudeModelSettings', () => ({
  getClaudeSettingsModelEnvironment: () => mockGetClaudeSettingsModelEnvironment(),
}));

jest.mock('@/providers/claude/cli/ClaudeAuthenticationStatus', () => ({
  isClaudeAuthenticated: () => mockIsClaudeAuthenticated(),
}));

jest.mock('@/shared/settings/ProviderModelPicker', () => ({
  renderProviderModelPicker: (options: unknown) => mockRenderProviderModelPicker(options),
}));

jest.mock('@/shared/settings/McpSettingsManager', () => ({
  McpSettingsManager: jest.fn(),
}));

jest.mock('@/providers/claude/app/ClaudeWorkspaceServices', () => ({
  getClaudeWorkspaceServices: jest.fn(() => ({
    cliResolver: {
      reset: jest.fn(),
      resolveFromSettings: jest.fn(() => '/test/claude'),
    },
    commandCatalog: {},
    agentManager: {},
    agentStorage: {},
    mcpStorage: {},
    pluginManager: {},
  })),
}));

jest.mock('@/providers/claude/ui/AgentSettings', () => ({
  AgentSettings: jest.fn(),
}));

jest.mock('@/providers/claude/ui/PluginSettingsManager', () => ({
  PluginSettingsManager: jest.fn(),
}));

jest.mock('@/providers/claude/ui/SlashCommandSettings', () => ({
  SlashCommandSettings: jest.fn(),
}));

jest.mock('@/i18n/i18n', () => ({
  t: (key: string) => key,
}));

jest.mock('@/utils/env', () => {
  const actual = jest.requireActual('@/utils/env');
  return {
    ...actual,
    getHostnameKey: () => 'host-a',
  };
});

interface MockInputEl {
  rows: number;
  cols: number;
  value: string;
  style: Record<string, string>;
  dataset: Record<string, string>;
  addClass: jest.Mock;
  toggleClass: jest.Mock;
  addEventListener: jest.Mock;
}

interface MockTextComponent {
  value: string;
  placeholder: string;
  onChangeCallback: ((value: string) => Promise<void> | void) | null;
  setPlaceholder: jest.MockedFunction<(value: string) => MockTextComponent>;
  setValue: jest.MockedFunction<(value: string) => MockTextComponent>;
  onChange: jest.MockedFunction<(callback: (value: string) => Promise<void> | void) => MockTextComponent>;
  inputEl: MockInputEl;
}

interface MockTextAreaComponent extends MockTextComponent {
  trigger: (event: string) => Promise<void>;
}

interface MockDropdownComponent {
  value: string;
  options: Array<{ value: string; label: string }>;
  onChangeCallback: ((value: string) => Promise<void> | void) | null;
  addOption: jest.MockedFunction<(value: string, label: string) => MockDropdownComponent>;
  setValue: jest.MockedFunction<(value: string) => MockDropdownComponent>;
  onChange: jest.MockedFunction<(callback: (value: string) => Promise<void> | void) => MockDropdownComponent>;
}

interface MockToggleComponent {
  value: boolean;
  onChangeCallback: ((value: boolean) => Promise<void> | void) | null;
  setValue: jest.MockedFunction<(value: boolean) => MockToggleComponent>;
  onChange: jest.MockedFunction<(callback: (value: boolean) => Promise<void> | void) => MockToggleComponent>;
}

const createdSettings: Array<{
  name: string;
  desc: string;
  heading: boolean;
  textComponents: MockTextComponent[];
  textAreaComponents: MockTextAreaComponent[];
  dropdownComponents: MockDropdownComponent[];
  toggleComponents: MockToggleComponent[];
}> = [];

function createInputEl(): MockInputEl & { _listeners: Map<string, Array<() => void>> } {
  const listeners = new Map<string, Array<() => void>>();
  return {
    rows: 0,
    cols: 0,
    value: '',
    style: {},
    dataset: {},
    addClass: jest.fn(),
    toggleClass: jest.fn(),
    addEventListener: jest.fn((event: string, handler: () => void) => {
      const handlers = listeners.get(event) ?? [];
      handlers.push(handler);
      listeners.set(event, handlers);
    }),
    _listeners: listeners,
  };
}

function createTextComponent(): MockTextComponent {
  const component = {} as MockTextComponent;
  component.value = '';
  component.placeholder = '';
  component.onChangeCallback = null;
  component.inputEl = createInputEl();
  component.setPlaceholder = jest.fn((value: string) => {
    component.placeholder = value;
    return component;
  });
  component.setValue = jest.fn((value: string) => {
    component.value = value;
    component.inputEl.value = value;
    return component;
  });
  component.onChange = jest.fn((callback: (value: string) => Promise<void> | void) => {
    component.onChangeCallback = callback;
    return component;
  });

  return component;
}

function createTextAreaComponent(): MockTextAreaComponent {
  const component = createTextComponent() as MockTextAreaComponent;
  component.trigger = async (event: string) => {
    const handlers = (component.inputEl as ReturnType<typeof createInputEl>)._listeners.get(event) ?? [];
    for (const handler of handlers) {
      handler();
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
  };
  return component;
}

function createDropdownComponent(): MockDropdownComponent {
  const component = {} as MockDropdownComponent;
  component.value = '';
  component.options = [];
  component.onChangeCallback = null;
  component.addOption = jest.fn((value: string, label: string) => {
    component.options.push({ value, label });
    return component;
  });
  component.setValue = jest.fn((value: string) => {
    component.value = value;
    return component;
  });
  component.onChange = jest.fn((callback: (value: string) => Promise<void> | void) => {
    component.onChangeCallback = callback;
    return component;
  });

  return component;
}

function createToggleComponent(): MockToggleComponent {
  const component = {} as MockToggleComponent;
  component.value = false;
  component.onChangeCallback = null;
  component.setValue = jest.fn((value: boolean) => {
    component.value = value;
    return component;
  });
  component.onChange = jest.fn((callback: (value: boolean) => Promise<void> | void) => {
    component.onChangeCallback = callback;
    return component;
  });

  return component;
}

function createElement(): any {
  const classes = new Set<string>();
  const element: any = {
    value: '',
    style: {},
    dataset: {},
    appendText: jest.fn(),
    createEl: jest.fn(() => createElement()),
    createDiv: jest.fn(() => createElement()),
    createSpan: jest.fn(() => createElement()),
    setText: jest.fn(),
    empty: jest.fn(),
    addClass: jest.fn((cls: string) => {
      cls.split(/\s+/).filter(Boolean).forEach((item) => classes.add(item));
    }),
    removeClass: jest.fn((cls: string) => {
      cls.split(/\s+/).filter(Boolean).forEach((item) => classes.delete(item));
    }),
    toggleClass: jest.fn((cls: string, force: boolean) => {
      if (force) {
        classes.add(cls);
      } else {
        classes.delete(cls);
      }
    }),
    hasClass: jest.fn((cls: string) => classes.has(cls)),
    classList: {
      add: jest.fn((cls: string) => classes.add(cls)),
      remove: jest.fn((cls: string) => classes.delete(cls)),
      toggle: jest.fn((cls: string, force?: boolean) => {
        if (force === undefined) {
          if (classes.has(cls)) {
            classes.delete(cls);
            return false;
          }
          classes.add(cls);
          return true;
        }
        if (force) {
          classes.add(cls);
        } else {
          classes.delete(cls);
        }
        return force;
      }),
      contains: jest.fn((cls: string) => classes.has(cls)),
    },
  };

  return element;
}

function createContainer(): any {
  return {
    createDiv: jest.fn(() => createElement()),
    createEl: jest.fn(() => createElement()),
  };
}

function createPlugin(overrides: Record<string, unknown> = {}): any {
  const plugin: any = {
    settings: {
      settingsProvider: 'claude',
      model: 'claude-opus-4-6',
      titleGenerationModel: '',
      providerConfigs: {
        claude: {
          ...DEFAULT_CLAUDE_PROVIDER_SETTINGS,
          customModels: 'claude-opus-4-6',
          lastModel: 'sonnet',
        },
      },
      ...overrides,
    },
    saveSettings: mockSaveSettings,
    normalizeModelVariantSettings: jest.fn(() => false),
    recycleProviderRuntimes: jest.fn().mockResolvedValue(undefined),
    getView: jest.fn(() => ({
      getTabManager: jest.fn(() => ({
        broadcastToAllTabs: jest.fn().mockResolvedValue(undefined),
      })),
    })),
    app: {
      vault: {
        adapter: {
          basePath: '/test/vault',
        },
      },
    },
  };
  plugin.mutateSettings = jest.fn(async (mutation: (settings: any) => void | Promise<void>) => {
    await mutation(plugin.settings);
    await plugin.saveSettings();
  });
  return plugin;
}

function createContext(plugin: any) {
  return {
    plugin,
    notifyProviderModelOptionsChanged: jest.fn(),
    refreshModelSelectors: jest.fn(),
    refreshTitleGenerationModelOptions: jest.fn(),
    renderHiddenProviderCommandSetting: jest.fn(),
    renderCustomContextLimits: jest.fn(),
  };
}

function findSetting(name: string) {
  const setting = createdSettings.find(candidate => candidate.name === name);
  if (!setting) {
    throw new Error(`Setting not found: ${name}`);
  }
  return setting;
}

describe('ClaudeSettingsTab', () => {
  const mockedExistsSync = fs.existsSync as jest.MockedFunction<typeof fs.existsSync>;
  const mockedStatSync = fs.statSync as jest.MockedFunction<typeof fs.statSync>;

  beforeEach(() => {
    createdSettings.length = 0;
    jest.clearAllMocks();
    mockedExistsSync.mockReturnValue(false);
    mockedStatSync.mockReturnValue({ isFile: () => true } as fs.Stats);
    mockGetClaudeSettingsModelEnvironment.mockReturnValue({});
    mockIsClaudeAuthenticated.mockResolvedValue(true);
  });

  it('does not duplicate provider enablement inside the detail panel', () => {
    const plugin = createPlugin();
    const context = createContext(plugin);

    claudeSettingsTabRenderer.render(createContainer(), context);

    expect(createdSettings.some(setting => (
      setting.name === 'settings.claude.enableProvider.name'
    ))).toBe(false);
  });

  it('renders models before access and isolation in the provider panel', () => {
    claudeSettingsTabRenderer.render(createContainer(), createContext(createPlugin()), 'provider');

    const headings = createdSettings
      .filter(setting => setting.heading)
      .map(setting => setting.name);

    expect(headings.slice(0, 3)).toEqual([
      'settings.setup',
      'settings.models',
      'settings.safety',
    ]);
  });

  it('renders third-party model services in the Claude provider panel', () => {
    const container = createContainer();
    const context = createContext(createPlugin());

    claudeSettingsTabRenderer.render(container, context, 'provider');

    expect(mockRenderClaudeServiceSettings).toHaveBeenCalledWith(container, context);
  });

  it('renders configured Claude models with the shared provider model picker', () => {
    const container = createContainer();
    const context = createContext(createPlugin());

    claudeSettingsTabRenderer.render(container, context, 'provider');

    expect(mockRenderProviderModelPicker).toHaveBeenCalledWith(expect.objectContaining({
      container,
      modifier: 'claude',
      providerName: 'Claude',
    }));
  });

  it('lists built-in Claude models after native Claude authentication succeeds', async () => {
    const plugin = createPlugin({
      providerConfigs: {
        claude: {
          ...DEFAULT_CLAUDE_PROVIDER_SETTINGS,
          customModels: '',
        },
      },
    });

    claudeSettingsTabRenderer.render(createContainer(), createContext(plugin), 'provider');

    const options = mockRenderProviderModelPicker.mock.calls[0][0] as {
      getState(): { discoveredCount: number; models: Array<{ id: string }> };
      loadCatalog(): Promise<string>;
    };
    await options.loadCatalog();
    const state = options.getState();

    expect(state.discoveredCount).toBeGreaterThan(0);
    expect(state.models.map(model => model.id)).toEqual(expect.arrayContaining([
      'haiku',
      'sonnet',
      'opus',
    ]));
  });

  it('uses configured Claude settings models without checking native authentication', async () => {
    mockGetClaudeSettingsModelEnvironment.mockReturnValue({
      ANTHROPIC_MODEL: 'gateway/custom-model',
    });
    const plugin = createPlugin({
      providerConfigs: {
        claude: {
          ...DEFAULT_CLAUDE_PROVIDER_SETTINGS,
          customModels: '',
        },
      },
    });

    claudeSettingsTabRenderer.render(createContainer(), createContext(plugin), 'provider');

    const options = mockRenderProviderModelPicker.mock.calls[0][0] as {
      getState(): { models: Array<{ id: string }> };
      loadCatalog(): Promise<string>;
    };

    expect(options.getState().models.map(model => model.id)).toEqual(['gateway/custom-model']);
    await expect(options.loadCatalog()).resolves.toBe('loaded');
    expect(mockIsClaudeAuthenticated).not.toHaveBeenCalled();
  });

  it('keeps third-party service selections out of manual model persistence', () => {
    const plugin = createPlugin({
      providerConfigs: {
        claude: {
          ...DEFAULT_CLAUDE_PROVIDER_SETTINGS,
          thirdPartyServices: [{
            id: 'gateway',
            name: 'Gateway',
            preset: 'custom',
            baseUrl: 'https://example.com',
            authMode: 'api-key',
            secretId: 'secret',
            defaultModel: 'gateway-model',
            lightweightModel: 'gateway-model',
            enabled: true,
            advancedEnvironmentVariables: '',
          }],
        },
      },
    });

    claudeSettingsTabRenderer.render(createContainer(), createContext(plugin), 'provider');

    const options = mockRenderProviderModelPicker.mock.calls[0][0] as {
      getState(): { models: Array<{ id: string }> };
    };

    expect(options.getState().models.map(model => model.id)).not.toContain(
      'claude-code/service/gateway/gateway-model',
    );
  });

  it('uses the current npm package wrapper path as the CLI placeholder', () => {
    const plugin = createPlugin();
    const context = createContext(plugin);

    claudeSettingsTabRenderer.render(createContainer(), context);

    const cliPathSetting = findSetting('settings.cliPath.name');
    const cliPathInput = cliPathSetting.textComponents[0];

    expect(cliPathInput.placeholder).toContain('cli-wrapper.cjs');
    expect(cliPathInput.placeholder).not.toContain('cli.js');
  });

  it('does not render obsolete Opus and Sonnet 1M toggles', () => {
    const plugin = createPlugin();
    const context = createContext(plugin);

    claudeSettingsTabRenderer.render(createContainer(), context);

    expect(createdSettings.map(setting => setting.name)).not.toContain('settings.enableOpus1M.name');
    expect(createdSettings.map(setting => setting.name)).not.toContain('settings.enableSonnet1M.name');
  });

  it('hides the legacy custom models textarea while retaining saved selections', () => {
    const plugin = createPlugin();
    const context = createContext(plugin);

    claudeSettingsTabRenderer.render(createContainer(), context);

    expect(createdSettings.map(setting => setting.name)).not.toContain('settings.customModels.name');
    expect(plugin.settings.providerConfigs.claude.customModels).toBe('claude-opus-4-6');

    const options = mockRenderProviderModelPicker.mock.calls[0][0] as {
      getState(): { selectedIds: string[] };
    };
    expect(options.getState().selectedIds).toEqual(['claude-opus-4-6']);
  });

  it('offers auto as a Claude safe mode and persists it', async () => {
    const plugin = createPlugin();
    const context = createContext(plugin);

    claudeSettingsTabRenderer.render(createContainer(), context);

    const safeModeSetting = findSetting('settings.claudeSafeMode.name');
    const safeModeDropdown = safeModeSetting.dropdownComponents[0];

    expect(safeModeDropdown.options).toEqual([
      { value: 'acceptEdits', label: 'settings.claudeSafeMode.acceptEdits' },
      { value: 'auto', label: 'settings.claudeSafeMode.auto' },
      { value: 'default', label: 'settings.claudeSafeMode.default' },
    ]);

    await safeModeDropdown.onChangeCallback?.('auto');

    expect(plugin.settings.providerConfigs.claude.safeMode).toBe('auto');
    expect(mockSaveSettings).toHaveBeenCalledTimes(1);
  });

});
