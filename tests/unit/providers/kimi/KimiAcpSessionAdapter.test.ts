import { encodeProviderModelSelectionId } from '@/core/providers/modelSelection';
import { KimiAcpSessionAdapter } from '@/providers/kimi/runtime/KimiAcpSessionAdapter';
import { getKimiProviderSettings } from '@/providers/kimi/settings';

function createPlugin(): any {
  const settings: Record<string, unknown> = {
    effortLevel: 'on',
    permissionMode: 'plan',
    providerConfigs: {
      kimi: { enabled: true },
    },
  };
  return {
    settings,
    mutateSettings: jest.fn(async (mutation) => mutation(settings)),
    refreshModelSelectors: jest.fn(),
  };
}

const SESSION_CONFIG = {
  sessionId: 'kimi-session',
  configOptions: [
    {
      id: 'model',
      name: 'Model',
      category: 'model',
      type: 'select' as const,
      currentValue: 'kimi-k2.5',
      options: [
        { name: 'Kimi K2.5', value: 'kimi-k2.5' },
        { name: 'Kimi K2.5 Thinking', value: 'kimi-k2.5-thinking' },
      ],
    },
    {
      id: 'thinking',
      name: 'Thinking',
      category: 'thought_level',
      type: 'boolean' as const,
      value: false,
    },
    {
      id: 'mode',
      name: 'Mode',
      category: 'mode',
      type: 'select' as const,
      currentValue: 'agent',
      options: [
        { name: 'Agent', value: 'agent' },
        { name: 'Plan', value: 'plan' },
      ],
    },
  ],
};

describe('KimiAcpSessionAdapter', () => {
  it('discovers models, thinking, and modes from Kimi ACP config options', async () => {
    const plugin = createPlugin();
    const adapter = new KimiAcpSessionAdapter(plugin);

    await adapter.syncSessionConfig(SESSION_CONFIG);

    expect(getKimiProviderSettings(plugin.settings)).toMatchObject({
      availableModes: [
        { id: 'agent', label: 'Agent' },
        { id: 'plan', label: 'Plan' },
      ],
      discoveredModels: [
        { label: 'Kimi K2.5', rawId: 'kimi-k2.5' },
        { label: 'Kimi K2.5 Thinking', rawId: 'kimi-k2.5-thinking' },
      ],
      visibleModels: ['kimi-k2.5', 'kimi-k2.5-thinking'],
    });
    expect(plugin.refreshModelSelectors).toHaveBeenCalled();
  });

  it('does not re-enable models the user explicitly cleared', async () => {
    const plugin = createPlugin();
    plugin.settings.providerConfigs.kimi = {
      enabled: true,
      discoveredModels: [{ label: 'Kimi K2.5', rawId: 'kimi-k2.5' }],
      visibleModels: [],
    };
    const adapter = new KimiAcpSessionAdapter(plugin);

    await adapter.syncSessionConfig(SESSION_CONFIG);

    expect(getKimiProviderSettings(plugin.settings).visibleModels).toEqual([]);
  });

  it('applies the selected model, thinking state, and Plan mode through ACP', async () => {
    const plugin = createPlugin();
    const adapter = new KimiAcpSessionAdapter(plugin);
    await adapter.syncSessionConfig(SESSION_CONFIG);
    const connection = {
      setConfigOption: jest.fn(async () => ({ configOptions: SESSION_CONFIG.configOptions })),
    } as any;

    await adapter.applySelections({
      connection,
      model: encodeProviderModelSelectionId('kimi', 'kimi-k2.5-thinking'),
      sessionId: 'kimi-session',
    });

    expect(connection.setConfigOption).toHaveBeenCalledWith({
      configId: 'model',
      sessionId: 'kimi-session',
      type: 'select',
      value: 'kimi-k2.5-thinking',
    });
    expect(connection.setConfigOption).toHaveBeenCalledWith({
      configId: 'thinking',
      sessionId: 'kimi-session',
      type: 'boolean',
      value: true,
    });
    expect(connection.setConfigOption).toHaveBeenCalledWith({
      configId: 'mode',
      sessionId: 'kimi-session',
      type: 'select',
      value: 'plan',
    });
  });

  it('switches a Kimi session back from Plan to its normal agent mode', async () => {
    const plugin = createPlugin();
    plugin.settings.permissionMode = 'normal';
    const adapter = new KimiAcpSessionAdapter(plugin);
    await adapter.syncSessionConfig({
      ...SESSION_CONFIG,
      configOptions: SESSION_CONFIG.configOptions.map(option => (
        option.id === 'mode' && option.type === 'select'
          ? { ...option, currentValue: 'plan' }
          : option
      )),
    });
    const connection = {
      setConfigOption: jest.fn(async () => ({ configOptions: SESSION_CONFIG.configOptions })),
    } as any;

    await adapter.applySelections({ connection, sessionId: 'kimi-session' });

    expect(connection.setConfigOption).toHaveBeenCalledWith({
      configId: 'mode',
      sessionId: 'kimi-session',
      type: 'select',
      value: 'agent',
    });
  });

  it('turns Kimi missing-model failures into an actionable login hint', () => {
    const adapter = new KimiAcpSessionAdapter(createPlugin());

    expect(adapter.formatStartError(new Error('Internal error'))).toBe(
      'Kimi Code could not create a session. Run `kimi`, complete `/login`, and confirm a model is configured.',
    );
    expect(adapter.formatStartError(new Error('No model configured'))).toBe(
      'Kimi Code could not create a session. Run `kimi`, complete `/login`, and confirm a model is configured.',
    );
  });
});
