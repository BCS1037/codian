import { ButtonComponent, Modal, Notice, SecretComponent, Setting } from 'obsidian';

import { ProviderSettingsCoordinator } from '../../../core/providers/ProviderSettingsCoordinator';
import type { ProviderSettingsTabRendererContext } from '../../../core/providers/types';
import { t } from '../../../i18n/i18n';
import { confirm } from '../../../shared/modals/ConfirmModal';
import { testClaudeServiceConnection } from '../services/ClaudeServiceConnection';
import {
  type ClaudeServiceAuthMode,
  type ClaudeServicePresetId,
  type ClaudeThirdPartyService,
  decodeClaudeServiceModelSelection,
  encodeClaudeServiceModelSelection,
  getClaudeServicePresets,
  resolveClaudeServicePreset,
} from '../services/ClaudeThirdPartyServices';
import { getClaudeProviderSettings, updateClaudeProviderSettings } from '../settings';

type ServiceDraft = ClaudeThirdPartyService;

function createServiceDraft(): ServiceDraft {
  const id = crypto.randomUUID();
  const preset = resolveClaudeServicePreset('custom');
  return {
    id,
    name: preset.name,
    preset: preset.id,
    baseUrl: preset.baseUrl,
    authMode: preset.authMode,
    secretId: '',
    defaultModel: '',
    lightweightModel: '',
    enabled: true,
    advancedEnvironmentVariables: '',
  };
}

function validateService(draft: ServiceDraft, context: ProviderSettingsTabRendererContext): string | null {
  if (!draft.name.trim()) return t('settings.claudeServices.validation.name');
  if (!draft.baseUrl.trim()) return t('settings.claudeServices.validation.url');
  try {
    const url = new URL(draft.baseUrl.trim());
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))) {
      return t('settings.claudeServices.validation.https');
    }
  } catch {
    return t('settings.claudeServices.validation.url');
  }
  if (!draft.secretId || !context.plugin.app.secretStorage.getSecret(draft.secretId)) {
    return t('settings.claudeServices.validation.secret');
  }
  if (!draft.defaultModel.trim()) return t('settings.claudeServices.validation.defaultModel');
  if (!draft.lightweightModel.trim()) return t('settings.claudeServices.validation.lightModel');
  return null;
}

class ClaudeServiceModal extends Modal {
  private draft: ServiceDraft;
  private readonly isNew: boolean;

  constructor(
    app: ProviderSettingsTabRendererContext['plugin']['app'],
    service: ClaudeThirdPartyService | null,
    private context: ProviderSettingsTabRendererContext,
    private onSave: (service: ClaudeThirdPartyService) => Promise<void>,
  ) {
    super(app);
    this.isNew = service === null;
    this.draft = service ? { ...service } : createServiceDraft();
  }

  onOpen(): void {
    this.renderForm();
  }

  private renderForm(): void {
    this.contentEl.empty();
    this.setTitle(t(this.isNew ? 'settings.claudeServices.modal.add' : 'settings.claudeServices.modal.edit'));

    new Setting(this.contentEl)
      .setName(t('settings.claudeServices.fields.preset'))
      .addDropdown(dropdown => {
        for (const preset of getClaudeServicePresets()) {
          dropdown.addOption(preset.id, preset.name);
        }
        dropdown.setValue(this.draft.preset).onChange(value => {
          const preset = resolveClaudeServicePreset(value as ClaudeServicePresetId);
          this.draft = {
            ...this.draft,
            preset: preset.id,
            name: preset.id === 'custom' ? this.draft.name : preset.name,
            baseUrl: preset.id === 'custom' ? this.draft.baseUrl : preset.baseUrl,
            authMode: preset.authMode,
          };
          this.renderForm();
        });
      });

    new Setting(this.contentEl)
      .setName(t('settings.claudeServices.fields.name'))
      .addText(text => text.setValue(this.draft.name).onChange(value => { this.draft.name = value; }));

    new Setting(this.contentEl)
      .setName(t('settings.claudeServices.fields.url'))
      .setDesc(t('settings.claudeServices.fields.urlDesc'))
      .addText(text => text.setValue(this.draft.baseUrl).onChange(value => { this.draft.baseUrl = value; }));

    new Setting(this.contentEl)
      .setName(t('settings.claudeServices.fields.auth'))
      .addDropdown(dropdown => dropdown
        .addOption('auth-token', t('settings.claudeServices.auth.bearer'))
        .addOption('api-key', t('settings.claudeServices.auth.apiKey'))
        .setValue(this.draft.authMode)
        .onChange(value => { this.draft.authMode = value as ClaudeServiceAuthMode; }));

    new Setting(this.contentEl)
      .setName(t('settings.claudeServices.fields.secret'))
      .setDesc(t('settings.claudeServices.fields.secretDesc'))
      .addComponent(element => new SecretComponent(this.app, element)
        .setValue(this.draft.secretId)
        .onChange(value => { this.draft.secretId = value; }));

    new Setting(this.contentEl)
      .setName(t('settings.claudeServices.fields.defaultModel'))
      .addText(text => text.setValue(this.draft.defaultModel).onChange(value => { this.draft.defaultModel = value; }));

    new Setting(this.contentEl)
      .setName(t('settings.claudeServices.fields.lightModel'))
      .setDesc(t('settings.claudeServices.fields.lightModelDesc'))
      .addText(text => text.setValue(this.draft.lightweightModel).onChange(value => { this.draft.lightweightModel = value; }));

    const actions = this.contentEl.createDiv({ cls: 'claudian-settings-action-row' });
    new ButtonComponent(actions)
      .setButtonText(t('common.cancel'))
      .onClick(() => this.close());
    new ButtonComponent(actions)
      .setCta()
      .setButtonText(t('common.save'))
      .onClick(async () => {
        const error = validateService(this.draft, this.context);
        if (error) {
          new Notice(error);
          return;
        }
        await this.onSave({
          ...this.draft,
          name: this.draft.name.trim(),
          baseUrl: this.draft.baseUrl.trim().replace(/\/$/, ''),
          defaultModel: this.draft.defaultModel.trim(),
          lightweightModel: this.draft.lightweightModel.trim(),
        });
        this.close();
      });
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

async function persistServices(
  context: ProviderSettingsTabRendererContext,
  services: ClaudeThirdPartyService[],
  defaultServiceId?: string,
): Promise<void> {
  await context.plugin.mutateSettings(settings => {
    const current = getClaudeProviderSettings(settings);
    const requestedDefaultId = defaultServiceId ?? current.defaultThirdPartyServiceId;
    const defaultService = services.find(service => (
      service.id === requestedDefaultId && service.enabled
    )) ?? services.find(service => service.enabled) ?? null;
    updateClaudeProviderSettings(settings, {
      thirdPartyServices: services,
      defaultThirdPartyServiceId: defaultService?.id ?? '',
    });
    if (defaultService && (defaultServiceId !== undefined || requestedDefaultId !== defaultService.id)) {
      const selection = encodeClaudeServiceModelSelection(
        defaultService.id,
        defaultService.defaultModel,
      );
      settings.savedProviderModel = { ...settings.savedProviderModel, claude: selection };
      if (settings.settingsProvider === 'claude') {
        settings.model = selection;
      }
    }
    ProviderSettingsCoordinator.normalizeAllModelVariants(settings);
    ProviderSettingsCoordinator.reconcileTitleGenerationModelSelection(settings);
  });
  await context.plugin.recycleProviderRuntimes?.('claude');
  context.refreshModelSelectors();
  context.refreshTitleGenerationModelOptions();
}

export function renderClaudeServiceSettings(
  container: HTMLElement,
  context: ProviderSettingsTabRendererContext,
): void {
  const settings = getClaudeProviderSettings(context.plugin.settings);
  const section = container.createDiv({ cls: 'claudian-claude-services' });
  new Setting(section)
    .setName(t('settings.claudeServices.heading'))
    .setDesc(t('settings.claudeServices.description'))
    .setHeading();

  const list = section.createDiv({ cls: 'claudian-claude-service-list' });
  if (settings.thirdPartyServices.length === 0) {
    list.createDiv({
      cls: 'claudian-settings-empty-state',
      text: t('settings.claudeServices.empty'),
    });
  }

  const refresh = (): void => {
    const nextSibling = section.nextSibling;
    section.remove();
    renderClaudeServiceSettings(container, context);
    const renderedSection = container.lastElementChild;
    if (nextSibling && renderedSection) {
      container.insertBefore(renderedSection, nextSibling);
    }
  };
  for (const service of settings.thirdPartyServices) {
    const row = list.createDiv({ cls: 'claudian-claude-service-row' });
    const copy = row.createDiv({ cls: 'claudian-claude-service-copy' });
    copy.createDiv({ cls: 'claudian-claude-service-name', text: service.name });
    copy.createDiv({
      cls: 'claudian-claude-service-meta',
      text: `${service.defaultModel} · ${service.baseUrl}`,
    });
    const actions = row.createDiv({ cls: 'claudian-claude-service-actions' });

    new ButtonComponent(actions)
      .setButtonText(service.enabled
        ? t('settings.claudeServices.disable')
        : t('settings.claudeServices.enable'))
      .onClick(async () => {
        const services = settings.thirdPartyServices.map(item => item.id === service.id
          ? { ...item, enabled: !item.enabled }
          : item);
        await persistServices(context, services);
        refresh();
      });

    new ButtonComponent(actions)
      .setButtonText(t('settings.claudeServices.test'))
      .onClick(async () => {
        const secret = context.plugin.app.secretStorage.getSecret(service.secretId);
        if (!secret) {
          new Notice(t('settings.claudeServices.validation.secret'));
          return;
        }
        new Notice(t('settings.claudeServices.testing'));
        try {
          const result = await testClaudeServiceConnection(service, secret);
          new Notice(t('settings.claudeServices.testSuccess', { latency: result.latencyMs }));
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          new Notice(t('settings.claudeServices.testFailed', { error: message }));
        }
      });

    new ButtonComponent(actions)
      .setButtonText(t('common.edit'))
      .onClick(() => new ClaudeServiceModal(context.plugin.app, service, context, async updated => {
        const services = settings.thirdPartyServices.map(item => item.id === updated.id ? updated : item);
        await persistServices(context, services);
        refresh();
      }).open());

    new ButtonComponent(actions)
      .setButtonText(t('common.delete'))
      .setWarning()
      .onClick(async () => {
        const selections = await context.getConversationModelSelections?.() ?? [];
        const referenced = selections.some(selection => (
          decodeClaudeServiceModelSelection(selection)?.serviceId === service.id
        )) ?? false;
        if (referenced) {
          new Notice(t('settings.claudeServices.deleteReferenced'));
          return;
        }
        if (!await confirm(context.plugin.app, t('settings.claudeServices.deleteConfirm'), t('common.delete'))) {
          return;
        }
        const services = settings.thirdPartyServices.filter(item => item.id !== service.id);
        await persistServices(context, services,
          settings.defaultThirdPartyServiceId === service.id ? '' : settings.defaultThirdPartyServiceId);
        refresh();
      });

    if (service.enabled) {
      new ButtonComponent(actions)
        .setButtonText(settings.defaultThirdPartyServiceId === service.id
          ? t('settings.claudeServices.defaultActive')
          : t('settings.claudeServices.setDefault'))
        .setDisabled(settings.defaultThirdPartyServiceId === service.id)
        .onClick(async () => {
          await context.plugin.mutateSettings(target => {
            const selection = encodeClaudeServiceModelSelection(service.id, service.defaultModel);
            target.savedProviderModel = {
              ...target.savedProviderModel,
              claude: selection,
            };
            if (target.settingsProvider === 'claude') {
              target.model = selection;
            }
            updateClaudeProviderSettings(target, { defaultThirdPartyServiceId: service.id });
          });
          context.refreshModelSelectors();
          refresh();
        });
    }
  }

  const footer = section.createDiv({ cls: 'claudian-settings-action-row' });
  new ButtonComponent(footer)
    .setCta()
    .setButtonText(t('settings.claudeServices.add'))
    .onClick(() => new ClaudeServiceModal(context.plugin.app, null, context, async service => {
      const services = [...settings.thirdPartyServices, service];
      await persistServices(context, services,
        settings.defaultThirdPartyServiceId || service.id);
      refresh();
    }).open());
  footer.createDiv({ cls: 'setting-item-description', text: t('settings.claudeServices.costNotice') });
}
