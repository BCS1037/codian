import { Notice, setIcon } from 'obsidian';

import { getEnabledProviderForModel } from '../../core/providers/modelRouting';
import { ProviderRegistry } from '../../core/providers/ProviderRegistry';
import { ProviderSettingsCoordinator } from '../../core/providers/ProviderSettingsCoordinator';
import type { ProviderId, ProviderReasoningOption, ProviderUIOption } from '../../core/providers/types';
import { createProviderIconSvg } from '../icons';
import type { ModelPickerCallbacks } from './types';

function runToolbarAction(action: () => Promise<void>, failureMessage: string): void {
  void action().catch(() => {
    new Notice(failureMessage);
  });
}

export class ModelSelector {
  private container: HTMLElement;
  private buttonEl: HTMLElement | null = null;
  private dropdownEl: HTMLElement | null = null;
  private callbacks: ModelPickerCallbacks;
  private floatingLayer: HTMLElement | null = null;
  private outsideClickListener: ((e: MouseEvent) => void) | null = null;
  private keydownListener: ((e: KeyboardEvent) => void) | null = null;

  constructor(
    parentEl: HTMLElement,
    callbacks: ModelPickerCallbacks,
    floatingLayer?: HTMLElement | null,
  ) {
    this.callbacks = callbacks;
    this.floatingLayer = floatingLayer ?? null;
    this.container = parentEl.createDiv({ cls: 'codian-model-selector' });
    this.render();

    this.outsideClickListener = (e: MouseEvent) => {
      const target = e.target as Node | null;
      if (!target) return;
      if (!this.container.contains(target) && !this.dropdownEl?.contains(target)) {
        this.close();
      }
    };
    this.keydownListener = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && this.isOpen()) {
        e.preventDefault();
        e.stopPropagation();
        this.close();
        this.buttonEl?.focus();
      }
    };

    const doc = this.container.ownerDocument ?? window.document;
    doc.addEventListener('click', this.outsideClickListener, true);
    doc.addEventListener('keydown', this.keydownListener, true);
  }

  destroy(): void {
    const doc = this.container.ownerDocument ?? window.document;
    if (this.outsideClickListener) {
      doc.removeEventListener('click', this.outsideClickListener, true);
      this.outsideClickListener = null;
    }
    if (this.keydownListener) {
      doc.removeEventListener('keydown', this.keydownListener, true);
      this.keydownListener = null;
    }
    if (this.floatingLayer && this.dropdownEl) {
      this.dropdownEl.remove();
    }
    this.dropdownEl = null;
    this.buttonEl = null;
    this.container.empty();
  }

  isOpen(): boolean {
    return this.dropdownEl?.classList.contains('visible') ?? false;
  }

  close(): void {
    if (this.dropdownEl) {
      this.dropdownEl.classList.remove('visible');
    }
    if (this.buttonEl) {
      this.buttonEl.setAttribute('aria-expanded', 'false');
    }
  }

  open(): void {
    if (!this.dropdownEl || !this.buttonEl) return;
    this.updateDisplay();
    this.renderOptions();

    if (this.floatingLayer) {
      const rect = this.buttonEl.getBoundingClientRect();
      const doc = this.buttonEl.ownerDocument ?? window.document;
      const view = doc.defaultView ?? window;
      const viewportHeight = view.innerHeight;
      const viewportWidth = view.innerWidth;

      this.dropdownEl.setCssProps({
        '--codian-fixed-dropdown-bottom': `${Math.max(8, viewportHeight - rect.top + 4)}px`,
        '--codian-fixed-dropdown-right': `${Math.max(8, viewportWidth - rect.right)}px`,
      });

      if (rect.right > viewportWidth - 180) {
        this.dropdownEl.classList.add('align-right');
      } else {
        this.dropdownEl.classList.remove('align-right');
      }
    }

    this.dropdownEl.classList.add('visible');
    this.buttonEl.setAttribute('aria-expanded', 'true');
  }

  private getEffortOptions(model: ProviderUIOption): ProviderReasoningOption[] {
    if (typeof this.callbacks.getEffortOptions === 'function') {
      return this.callbacks.getEffortOptions(model);
    }
    const settings = this.callbacks.getSettings();
    const providerId = (model.providerId as ProviderId)
      ?? getEnabledProviderForModel(model.value, settings, settings.providerId);
    if (!ProviderRegistry.getRegisteredProviderIds().includes(providerId)) {
      return [];
    }
    const capabilities = ProviderRegistry.getCapabilities(providerId);
    const uiConfig = ProviderRegistry.getChatUIConfig(providerId);
    const providerSettings = ProviderSettingsCoordinator.getProviderSettingsSnapshot(settings, providerId);
    if (capabilities.reasoningControl !== 'effort'
      || !uiConfig.isAdaptiveReasoningModel(model.value, providerSettings)) {
      return [];
    }
    return uiConfig.getReasoningOptions(model.value, providerSettings);
  }

  private getDisplayLabel(model: ProviderUIOption): string {
    const settings = this.callbacks.getSettings();
    if (model.value !== settings.model) {
      return model.label;
    }

    const effortOptions = this.getEffortOptions(model);
    if (effortOptions.length <= 1) {
      return model.label;
    }

    const currentEffort = settings.reasoning;
    const activeOption = effortOptions.find(option => option.value === currentEffort);
    return activeOption ? `${model.label} (${activeOption.label.toLowerCase()})` : model.label;
  }

  private render(): void {
    this.container.empty();

    this.buttonEl = this.container.createDiv({
      cls: 'codian-model-btn',
      attr: {
        role: 'combobox',
        'aria-haspopup': 'listbox',
        'aria-expanded': 'false',
        tabindex: '0',
      },
    });

    this.buttonEl.addEventListener('click', (e) => {
      e.stopPropagation();
      if (this.isOpen()) {
        this.close();
      } else {
        this.open();
      }
    });

    this.buttonEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown') {
        e.preventDefault();
        this.open();
      }
    });

    const dropdownParent = this.floatingLayer ?? this.container;
    this.dropdownEl = dropdownParent.createDiv({
      cls: 'codian-model-dropdown',
      attr: { role: 'listbox' },
    });

    this.updateDisplay();
    this.renderOptions();
  }

  updateDisplay(): void {
    if (!this.buttonEl) return;
    const settings = this.callbacks.getSettings();
    const currentModel = settings.model;
    const models = this.callbacks.getAvailableModels();
    const modelInfo = models.find(m => m.value === currentModel);
    const displayModel = modelInfo || models[0];

    this.buttonEl.empty();

    const providerId = (displayModel?.providerId as ProviderId)
      ?? getEnabledProviderForModel(displayModel?.value || currentModel, settings, settings.providerId);
    const providerIcon = displayModel?.providerIcon
      ?? (ProviderRegistry.getRegisteredProviderIds().includes(providerId) ? ProviderRegistry.getChatUIConfig(providerId).getProviderIcon?.() : null);

    const iconEl = this.buttonEl.createSpan({ cls: 'codian-model-icon' });
    if (providerIcon) {
      iconEl.appendChild(createProviderIconSvg(providerIcon, {
        className: 'codian-model-provider-icon',
        height: 12,
        ownerDocument: this.buttonEl.ownerDocument,
        width: 12,
      }));
    } else {
      setIcon(iconEl, 'brain');
    }

    const labelEl = this.buttonEl.createSpan({ cls: 'codian-model-label' });
    const labelText = displayModel ? this.getDisplayLabel(displayModel) : 'Unknown';
    labelEl.setText(labelText);

    const chevronEl = this.buttonEl.createSpan({ cls: 'codian-model-chevron' });
    setIcon(chevronEl, 'chevron-up');

    this.buttonEl.setAttribute('aria-label', labelText);
    this.buttonEl.setAttribute('title', labelText);
  }

  renderOptions(): void {
    if (!this.dropdownEl) return;
    this.dropdownEl.empty();

    const settings = this.callbacks.getSettings();
    const currentModel = settings.model;
    const models = this.callbacks.getAvailableModels();

    let lastGroup: string | undefined;
    for (const model of models) {
      if (model.group && model.group !== lastGroup) {
        const separator = this.dropdownEl.createDiv({ cls: 'codian-model-group' });
        separator.setText(model.group);
        lastGroup = model.group;
      }

      const option = this.dropdownEl.createDiv({
        cls: 'codian-model-option',
        attr: {
          role: 'option',
          'aria-selected': String(model.value === currentModel),
        },
      });
      if (model.value === currentModel) {
        option.addClass('selected');
      }

      const modelProvider = (model.providerId as ProviderId)
        ?? getEnabledProviderForModel(model.value, settings, settings.providerId);
      const icon = model.providerIcon
        ?? (ProviderRegistry.getRegisteredProviderIds().includes(modelProvider) ? ProviderRegistry.getChatUIConfig(modelProvider).getProviderIcon?.() : null);
      if (icon) {
        option.appendChild(createProviderIconSvg(icon, {
          className: 'codian-model-provider-icon',
          height: 12,
          ownerDocument: option.ownerDocument,
          width: 12,
        }));
      }

      option.createSpan({ cls: 'codian-model-option-text', text: model.label });
      if (model.description) {
        option.setAttribute('title', model.description);
      }

      const effortOptions = this.getEffortOptions(model);
      if (effortOptions.length > 1) {
        this.renderEffortSubmenu(option, model, modelProvider, effortOptions);
      }

      option.addEventListener('click', (e) => {
        e.stopPropagation();
        this.close();
        runToolbarAction(async () => {
          await this.callbacks.onModelChange(model.value, modelProvider);
          this.updateDisplay();
          this.renderOptions();
        }, 'Failed to change model');
      });
    }
  }

  private renderEffortSubmenu(
    optionEl: HTMLElement,
    model: ProviderUIOption,
    providerId: ProviderId,
    effortOptions: ProviderReasoningOption[],
  ): void {
    optionEl.addClass('codian-model-option-with-effort');
    optionEl.createSpan({ cls: 'codian-model-effort-chevron', text: '›' });
    const submenuEl = optionEl.createDiv({ cls: 'codian-model-effort-options' });
    const settings = this.callbacks.getSettings();
    const currentModel = settings.model;
    const currentEffort = settings.reasoning;

    for (const effort of effortOptions) {
      const effortEl = submenuEl.createDiv({ cls: 'codian-model-effort-option' });
      effortEl.setText(effort.label);
      if (model.value === currentModel && effort.value === currentEffort) {
        effortEl.addClass('selected');
      }
      if (effort.description) {
        effortEl.setAttribute('title', effort.description);
      }
      effortEl.addEventListener('click', (event) => {
        event.stopPropagation();
        this.close();
        runToolbarAction(async () => {
          await this.callbacks.onModelChange(model.value, providerId);
          await this.callbacks.onEffortLevelChange(effort.value);
          this.updateDisplay();
          this.renderOptions();
        }, 'Failed to change model effort');
      });
    }
  }
}
