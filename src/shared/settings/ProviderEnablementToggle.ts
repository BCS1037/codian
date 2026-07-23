import { Notice, type ToggleComponent } from 'obsidian';

import {
  type ProviderEnablementResult,
  ProviderSettingsCoordinator,
} from '../../core/providers/ProviderSettingsCoordinator';
import type {
  ProviderId,
  ProviderSettingsTabRendererContext,
} from '../../core/providers/types';
import { t } from '../../i18n/i18n';

export async function applyProviderEnablementToggle(
  context: ProviderSettingsTabRendererContext,
  toggle: ToggleComponent,
  providerId: ProviderId,
  enabled: boolean,
): Promise<boolean> {
  const applied = await applyProviderEnablement(context, providerId, enabled);
  if (!applied) {
    toggle.setValue(true);
  }
  return applied;
}

export async function applyProviderEnablement(
  context: ProviderSettingsTabRendererContext,
  providerId: ProviderId,
  enabled: boolean,
): Promise<boolean> {
  const result: { value: ProviderEnablementResult } = { value: 'applied' };

  await context.plugin.mutateSettings((settings) => {
    result.value = ProviderSettingsCoordinator.applyProviderEnablement(
      settings,
      providerId,
      enabled,
    );
  });

  if (result.value === 'last-enabled-provider') {
    new Notice(t('settings.providerEnablement.atLeastOne'));
    return false;
  }

  context.refreshModelSelectors();
  context.refreshTitleGenerationModelOptions();
  return true;
}
