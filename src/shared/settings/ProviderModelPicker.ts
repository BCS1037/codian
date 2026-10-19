import { t } from '../../i18n/i18n';

const ALL_PROVIDERS_KEY = 'all';

export interface ProviderModelPickerModel {
  aliasPlaceholder?: string;
  catalogBadge?: string;
  description?: string;
  id: string;
  isAvailable?: boolean;
  name: string;
  providerKey?: string;
  providerLabel?: string;
  unavailableMessage?: string;
  unavailableTitle?: string;
}

export interface ProviderModelPickerState {
  aliases: Record<string, string>;
  discoveredCount: number;
  models: ProviderModelPickerModel[];
  selectedIds: string[];
}

export interface ProviderModelPickerController {
  refresh(): void;
  dispose?(): void;
}

export interface ProviderModelPickerOptions {
  checkCatalogFreshnessWhenCached?: boolean;
  container: HTMLElement;
  emptyCatalogText: string;
  failedCatalogText: string;
  getState(): ProviderModelPickerState;
  initiallyOpen?: boolean;
  loadCatalog(force: boolean): Promise<'empty' | 'failed' | 'loaded'>;
  loadCatalogOnRender?: boolean;
  loadingCatalogText: string;
  modifier: string;
  onAliasesChange(aliases: Record<string, string>): Promise<void>;
  onModelSelected?(model: ProviderModelPickerModel): Promise<void>;
  onSelectedIdsChange(selectedIds: string[]): Promise<void>;
  providerName: string;
  searchPlaceholder?: string;
}

export function renderProviderModelPicker(
  options: ProviderModelPickerOptions,
): ProviderModelPickerController {
  const pickerEl = options.container.createDiv({
    cls: `codian-provider-model-picker codian-provider-model-picker--${options.modifier}`,
  });
  let searchQuery = '';
  let providerFilter = ALL_PROVIDERS_KEY;
  let loadingCatalog = false;
  let catalogLoadFailed = false;
  let disposed = false;
  let renderingSelected = false;

  const selectedEl = pickerEl.createDiv({ cls: 'codian-provider-model-picker-selected' });
  const catalogEl = pickerEl.createEl('details', { cls: 'codian-provider-model-picker-catalog' });
  catalogEl.open = options.initiallyOpen ?? options.getState().selectedIds.length === 0;

  const catalogSummaryEl = catalogEl.createEl('summary', {
    cls: 'codian-provider-model-picker-catalog-summary',
  });
  catalogSummaryEl.createSpan({
    cls: 'codian-provider-model-picker-catalog-caret',
    text: '▸',
  });
  catalogSummaryEl.createSpan({
    cls: 'codian-provider-model-picker-catalog-title',
    text: t('settings.providerModels.browse'),
  });
  const catalogSummaryCountEl = catalogSummaryEl.createSpan({
    cls: 'codian-provider-model-picker-catalog-count',
  });

  const controlsEl = catalogEl.createDiv({ cls: 'codian-provider-model-picker-controls' });
  const searchInput = controlsEl.createEl('input', {
    cls: 'codian-provider-model-picker-search',
    type: 'search',
  });
  searchInput.placeholder = options.searchPlaceholder ?? t('settings.providerModels.searchPlaceholder');
  searchInput.addEventListener('input', () => {
    searchQuery = searchInput.value.trim().toLowerCase();
    renderList();
  });

  const providerSelectEl = controlsEl.createEl('select', {
    cls: 'codian-provider-model-picker-provider',
  });
  providerSelectEl.addEventListener('change', () => {
    providerFilter = providerSelectEl.value;
    renderList();
  });

  const catalogActionEl = controlsEl.createEl('button', {
    cls: 'codian-provider-model-picker-action',
    text: t('settings.providerModels.discover'),
  });
  catalogActionEl.setAttribute('type', 'button');
  catalogActionEl.addEventListener('click', () => {
    void loadCatalog(true);
  });

  const listEl = catalogEl.createDiv({ cls: 'codian-provider-model-picker-list' });

  const renderCatalogStatus = (): void => {
    const state = options.getState();
    catalogSummaryCountEl.setText(
      loadingCatalog
        ? t('settings.providerModels.loadingModels')
        : state.discoveredCount > 0
        ? t('settings.providerModels.available', { count: state.discoveredCount })
        : t('settings.providerModels.noneDiscovered'),
    );
    catalogActionEl.disabled = loadingCatalog;
    catalogActionEl.setText(
      loadingCatalog
        ? t('settings.providerModels.loading')
        : state.discoveredCount > 0
        ? t('settings.providerModels.refresh')
        : t('settings.providerModels.discover'),
    );
  };

  const persistAlias = async (modelId: string, value: string): Promise<void> => {
    const state = options.getState();
    const existing = state.aliases[modelId] ?? '';
    const next = value.trim();
    if (next === existing) {
      return;
    }

    const aliases = { ...state.aliases };
    if (next) {
      aliases[modelId] = next;
    } else {
      delete aliases[modelId];
    }
    await options.onAliasesChange(aliases);
    renderSelected();
  };

  const renderSelectedRows = (): void => {
    selectedEl.empty();
    const state = options.getState();
    if (state.selectedIds.length === 0) {
      selectedEl.toggleClass('codian-hidden', true);
      return;
    }

    selectedEl.toggleClass('codian-hidden', false);
    const modelsById = new Map(state.models.map(model => [model.id, model] as const));
    const headerEl = selectedEl.createDiv({ cls: 'codian-provider-model-picker-selected-header' });
    headerEl.createSpan({
      cls: 'codian-provider-model-picker-selected-label',
      text: t('settings.providerModels.selected', { count: state.selectedIds.length }),
    });
    const clearAllButton = headerEl.createEl('button', {
      cls: 'codian-provider-model-picker-selected-clear',
      text: t('settings.providerModels.clearAll'),
    });
    clearAllButton.setAttribute('type', 'button');
    clearAllButton.setAttribute(
      'aria-label',
      t('settings.providerModels.clearAllAria', { provider: options.providerName }),
    );
    clearAllButton.addEventListener('click', () => {
      void persistSelectedIds([]);
    });

    const rowsEl = selectedEl.createDiv({ cls: 'codian-provider-model-picker-selected-rows' });
    for (const modelId of state.selectedIds) {
      const model = modelsById.get(modelId) ?? {
        id: modelId,
        isAvailable: false,
        name: modelId,
      };
      const defaultLabel = model.aliasPlaceholder
        ?? (model.providerLabel ? `${model.providerLabel}/${model.name}` : model.name);
      const rowEl = rowsEl.createDiv({ cls: 'codian-provider-model-picker-selected-row' });
      rowEl.setAttribute('data-model-id', modelId);
      if (model.isAvailable === false) {
        rowEl.classList.add('codian-provider-model-picker-selected-row--unavailable');
      }

      const infoEl = rowEl.createDiv({ cls: 'codian-provider-model-picker-selected-info' });
      const titleEl = infoEl.createDiv({ cls: 'codian-provider-model-picker-selected-title' });
      if (model.providerLabel) {
        titleEl.createSpan({
          cls: 'codian-provider-model-picker-selected-badge',
          text: model.providerLabel,
        });
      }
      titleEl.createSpan({
        cls: 'codian-provider-model-picker-selected-name',
        text: model.name,
      });
      if (model.isAvailable === false && model.unavailableMessage) {
        infoEl.createDiv({
          cls: 'codian-provider-model-picker-selected-unavailable',
          text: model.unavailableMessage,
        });
      }
      infoEl.createDiv({
        cls: 'codian-provider-model-picker-selected-id',
        text: model.id,
      });

      const rowControlsEl = rowEl.createDiv({ cls: 'codian-provider-model-picker-selected-controls' });
      const aliasInput = rowControlsEl.createEl('input', {
        cls: 'codian-provider-model-picker-selected-alias',
        type: 'text',
      });
      aliasInput.placeholder = defaultLabel;
      aliasInput.value = aliasInput.defaultValue = state.aliases[model.id] ?? '';
      aliasInput.setAttribute('aria-label', t('settings.providerModels.aliasAria', { model: defaultLabel }));
      aliasInput.title = t('settings.providerModels.aliasTitle');
      aliasInput.addEventListener('blur', () => {
        if (!renderingSelected) void persistAlias(model.id, aliasInput.value);
      });
      aliasInput.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          aliasInput.blur();
        } else if (event.key === 'Escape') {
          event.preventDefault();
          aliasInput.value = options.getState().aliases[model.id] ?? '';
          aliasInput.blur();
        }
      });

      const removeButton = rowControlsEl.createEl('button', {
        cls: 'codian-provider-model-picker-selected-remove',
        text: '×',
      });
      removeButton.setAttribute('type', 'button');
      removeButton.setAttribute('aria-label', t('settings.providerModels.removeAria', { model: defaultLabel }));
      removeButton.addEventListener('click', () => {
        void persistSelectedIds(options.getState().selectedIds.filter(id => id !== model.id));
      });
    }
  };

  const renderSelected = (): void => {
    if (disposed) return;
    // Read current focus at render time, never from an earlier asynchronous action.
    const doc = selectedEl.ownerDocument ?? (typeof activeDocument !== 'undefined' ? activeDocument : undefined);
    const activeElement = doc?.activeElement;
    const active = typeof selectedEl.contains === 'function' && activeElement && selectedEl.contains(activeElement)
      ? activeElement as HTMLElement : null;
    const modelId = typeof active?.closest === 'function' ? active.closest('[data-model-id]')?.getAttribute('data-model-id') : null;
    const control = ['alias', 'drag', 'remove', 'clear'].find(kind =>
      active?.classList?.contains(`codian-provider-model-picker-selected-${kind}`));
    const input = control === 'alias' ? active as HTMLInputElement : null;
    const draft = input && input.value !== input.defaultValue ? input.value : null;
    const selection = input ? [input.selectionStart, input.selectionEnd, input.selectionDirection] as const : null;

    // Native removal can blur a dirty input; a render must not commit its draft.
    renderingSelected = true;
    try {
      renderSelectedRows();
      if (!control || typeof selectedEl.querySelectorAll !== 'function') return;
      const row = modelId ? [...selectedEl.querySelectorAll<HTMLElement>('[data-model-id]')]
        .find(element => element.getAttribute('data-model-id') === modelId) : selectedEl;
      const replacement = typeof row?.querySelector === 'function'
        ? row.querySelector<HTMLElement>(`.codian-provider-model-picker-selected-${control}`) : null;
      if (replacement?.isConnected && !disposed) {
        if (control === 'alias' && selection) {
          const alias = replacement as HTMLInputElement;
          if (draft !== null) alias.value = draft;
          alias.setSelectionRange(selection[0], selection[1], selection[2] ?? undefined);
        }
        replacement.focus({ preventScroll: true });
      }
    } finally {
      renderingSelected = false;
    }
  };

  const renderProviderSelect = (): void => {
    const providers = new Map<string, { count: number; label: string }>();
    const models = options.getState().models;
    for (const model of models) {
      if (!model.providerKey || !model.providerLabel) {
        continue;
      }
      const existing = providers.get(model.providerKey);
      if (existing) {
        existing.count += 1;
      } else {
        providers.set(model.providerKey, { count: 1, label: model.providerLabel });
      }
    }

    providerSelectEl.toggleClass('codian-hidden', providers.size === 0);
    providerSelectEl.empty();
    providerSelectEl.createEl('option', {
      text: t('settings.providerModels.allProviders', { count: models.length }),
      value: ALL_PROVIDERS_KEY,
    });
    for (const [key, { count, label }] of Array.from(providers.entries())
      .sort(([, left], [, right]) => left.label.localeCompare(right.label))) {
      providerSelectEl.createEl('option', {
        text: `${label} (${count})`,
        value: key,
      });
    }

    if (providerFilter !== ALL_PROVIDERS_KEY && !providers.has(providerFilter)) {
      providerFilter = ALL_PROVIDERS_KEY;
    }
    providerSelectEl.value = providerFilter;
  };

  const matchesFilter = (model: ProviderModelPickerModel): boolean => {
    if (providerFilter !== ALL_PROVIDERS_KEY && model.providerKey !== providerFilter) {
      return false;
    }
    if (!searchQuery) {
      return true;
    }

    return [model.id, model.name, model.providerLabel ?? '', model.description ?? '']
      .some(value => value.toLowerCase().includes(searchQuery));
  };

  const persistSelectedIds = async (selectedIds: string[]): Promise<void> => {
    await options.onSelectedIdsChange(selectedIds);
    renderAll();
  };

  const renderList = (): void => {
    listEl.empty();
    const state = options.getState();
    const selectedIds = new Set(state.selectedIds);
    const models = state.models.filter(matchesFilter);

    if (models.length === 0) {
      listEl.createDiv({
        cls: 'codian-provider-model-picker-empty',
        text: loadingCatalog
          ? options.loadingCatalogText
          : catalogLoadFailed
          ? options.failedCatalogText
          : state.models.length === 0
          ? options.emptyCatalogText
          : t('settings.providerModels.noMatches'),
      });
      return;
    }

    for (const model of models) {
      const rowEl = listEl.createEl('label', { cls: 'codian-provider-model-picker-row' });
      const isSelected = selectedIds.has(model.id);
      if (isSelected) {
        rowEl.classList.add('codian-provider-model-picker-row--selected');
      }
      rowEl.title = model.id;

      const checkboxEl = rowEl.createEl('input', { type: 'checkbox' });
      checkboxEl.checked = isSelected;
      const persistSelection = async (): Promise<void> => {
        const selecting = checkboxEl.checked;
        const currentIds = options.getState().selectedIds;
        const nextIds = selecting
          ? [...currentIds, model.id]
          : currentIds.filter(id => id !== model.id);
        await persistSelectedIds(nextIds);
        if (selecting) {
          await options.onModelSelected?.(model);
        }
      };
      checkboxEl.addEventListener('change', () => {
        void persistSelection();
      });

      const textEl = rowEl.createDiv({ cls: 'codian-provider-model-picker-row-text' });
      const headerEl = textEl.createDiv({ cls: 'codian-provider-model-picker-row-header' });
      headerEl.createSpan({
        cls: 'codian-provider-model-picker-row-name',
        text: model.name,
      });
      const badgeLabel = model.isAvailable === false
        ? 'Unavailable'
        : model.catalogBadge ?? model.providerLabel;
      if (badgeLabel) {
        const badgeEl = headerEl.createSpan({
          cls: 'codian-provider-model-picker-row-badge',
          text: badgeLabel,
        });
        if (model.isAvailable === false) {
          badgeEl.classList.add('codian-provider-model-picker-row-badge--unavailable');
          badgeEl.title = model.unavailableTitle ?? `Configured model not currently reported by ${options.providerName}`;
        }
      }
      textEl.createDiv({
        cls: 'codian-provider-model-picker-row-meta',
        text: model.id,
      });
      if (model.description) {
        textEl.createDiv({
          cls: 'codian-provider-model-picker-row-desc',
          text: model.description,
        });
      }
    }
  };

  const renderAll = (): void => {
    if (disposed) return;
    renderCatalogStatus();
    renderSelected();
    renderProviderSelect();
    renderList();
  };

  const loadCatalog = async (force: boolean): Promise<void> => {
    if (
      disposed
      || loadingCatalog
      || (
        !force
        && !options.checkCatalogFreshnessWhenCached
        && options.getState().discoveredCount > 0
      )
    ) {
      return;
    }

    loadingCatalog = true;
    catalogLoadFailed = false;
    renderAll();
    try {
      catalogLoadFailed = await options.loadCatalog(force) === 'failed';
    } catch {
      catalogLoadFailed = true;
    } finally {
      loadingCatalog = false;
      renderAll();
    }
  };

  renderAll();
  catalogEl.addEventListener('toggle', () => {
    if (catalogEl.open) {
      void loadCatalog(false);
    }
  });
  if (options.loadCatalogOnRender) {
    void loadCatalog(false);
  }
  return {
    refresh: renderAll,
    dispose() {
      disposed = true;
    },
  };
}
