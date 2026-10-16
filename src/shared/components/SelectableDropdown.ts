import { InputPopupRelationships } from './AccessibleTextbox';

let nextSelectableListboxId = 0;

export interface SelectableDropdownOptions {
  listClassName: string;
  itemClassName: string;
  emptyClassName: string;
  ariaLabel?: string;
  fixed?: boolean;
  fixedClassName?: string;
  inputEl?: HTMLElement;
}

export interface SelectableDropdownRenderOptions<T> {
  items: T[];
  selectedIndex: number;
  emptyText: string;
  renderItem: (item: T, itemEl: HTMLElement) => void;
  getItemClass?: (item: T) => string | string[] | undefined;
  onItemClick?: (item: T, index: number, e: MouseEvent) => void;
  onItemHover?: (item: T, index: number) => void;
}

export class SelectableDropdown<T> {
  private containerEl: HTMLElement;
  private dropdownEl: HTMLElement | null = null;
  private options: SelectableDropdownOptions;
  private readonly listboxId = `codian-selectable-listbox-${++nextSelectableListboxId}`;
  private readonly inputRelationships: InputPopupRelationships | null;
  private items: T[] = [];
  private itemEls: HTMLElement[] = [];
  private selectedIndex = 0;
  private hasListboxSemantics = false;

  constructor(containerEl: HTMLElement, options: SelectableDropdownOptions) {
    this.containerEl = containerEl;
    this.options = options;
    this.inputRelationships = options.inputEl ? new InputPopupRelationships(options.inputEl) : null;
  }

  isVisible(): boolean {
    return this.dropdownEl?.hasClass('visible') ?? false;
  }

  getElement(): HTMLElement | null {
    return this.dropdownEl;
  }

  getSelectedIndex(): number {
    return this.selectedIndex;
  }

  getSelectedItem(): T | null {
    return this.items[this.selectedIndex] ?? null;
  }

  getItems(): T[] {
    return this.items;
  }

  hide(): void {
    if (this.dropdownEl) {
      this.dropdownEl.removeClass('visible');
    }
    this.inputRelationships?.release();
  }

  destroy(): void {
    this.inputRelationships?.release();
    if (this.dropdownEl) {
      this.dropdownEl.remove();
      this.dropdownEl = null;
    }
  }

  render(options: SelectableDropdownRenderOptions<T>): void {
    this.items = options.items;
    this.selectedIndex = options.selectedIndex;

    if (!this.dropdownEl) {
      this.dropdownEl = this.createDropdownElement();
    }

    this.hasListboxSemantics = this.syncListboxSemantics(options.items.length > 0);
    this.dropdownEl.empty();
    this.itemEls = [];

    if (options.items.length === 0) {
      const emptyEl = this.dropdownEl.createDiv({ cls: this.options.emptyClassName });
      emptyEl.setText(options.emptyText);
    } else {
      for (let i = 0; i < options.items.length; i++) {
        const item = options.items[i];
        const itemEl = this.dropdownEl.createDiv({ cls: this.options.itemClassName });
        if (this.hasListboxSemantics) {
          itemEl.setAttribute('id', `${this.listboxId}-option-${i}`);
          itemEl.setAttribute('role', 'option');
          itemEl.setAttribute('aria-selected', String(i === this.selectedIndex));
        }

        const extraClass = options.getItemClass?.(item);
        if (Array.isArray(extraClass)) {
          extraClass.forEach(cls => itemEl.addClass(cls));
        } else if (extraClass) {
          itemEl.addClass(extraClass);
        }

        if (i === this.selectedIndex) {
          itemEl.addClass('selected');
        }

        options.renderItem(item, itemEl);

        itemEl.addEventListener('click', (e) => {
          this.selectedIndex = i;
          this.updateSelection();
          options.onItemClick?.(item, i, e);
        });

        itemEl.addEventListener('mouseenter', () => {
          this.selectedIndex = i;
          this.updateSelection();
          options.onItemHover?.(item, i);
        });

        this.itemEls.push(itemEl);
      }
    }

    this.dropdownEl.addClass('visible');
    this.syncInputRelationships();
  }

  updateSelection(): void {
    this.itemEls.forEach((itemEl, index) => {
      if (index === this.selectedIndex) {
        itemEl.addClass('selected');
        itemEl.scrollIntoView({ block: 'nearest' });
      } else {
        itemEl.removeClass('selected');
      }
      if (this.hasListboxSemantics) {
        itemEl.setAttribute('aria-selected', String(index === this.selectedIndex));
      }
    });
    this.syncInputRelationships();
  }

  moveSelection(delta: number): void {
    const maxIndex = this.items.length - 1;
    this.selectedIndex = Math.max(0, Math.min(maxIndex, this.selectedIndex + delta));
    this.updateSelection();
  }

  private createDropdownElement(): HTMLElement {
    const className = this.options.fixed && this.options.fixedClassName
      ? `${this.options.listClassName} ${this.options.fixedClassName}`
      : this.options.listClassName;

    return this.containerEl.createDiv({ cls: className });
  }

  private syncListboxSemantics(hasOptions: boolean): boolean {
    if (!this.dropdownEl) return false;

    if (!hasOptions || !this.options.ariaLabel) {
      this.dropdownEl.removeAttribute('role');
      this.dropdownEl.removeAttribute('aria-label');
      this.dropdownEl.removeAttribute('id');
      return false;
    }

    this.dropdownEl.setAttribute('role', 'listbox');
    this.dropdownEl.setAttribute('aria-label', this.options.ariaLabel);
    this.dropdownEl.setAttribute('id', this.listboxId);
    return true;
  }

  private syncInputRelationships(): void {
    if (!this.inputRelationships || !this.hasListboxSemantics || !this.isVisible()) {
      this.inputRelationships?.release();
      return;
    }

    const activeOptionId = this.items[this.selectedIndex] === undefined
      ? undefined
      : `${this.listboxId}-option-${this.selectedIndex}`;
    this.inputRelationships.set({
      'aria-autocomplete': 'list',
      'aria-controls': this.listboxId,
      ...(activeOptionId ? { 'aria-activedescendant': activeOptionId } : {}),
    });
  }
}
