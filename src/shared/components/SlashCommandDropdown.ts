import { t } from '@/i18n/i18n';

import { getBuiltInCommandsForDropdown } from '../../core/commands/builtInCommands';
import type { ProviderCommandDropdownConfig } from '../../core/providers/commands/ProviderCommandCatalog';
import type { ProviderCommandDiscoveryResult } from '../../core/providers/commands/ProviderCommandDiscoveryResult';
import {
  type ProviderCommandDiscoverySnapshot,
  type ProviderCommandDiscoverySource,
  ProviderCommandDiscoveryStore,
} from '../../core/providers/commands/ProviderCommandDiscoveryStore';
import type { ProviderCommandEntry } from '../../core/providers/commands/ProviderCommandEntry';
import type { ProviderId } from '../../core/providers/types';
import type { SlashCommand } from '../../core/types';
import { normalizeArgumentHint } from '../../utils/slashCommand';
import { InputPopupRelationships } from './AccessibleTextbox';

let nextSlashListboxId = 0;

interface DropdownItem {
  name: string;
  description?: string;
  argumentHint?: string;
  content: string;
  displayPrefix: string;
  insertPrefix: string;
  isBuiltIn: boolean;
  slashCommand?: SlashCommand;
  providerEntry?: ProviderCommandEntry;
}

export interface SlashCommandDropdownCallbacks {
  onSelect: (command: SlashCommand) => void;
  onHide: () => void;
}

export interface SlashCommandDropdownOptions {
  fixed?: boolean;
  hiddenCommands?: Set<string>;
  /** Whether to include Codian chat-action built-ins such as /clear and /fast. */
  includeBuiltIns?: boolean;
  /** Active provider identity, independent of optional catalog availability. */
  providerId?: ProviderId;
  providerConfig?: ProviderCommandDropdownConfig;
  /** Provider-protocol discovery state owned by the active chat tab. */
  providerDiscovery?: ProviderCommandDiscoverySource<ProviderCommandEntry>;
}

type ProviderDiscoveryViewState = Exclude<
  ProviderCommandDiscoverySnapshot<ProviderCommandEntry>,
  { status: 'idle' }
>;

export class SlashCommandDropdown {
  private containerEl: HTMLElement;
  private dropdownEl: HTMLElement | null = null;
  private inputEl: HTMLTextAreaElement | HTMLInputElement;
  private readonly listboxId = `codian-slash-listbox-${++nextSlashListboxId}`;
  private readonly inputRelationships: InputPopupRelationships;
  private callbacks: SlashCommandDropdownCallbacks;
  private enabled = true;
  private onInput: () => void;
  private triggerStartIndex = -1;
  private activeTriggerChar = '/';
  private selectedIndex = 0;
  private filteredItems: DropdownItem[] = [];
  private isFixed: boolean;
  private includeBuiltIns: boolean;
  private hiddenCommands: Set<string>;

  private providerId: ProviderId | null;
  private providerConfig: ProviderCommandDropdownConfig | null;
  private providerDiscovery: ProviderCommandDiscoverySource<ProviderCommandEntry> | null = null;
  private providerDiscoveryUnsubscribe: (() => void) | null = null;
  private cachedProviderEntries: ProviderCommandEntry[] = [];
  private providerDiscoveryState: ProviderDiscoveryViewState | null = null;

  constructor(
    containerEl: HTMLElement,
    inputEl: HTMLTextAreaElement | HTMLInputElement,
    callbacks: SlashCommandDropdownCallbacks,
    options: SlashCommandDropdownOptions = {}
  ) {
    this.containerEl = containerEl;
    this.inputEl = inputEl;
    this.inputRelationships = new InputPopupRelationships(inputEl);
    this.callbacks = callbacks;
    this.isFixed = options.fixed ?? false;
    this.includeBuiltIns = options.includeBuiltIns ?? true;
    this.hiddenCommands = options.hiddenCommands ?? new Set();
    this.providerId = options.providerId ?? options.providerConfig?.providerId ?? null;
    this.providerConfig = options.providerConfig ?? null;
    this.bindProviderDiscovery(options.providerDiscovery ?? null);

    this.onInput = () => this.handleInputChange();
    this.inputEl.addEventListener('input', this.onInput);
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) {
      this.hide();
    }
  }

  setHiddenCommands(commands: Set<string>): void {
    this.hiddenCommands = commands;
  }

  setProviderCatalog(
    config: ProviderCommandDropdownConfig,
    providerDiscovery:
      | ProviderCommandDiscoverySource<ProviderCommandEntry>
      | (() => Promise<ProviderCommandDiscoveryResult<ProviderCommandEntry>>),
  ): void {
    this.clearProviderView();
    this.providerId = config.providerId;
    this.providerConfig = config;
    this.resetProviderViewState();
    const discovery = typeof providerDiscovery === 'function'
      ? new ProviderCommandDiscoveryStore(providerDiscovery)
      : providerDiscovery;
    this.bindProviderDiscovery(discovery);
  }

  setProviderId(providerId: ProviderId): void {
    this.providerId = providerId;
  }

  clearProviderCatalog(): void {
    this.clearProviderView();
    this.providerConfig = null;
    this.resetProviderViewState();
    this.bindProviderDiscovery(null);
  }

  handleInputChange(): void {
    if (!this.enabled) return;

    const text = this.getInputValue();
    const cursorPos = this.getCursorPosition();
    const textBeforeCursor = text.substring(0, cursorPos);
    const triggerChars = this.providerConfig?.triggerChars ?? ['/'];

    // Scan backward from cursor for the nearest valid trigger char.
    // Valid trigger: at position 0, or preceded by whitespace.
    let triggerIndex = -1;
    let triggerChar = '';

    for (let i = cursorPos - 1; i >= 0; i--) {
      const ch = textBeforeCursor.charAt(i);
      if (/\s/.test(ch)) break;
      if (triggerChars.includes(ch)) {
        if (i === 0 || /\s/.test(textBeforeCursor.charAt(i - 1))) {
          triggerIndex = i;
          triggerChar = ch;
        }
        break;
      }
    }

    if (triggerIndex === -1) {
      this.hide();
      return;
    }

    const searchText = textBeforeCursor.substring(triggerIndex + 1);

    if (/\s/.test(searchText)) {
      this.hide();
      return;
    }

    this.triggerStartIndex = triggerIndex;
    this.activeTriggerChar = triggerChar;
    const isAtPosition0 = triggerIndex === 0;
    void this.showDropdown(searchText, isAtPosition0);
  }

  handleKeydown(e: KeyboardEvent): boolean {
    if (!this.enabled || !this.isVisible()) return false;

    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        this.navigate(1);
        return true;
      case 'ArrowUp':
        e.preventDefault();
        this.navigate(-1);
        return true;
      case 'Enter':
      case 'Tab':
        if (this.filteredItems.length > 0) {
          e.preventDefault();
          this.selectItem();
          return true;
        }
        return false;
      case 'Escape':
        e.preventDefault();
        this.hide();
        return true;
    }
    return false;
  }

  isVisible(): boolean {
    return this.dropdownEl?.hasClass('visible') ?? false;
  }

  hide(): void {
    if (this.dropdownEl) {
      this.dropdownEl.removeClass('visible');
    }
    this.inputRelationships.release();
    this.triggerStartIndex = -1;
    this.callbacks.onHide();
  }

  destroy(): void {
    this.inputRelationships.release();
    this.providerDiscoveryUnsubscribe?.();
    this.providerDiscoveryUnsubscribe = null;
    this.providerDiscovery = null;
    this.inputEl.removeEventListener('input', this.onInput);
    if (this.dropdownEl) {
      this.dropdownEl.remove();
      this.dropdownEl = null;
    }
  }

  resetProviderViewState(): void {
    this.cachedProviderEntries = [];
    this.providerDiscoveryState = null;
  }

  /** Compatibility alias for older tab state integrations. */
  resetSdkSkillsCache(): void {
    this.resetProviderViewState();
  }

  private bindProviderDiscovery(
    providerDiscovery: ProviderCommandDiscoverySource<ProviderCommandEntry> | null,
  ): void {
    this.providerDiscoveryUnsubscribe?.();
    this.providerDiscovery = providerDiscovery;
    this.providerDiscoveryUnsubscribe = providerDiscovery?.subscribe(() => {
      if (this.isVisible()) {
        this.handleInputChange();
      }
    }) ?? null;
  }

  private clearProviderView(): void {
    this.filteredItems = [];
    this.hide();
    this.dropdownEl?.empty();
  }

  private getInputValue(): string {
    return this.inputEl.value;
  }

  private getCursorPosition(): number {
    return this.inputEl.selectionStart || 0;
  }

  private setInputValue(value: string): void {
    this.inputEl.value = value;
  }

  private setCursorPosition(pos: number): void {
    this.inputEl.selectionStart = pos;
    this.inputEl.selectionEnd = pos;
  }

  private showDropdown(searchText: string, isAtPosition0 = true): void {
    const searchLower = searchText.toLowerCase();
    const includeBuiltIns = this.includeBuiltIns
      && isAtPosition0
      && this.activeTriggerChar === '/';

    if (this.providerDiscovery) {
      const snapshot = this.providerDiscovery.getSnapshot();
      if (snapshot.status === 'idle') {
        this.providerDiscoveryState = { status: 'loading' };
        this.cachedProviderEntries = [];
        this.updateFilteredItems(searchLower, includeBuiltIns);
        this.render();
        void this.providerDiscovery.load().catch(() => {});
        return;
      }

      this.providerDiscoveryState = snapshot;
      this.cachedProviderEntries = snapshot.status === 'ready' ? [...snapshot.items] : [];
      this.updateFilteredItems(searchLower, includeBuiltIns);
      this.finishRender(searchText);
      return;
    }

    this.updateFilteredItems(searchLower, includeBuiltIns);
    this.finishRender(searchText);
  }

  private updateFilteredItems(searchLower: string, includeBuiltIns: boolean): void {
    this.filteredItems = this.buildItemList(includeBuiltIns)
      .filter(item =>
        item.name.toLowerCase().includes(searchLower)
        || item.description?.toLowerCase().includes(searchLower)
      )
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  private finishRender(searchText: string): void {
    const hasProviderState = this.providerDiscoveryState?.status !== 'ready'
      && this.providerDiscoveryState !== null;
    if (searchText.length > 0 && this.filteredItems.length === 0 && !hasProviderState) {
      this.hide();
      return;
    }

    this.selectedIndex = 0;
    this.render();
  }

  private buildItemList(includeBuiltIns: boolean): DropdownItem[] {
    const seenNames = new Set<string>();
    const items: DropdownItem[] = [];

    if (includeBuiltIns) {
      const builtIns = getBuiltInCommandsForDropdown(this.providerId ?? undefined);
      for (const cmd of builtIns) {
        const nameLower = cmd.name.toLowerCase();
        if (!seenNames.has(nameLower)) {
          seenNames.add(nameLower);
          items.push({
            name: cmd.name,
            description: cmd.description,
            argumentHint: cmd.argumentHint,
            content: cmd.content,
            displayPrefix: '/',
            insertPrefix: '/',
            isBuiltIn: true,
            slashCommand: cmd,
          });
        }
      }
    }

    for (const entry of this.cachedProviderEntries) {
      const nameLower = entry.name.toLowerCase();
      if (seenNames.has(nameLower) || this.hiddenCommands.has(nameLower)) {
        continue;
      }
      seenNames.add(nameLower);
      items.push({
        name: entry.name,
        description: entry.description,
        argumentHint: entry.argumentHint,
        content: entry.content,
        displayPrefix: entry.displayPrefix,
        insertPrefix: entry.insertPrefix,
        isBuiltIn: false,
        providerEntry: entry,
        slashCommand: {
          id: entry.id,
          name: entry.name,
          description: entry.description,
          content: entry.content,
          argumentHint: entry.argumentHint,
          allowedTools: entry.allowedTools,
          model: entry.model,
          source: entry.source,
          kind: entry.kind,
          disableModelInvocation: entry.disableModelInvocation,
          userInvocable: entry.userInvocable,
          context: entry.context,
          agent: entry.agent,
          hooks: entry.hooks,
        },
      });
    }

    return items;
  }

  private render(): void {
    if (!this.dropdownEl) {
      this.dropdownEl = this.createDropdownElement();
    }

    const hasOptions = this.filteredItems.length > 0;
    if (hasOptions) {
      this.dropdownEl.setAttribute('id', this.listboxId);
      this.dropdownEl.setAttribute('role', 'listbox');
      this.dropdownEl.setAttribute('aria-label', t('common.inputSuggestions'));
    } else {
      this.dropdownEl.removeAttribute('id');
      this.dropdownEl.removeAttribute('role');
      this.dropdownEl.removeAttribute('aria-label');
    }

    this.dropdownEl.empty();

    if (this.filteredItems.length === 0 && !this.providerDiscoveryState) {
      const emptyEl = this.dropdownEl.createDiv({ cls: 'codian-slash-empty' });
      emptyEl.setText('No matching commands');
    } else {
      for (let i = 0; i < this.filteredItems.length; i++) {
        const item = this.filteredItems[i];
        const itemEl = this.dropdownEl.createDiv({ cls: 'codian-slash-item' });
        itemEl.setAttribute('id', `${this.listboxId}-option-${i}`);
        itemEl.setAttribute('role', 'option');
        itemEl.setAttribute('aria-selected', String(i === this.selectedIndex));

        if (i === this.selectedIndex) {
          itemEl.addClass('selected');
        }

        const nameEl = itemEl.createSpan({ cls: 'codian-slash-name' });
        nameEl.setText(`${item.displayPrefix}${item.name}`);

        if (item.argumentHint) {
          const hintEl = itemEl.createSpan({ cls: 'codian-slash-hint' });
          hintEl.setText(normalizeArgumentHint(item.argumentHint));
        }

        if (item.description) {
          const descEl = itemEl.createDiv({ cls: 'codian-slash-desc' });
          descEl.setText(item.description);
        }

        itemEl.addEventListener('click', () => {
          this.selectedIndex = i;
          this.selectItem();
        });

        itemEl.addEventListener('mouseenter', () => {
          this.selectedIndex = i;
          this.updateSelection();
        });
      }
    }

    this.renderProviderDiscoveryState();

    this.dropdownEl.addClass('visible');
    this.syncInputRelationships();

    if (this.isFixed) {
      this.positionFixed();
    }
  }

  private renderProviderDiscoveryState(): void {
    if (!this.dropdownEl || !this.providerDiscoveryState) return;

    const state = this.providerDiscoveryState;
    if (state.status === 'ready') return;

    const stateEl = this.dropdownEl.createDiv({
      cls: `codian-slash-provider-state is-${state.status}`,
    });
    const messageEl = stateEl.createSpan({ cls: 'codian-slash-provider-state-message' });

    switch (state.status) {
      case 'loading':
        messageEl.setText(t('chat.suggestions.providerLoading'));
        break;
      case 'empty':
        messageEl.setText('No provider commands advertised');
        break;
      case 'requires-session':
        messageEl.setText(state.message);
        break;
      case 'error': {
        messageEl.setText(state.message);
        const retryEl = stateEl.createEl('button', {
          cls: 'codian-slash-provider-retry',
          text: t('common.retry'),
          attr: { type: 'button' },
        });
        retryEl.addEventListener('click', () => {
          void this.providerDiscovery?.retry().catch(() => {});
        });
        break;
      }
    }
  }

  private createDropdownElement(): HTMLElement {
    if (this.isFixed) {
      return this.containerEl.createDiv({
        cls: 'codian-slash-dropdown codian-slash-dropdown-fixed',
      });
    } else {
      return this.containerEl.createDiv({ cls: 'codian-slash-dropdown' });
    }
  }

  private positionFixed(): void {
    if (!this.dropdownEl || !this.isFixed) return;

    const inputRect = this.inputEl.getBoundingClientRect();
    this.dropdownEl.setCssProps({
      '--codian-fixed-dropdown-bottom': `${window.innerHeight - inputRect.top + 4}px`,
      '--codian-fixed-dropdown-left': `${inputRect.left}px`,
      '--codian-fixed-dropdown-width': `${Math.max(inputRect.width, 280)}px`,
    });
  }

  private navigate(direction: number): void {
    const maxIndex = this.filteredItems.length - 1;
    this.selectedIndex = Math.max(0, Math.min(maxIndex, this.selectedIndex + direction));
    this.updateSelection();
  }

  private updateSelection(): void {
    const items = this.dropdownEl?.querySelectorAll('.codian-slash-item');
    items?.forEach((item, index) => {
      if (index === this.selectedIndex) {
        item.addClass('selected');
        (item as HTMLElement).scrollIntoView({ block: 'nearest' });
      } else {
        item.removeClass('selected');
      }
      item.setAttribute('aria-selected', String(index === this.selectedIndex));
    });
    this.syncInputRelationships();
  }

  private syncInputRelationships(): void {
    if (!this.isVisible() || this.filteredItems.length === 0) {
      this.inputRelationships.release();
      return;
    }

    const activeOptionId = this.filteredItems[this.selectedIndex]
      ? `${this.listboxId}-option-${this.selectedIndex}`
      : undefined;
    this.inputRelationships.set({
      'aria-autocomplete': 'list',
      'aria-controls': this.listboxId,
      ...(activeOptionId ? { 'aria-activedescendant': activeOptionId } : {}),
    });
  }

  private selectItem(): void {
    if (this.filteredItems.length === 0) return;

    const selected = this.filteredItems[this.selectedIndex];
    if (!selected) return;

    const text = this.getInputValue();
    const beforeTrigger = text.substring(0, this.triggerStartIndex);
    const afterCursor = text.substring(this.getCursorPosition());
    const replacement = `${selected.insertPrefix}${selected.name} `;

    this.setInputValue(beforeTrigger + replacement + afterCursor);
    this.setCursorPosition(beforeTrigger.length + replacement.length);

    this.hide();
    if (selected.slashCommand) {
      this.callbacks.onSelect(selected.slashCommand);
    }
    this.inputEl.focus();
  }
}
