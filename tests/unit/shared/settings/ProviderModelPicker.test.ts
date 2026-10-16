/** @jest-environment jsdom */

import {
  type ProviderModelPickerModel,
  type ProviderModelPickerOptions,
  type ProviderModelPickerState,
  renderProviderModelPicker,
} from '@/shared/settings/ProviderModelPicker';

describe('ProviderModelPicker', () => {
  let container: HTMLDivElement;
  let state: ProviderModelPickerState;
  let onAliasesChange: jest.Mock;
  let onSelectedIdsChange: jest.Mock;

  const models: ProviderModelPickerModel[] = [
    { id: 'claude-3-7-sonnet', name: 'Claude 3.7 Sonnet', providerLabel: 'Anthropic' },
    { id: 'claude-3-5-haiku', name: 'Claude 3.5 Haiku', providerLabel: 'Anthropic' },
  ];

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    state = {
      aliases: { 'claude-3-7-sonnet': 'Sonnet 3.7' },
      discoveredCount: 2,
      models: [...models],
      selectedIds: ['claude-3-7-sonnet', 'claude-3-5-haiku'],
    };
    onAliasesChange = jest.fn().mockImplementation(async (newAliases) => {
      state.aliases = newAliases;
    });
    onSelectedIdsChange = jest.fn().mockImplementation(async (newSelectedIds) => {
      state.selectedIds = newSelectedIds;
    });
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = '';
  });

  function createPicker(overrides?: Partial<ProviderModelPickerOptions>) {
    return renderProviderModelPicker({
      container,
      emptyCatalogText: 'No models',
      failedCatalogText: 'Failed to load',
      getState: () => state,
      loadCatalog: jest.fn().mockResolvedValue('loaded'),
      loadingCatalogText: 'Loading...',
      modifier: 'test',
      onAliasesChange,
      onSelectedIdsChange,
      providerName: 'Claude',
      ...overrides,
    });
  }

  it('sets data-model-id on each selected row', () => {
    createPicker();
    const rows = container.querySelectorAll('.codian-provider-model-picker-selected-row');
    expect(rows).toHaveLength(2);
    expect(rows[0].getAttribute('data-model-id')).toBe('claude-3-7-sonnet');
    expect(rows[1].getAttribute('data-model-id')).toBe('claude-3-5-haiku');
  });

  it('persists alias on blur when changed', () => {
    createPicker();
    const input = container.querySelector(
      '[data-model-id="claude-3-5-haiku"] .codian-provider-model-picker-selected-alias',
    ) as HTMLInputElement;
    expect(input.value).toBe('');
    input.value = 'Haiku';
    input.dispatchEvent(new Event('blur'));

    expect(onAliasesChange).toHaveBeenCalledWith({
      'claude-3-7-sonnet': 'Sonnet 3.7',
      'claude-3-5-haiku': 'Haiku',
    });
  });

  it('preserves focus and caret selection on alias input during refresh', () => {
    const picker = createPicker();
    const input = container.querySelector(
      '[data-model-id="claude-3-7-sonnet"] .codian-provider-model-picker-selected-alias',
    ) as HTMLInputElement;

    input.focus();
    input.setSelectionRange(2, 5);
    expect(document.activeElement).toBe(input);

    picker.refresh();

    const refreshedInput = container.querySelector(
      '[data-model-id="claude-3-7-sonnet"] .codian-provider-model-picker-selected-alias',
    ) as HTMLInputElement;
    expect(document.activeElement).toBe(refreshedInput);
    expect(refreshedInput.selectionStart).toBe(2);
    expect(refreshedInput.selectionEnd).toBe(5);
  });

  it('preserves uncommitted alias drafts during refresh without saving prematurely', () => {
    const picker = createPicker();
    const input = container.querySelector(
      '[data-model-id="claude-3-7-sonnet"] .codian-provider-model-picker-selected-alias',
    ) as HTMLInputElement;

    input.focus();
    input.value = 'Draft In Progress';
    input.setSelectionRange(6, 6);

    picker.refresh();

    const refreshedInput = container.querySelector(
      '[data-model-id="claude-3-7-sonnet"] .codian-provider-model-picker-selected-alias',
    ) as HTMLInputElement;
    expect(document.activeElement).toBe(refreshedInput);
    expect(refreshedInput.value).toBe('Draft In Progress');
    expect(refreshedInput.selectionStart).toBe(6);
    expect(refreshedInput.selectionEnd).toBe(6);
    // Draft was NOT committed on refresh blur
    expect(onAliasesChange).not.toHaveBeenCalled();
  });

  it('restores latest committed alias when Escape is pressed on dirty input', () => {
    createPicker();
    const input = container.querySelector(
      '[data-model-id="claude-3-7-sonnet"] .codian-provider-model-picker-selected-alias',
    ) as HTMLInputElement;

    input.focus();
    input.value = 'Draft to revert';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

    expect(input.value).toBe('Sonnet 3.7');
    expect(onAliasesChange).not.toHaveBeenCalled();
  });

  it('does not re-render or restore focus after being disposed', () => {
    const picker = createPicker();
    const input = container.querySelector(
      '[data-model-id="claude-3-7-sonnet"] .codian-provider-model-picker-selected-alias',
    ) as HTMLInputElement;

    input.focus();
    picker.dispose?.();

    // Now if refresh is called or outside element focused
    picker.refresh();
    expect(onAliasesChange).not.toHaveBeenCalled();
  });

  it('preserves focus on remove control during refresh if model still exists', () => {
    const picker = createPicker();
    const removeBtn = container.querySelector(
      '[data-model-id="claude-3-7-sonnet"] .codian-provider-model-picker-selected-remove',
    ) as HTMLButtonElement;

    removeBtn.focus();
    expect(document.activeElement).toBe(removeBtn);

    picker.refresh();

    const refreshedRemoveBtn = container.querySelector(
      '[data-model-id="claude-3-7-sonnet"] .codian-provider-model-picker-selected-remove',
    ) as HTMLButtonElement;
    expect(document.activeElement).toBe(refreshedRemoveBtn);
  });
});
