import { kimiProviderRegistration } from '@/providers/kimi/registration';

const createdSettings: Array<{ heading: boolean; name: string }> = [];

jest.mock('obsidian', () => ({
  ...jest.requireActual('obsidian'),
  Setting: class MockSetting {
    heading = false;
    name = '';

    constructor(_container: unknown) {
      createdSettings.push(this);
    }

    setName(name: string): this {
      this.name = name;
      return this;
    }

    setDesc(): this {
      return this;
    }

    setHeading(): this {
      this.heading = true;
      return this;
    }

    addText(callback: (text: any) => void): this {
      const text = {
        onChange: jest.fn().mockReturnThis(),
        setPlaceholder: jest.fn().mockReturnThis(),
        setValue: jest.fn().mockReturnThis(),
      };
      callback(text);
      return this;
    }
  },
}));

describe('native ACP provider workspace', () => {
  beforeEach(() => {
    createdSettings.length = 0;
  });

  it('advertises Kimi ACP model, Thinking, and Plan capabilities', () => {
    const registration = kimiProviderRegistration;
    expect(registration.capabilities).toEqual(expect.objectContaining({
      supportsNativeHistory: false,
      supportsPlanMode: true,
      supportsMcpTools: false,
      reasoningControl: 'effort',
    }));
    expect(registration.chatUIConfig.getPermissionModeToggle?.()).toMatchObject({
      planValue: 'plan',
    });
    expect(registration.chatUIConfig.getReasoningOptions?.('default', {})).toEqual([
      { label: 'Off', value: 'off' },
      { label: 'On', value: 'on' },
    ]);
  });

  it('exposes CLI and settings services for Kimi', async () => {
    const providerId = 'kimi';
    const registration = kimiProviderRegistration;
    const services = await registration.workspace.initialize({} as any);
    const settings = {
      providerConfigs: {
        [providerId]: { cliPath: process.execPath },
      },
    };

    expect(services.cliResolver?.resolveFromSettings(settings)).toBe(process.execPath);
    expect(services.settingsTabRenderer?.sections).toEqual(['provider']);
  });

  it('uses a discovered-model picker instead of a CLI-owned placeholder', () => {
    expect(kimiProviderRegistration.chatUIConfig.modelManagement).toBe('visible-models');
    expect(kimiProviderRegistration.chatUIConfig.getModelOptions({
      providerConfigs: {
        kimi: {
          discoveredModels: [{ label: 'Kimi K2.5', rawId: 'kimi-k2.5' }],
          visibleModels: ['kimi-k2.5'],
        },
      },
    })).toEqual([{
      description: 'Kimi ACP model',
      label: 'Kimi K2.5',
      value: 'kimi-code/kimi-k2.5',
    }]);
  });
});
