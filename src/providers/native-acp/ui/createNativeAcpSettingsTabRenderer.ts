import { Setting } from 'obsidian';

import type { ProviderSettingsTabRenderer } from '../../../core/providers/types';
import { t } from '../../../i18n/i18n';
import { getHostnameKey } from '../../../utils/env';
import type { NativeAcpCliResolver } from '../runtime/NativeAcpCliResolver';
import { getNativeAcpProviderSettings, updateNativeAcpProviderSettings } from '../settings';

export function createNativeAcpSettingsTabRenderer(options: {
  cliResolver: NativeAcpCliResolver;
  defaultCommand: string;
  displayName: string;
  providerId: string;
}): ProviderSettingsTabRenderer {
  return {
    sections: ['provider'],
    render(container, context, section) {
      const show = (target: 'provider') => section === undefined || section === target;
      const settings = getNativeAcpProviderSettings(context.plugin.settings, options.providerId);

      if (show('provider')) {
        new Setting(container).setName(t('settings.setup')).setHeading();
        new Setting(container)
          .setName(t('settings.nativeAcp.cliPathName').replace('{provider}', options.displayName))
          .setDesc(t('settings.nativeAcp.cliPathDesc')
            .replace('{command}', options.defaultCommand))
          .addText(text => text
            .setPlaceholder(options.defaultCommand)
            .setValue(settings.cliPathsByHost[getHostnameKey()] ?? '')
            .onChange(async (value) => {
              const cliPathsByHost = { ...settings.cliPathsByHost };
              if (value.trim()) {
                cliPathsByHost[getHostnameKey()] = value.trim();
              } else {
                delete cliPathsByHost[getHostnameKey()];
              }
              await context.plugin.mutateSettings(pluginSettings => {
                updateNativeAcpProviderSettings(pluginSettings, options.providerId, { cliPathsByHost });
              });
              options.cliResolver.reset();
              context.refreshModelSelectors();
            }));

        new Setting(container).setName(t('settings.models')).setHeading();
        new Setting(container)
          .setName(t('settings.nativeAcp.modelManagementName'))
          .setDesc(t('settings.nativeAcp.modelManagementDesc', {
            provider: options.displayName,
          }));

        new Setting(container).setName(t('settings.safety')).setHeading();
        new Setting(container)
          .setName(t('settings.nativeAcp.permissionHandlingName'))
          .setDesc(t('settings.nativeAcp.permissionHandlingDesc', {
            provider: options.displayName,
          }));
      }

    },
  };
}
