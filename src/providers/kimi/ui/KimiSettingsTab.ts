import { Setting } from 'obsidian';

import type { ProviderSettingsTabRenderer } from '../../../core/providers/types';
import { t } from '../../../i18n/i18n';
import {
  type ProviderModelPickerModel,
  renderProviderModelPicker,
} from '../../../shared/settings/ProviderModelPicker';
import { getHostnameKey } from '../../../utils/env';
import { NativeAcpChatRuntime } from '../../native-acp/runtime/NativeAcpChatRuntime';
import type { NativeAcpCliResolver } from '../../native-acp/runtime/NativeAcpCliResolver';
import { KIMI_PROVIDER_CAPABILITIES } from '../capabilities';
import { KimiAcpSessionAdapter } from '../runtime/KimiAcpSessionAdapter';
import { getKimiProviderSettings, updateKimiProviderSettings } from '../settings';

export function createKimiSettingsTabRenderer(
  cliResolver: NativeAcpCliResolver,
): ProviderSettingsTabRenderer {
  return {
    sections: ['provider'],
    render(container, context, section) {
      const show = (target: 'provider') => section === undefined || section === target;
      const settingsBag = context.plugin.settings as unknown as Record<string, unknown>;
      const kimiSettings = getKimiProviderSettings(settingsBag);

      if (show('provider')) {
        new Setting(container).setName(t('settings.setup')).setHeading();
        new Setting(container)
          .setName(t('settings.nativeAcp.cliPathName').replace('{provider}', 'Kimi Code'))
          .setDesc(t('settings.nativeAcp.cliPathDesc').replace('{command}', 'kimi'))
          .addText(text => text
            .setPlaceholder(process.platform === 'win32' ? 'kimi.cmd' : '/usr/local/bin/kimi')
            .setValue(kimiSettings.cliPathsByHost[getHostnameKey()] ?? '')
            .onChange(async (value) => {
              const cliPathsByHost = { ...getKimiProviderSettings(settingsBag).cliPathsByHost };
              if (value.trim()) cliPathsByHost[getHostnameKey()] = value.trim();
              else delete cliPathsByHost[getHostnameKey()];
              await context.plugin.mutateSettings(settings => {
                updateKimiProviderSettings(settings, { cliPathsByHost });
              });
              cliResolver.reset();
              await context.plugin.recycleProviderRuntimes?.('kimi');
            }));

        new Setting(container).setName(t('settings.models')).setHeading();
        renderKimiModelPicker(container, context, settingsBag);

        new Setting(container).setName(t('settings.safety')).setHeading();
        new Setting(container)
          .setName(t('settings.providerPermissions.name'))
          .setDesc(t('settings.kimi.permissionDesc'));
      }

    },
  };
}

function renderKimiModelPicker(
  container: HTMLElement,
  context: Parameters<ProviderSettingsTabRenderer['render']>[1],
  settingsBag: Record<string, unknown>,
): void {
  const getState = () => {
    const current = getKimiProviderSettings(settingsBag);
    return {
      aliases: current.modelAliases,
      discoveredCount: current.discoveredModels.length,
      models: current.discoveredModels.map((model): ProviderModelPickerModel => ({
        ...(model.description ? { description: model.description } : {}),
        id: model.rawId,
        name: model.label,
      })),
      selectedIds: current.visibleModels,
    };
  };

  renderProviderModelPicker({
    container,
    emptyCatalogText: t('settings.providerCatalog.empty', { provider: 'Kimi Code' }),
    failedCatalogText: t('settings.providerCatalog.failed', { provider: 'Kimi Code' }),
    getState,
    async loadCatalog() {
      const runtime = new NativeAcpChatRuntime(context.plugin, {
        args: ['acp'],
        capabilities: KIMI_PROVIDER_CAPABILITIES,
        defaultCommand: 'kimi',
        providerId: 'kimi',
        sessionAdapter: new KimiAcpSessionAdapter(context.plugin),
      });
      try {
        const loaded = await runtime.ensureReady({ allowSessionCreation: true });
        if (!loaded) return 'failed';
        return getKimiProviderSettings(settingsBag).discoveredModels.length > 0 ? 'loaded' : 'empty';
      } finally {
        runtime.cleanup();
      }
    },
    loadCatalogOnRender: true,
    loadingCatalogText: t('settings.providerCatalog.loading', { provider: 'Kimi Code' }),
    modifier: 'kimi',
    async onAliasesChange(modelAliases) {
      await context.plugin.mutateSettings(settings => {
        updateKimiProviderSettings(settings, { modelAliases });
      });
      context.refreshModelSelectors();
    },
    async onSelectedIdsChange(visibleModels) {
      await context.plugin.mutateSettings(settings => {
        updateKimiProviderSettings(settings, { visibleModels });
      });
      context.refreshModelSelectors();
    },
    providerName: 'Kimi Code',
  });
}
