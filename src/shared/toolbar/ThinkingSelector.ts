import { Notice } from 'obsidian';

import { getEnabledProviderForModel } from '../../core/providers/modelRouting';
import { ProviderRegistry } from '../../core/providers/ProviderRegistry';
import { ProviderSettingsCoordinator } from '../../core/providers/ProviderSettingsCoordinator';
import type { ProviderReasoningOption } from '../../core/providers/types';
import type { ModelPickerCallbacks } from './types';

function runToolbarAction(action: () => Promise<void>, failureMessage: string): void {
  void action().catch(() => {
    new Notice(failureMessage);
  });
}

export class ThinkingSelector {
  private container: HTMLElement;
  private effortEl: HTMLElement | null = null;
  private effortGearsEl: HTMLElement | null = null;
  private currentEl: HTMLElement | null = null;
  private optionsEl: HTMLElement | null = null;
  private callbacks: ModelPickerCallbacks;
  private floatingLayer: HTMLElement | null = null;
  private outsideClickListener: ((e: MouseEvent) => void) | null = null;

  constructor(
    parentEl: HTMLElement,
    callbacks: ModelPickerCallbacks,
    floatingLayer?: HTMLElement | null,
  ) {
    this.callbacks = callbacks;
    this.floatingLayer = floatingLayer ?? null;
    this.container = parentEl.createDiv({ cls: 'codian-thinking-selector' });
    this.render();

    this.outsideClickListener = (e: MouseEvent) => {
      const target = e.target as Node | null;
      if (!target) return;
      if (!this.container.contains(target) && !this.optionsEl?.contains(target)) {
        this.close();
      }
    };
    const doc = this.container.ownerDocument ?? window.document;
    doc.addEventListener('click', this.outsideClickListener, true);
  }

  destroy(): void {
    const doc = this.container.ownerDocument ?? window.document;
    if (this.outsideClickListener) {
      doc.removeEventListener('click', this.outsideClickListener, true);
      this.outsideClickListener = null;
    }
    if (this.floatingLayer && this.optionsEl) {
      this.optionsEl.remove();
    }
    this.optionsEl = null;
    this.container.empty();
  }

  isOpen(): boolean {
    return this.optionsEl?.classList.contains('visible') ?? false;
  }

  close(): void {
    if (this.optionsEl) {
      this.optionsEl.classList.remove('visible');
    }
  }

  open(): void {
    if (!this.optionsEl || !this.currentEl) return;
    this.renderEffortGears();

    if (this.floatingLayer) {
      const rect = this.currentEl.getBoundingClientRect();
      const doc = this.currentEl.ownerDocument ?? window.document;
      const view = doc.defaultView ?? window;
      const viewportHeight = view.innerHeight;
      const viewportWidth = view.innerWidth;

      this.optionsEl.setCssProps({
        '--codian-fixed-dropdown-bottom': `${Math.max(8, viewportHeight - rect.top + 4)}px`,
        '--codian-fixed-dropdown-right': `${Math.max(8, viewportWidth - rect.right)}px`,
      });
    }

    this.optionsEl.classList.add('visible');
  }

  private getCurrentEffortOptions(): ProviderReasoningOption[] {
    const settings = this.callbacks.getSettings();
    const providerId = settings.providerId
      ?? getEnabledProviderForModel(settings.model, settings);
    if (!ProviderRegistry.getRegisteredProviderIds().includes(providerId)) {
      return [];
    }
    const capabilities = ProviderRegistry.getCapabilities(providerId);
    const uiConfig = ProviderRegistry.getChatUIConfig(providerId);
    const providerSettings = ProviderSettingsCoordinator.getProviderSettingsSnapshot(settings, providerId);
    if (capabilities.reasoningControl !== 'effort'
      || !uiConfig.isAdaptiveReasoningModel(settings.model, providerSettings)) {
      return [];
    }
    return uiConfig.getReasoningOptions(settings.model, providerSettings);
  }

  private render(): void {
    this.container.empty();

    this.effortEl = this.container.createDiv({ cls: 'codian-thinking-effort' });
    const effortLabel = this.effortEl.createSpan({ cls: 'codian-thinking-label-text' });
    effortLabel.setText('Effort:');
    this.effortGearsEl = this.effortEl.createDiv({ cls: 'codian-thinking-gears' });

    this.currentEl = this.effortGearsEl.createDiv({
      cls: 'codian-thinking-current',
      attr: { role: 'button', tabindex: '0' },
    });

    this.currentEl.addEventListener('click', (e) => {
      e.stopPropagation();
      if (this.isOpen()) {
        this.close();
      } else {
        this.open();
      }
    });

    const optionsParent = this.floatingLayer ?? this.effortGearsEl;
    this.optionsEl = optionsParent.createDiv({ cls: 'codian-thinking-options' });

    this.updateDisplay();
  }

  updateDisplay(): void {
    const options = this.getCurrentEffortOptions();
    if (options.length <= 1) {
      this.container.addClass('codian-hidden');
      this.close();
      return;
    }

    this.container.removeClass('codian-hidden');
    const settings = this.callbacks.getSettings();
    const currentEffort = settings.reasoning;
    const currentInfo = options.find(e => e.value === currentEffort);
    const label = currentInfo?.label || options[0]?.label || 'High';
    this.currentEl?.setText(label);
    this.renderEffortGears();
  }

  private renderEffortGears(): void {
    if (!this.optionsEl) return;
    this.optionsEl.empty();

    const options = this.getCurrentEffortOptions();
    const settings = this.callbacks.getSettings();
    const currentEffort = settings.reasoning;

    for (const effort of [...options].reverse()) {
      const gearEl = this.optionsEl.createDiv({ cls: 'codian-thinking-gear' });
      gearEl.setText(effort.label);
      if (effort.description) {
        gearEl.setAttribute('title', effort.description);
      }
      if (effort.value === currentEffort) {
        gearEl.addClass('selected');
      }

      gearEl.addEventListener('click', (e) => {
        e.stopPropagation();
        this.close();
        runToolbarAction(async () => {
          await this.callbacks.onEffortLevelChange(effort.value);
          this.updateDisplay();
        }, 'Failed to change effort level');
      });
    }
  }
}
