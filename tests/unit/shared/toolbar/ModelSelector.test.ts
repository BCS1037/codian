import '@/providers';

import { createMockEl } from '@test/helpers/mockElement';

import { ModelSelector } from '@/shared/toolbar/ModelSelector';
import type { ModelPickerCallbacks, ModelPickerSettings } from '@/shared/toolbar/types';

describe('ModelSelector', () => {
  let originalDocument: any;
  let mockParent: HTMLElement;
  let callbacks: ModelPickerCallbacks;
  let currentSettings: ModelPickerSettings;

  beforeEach(() => {
    originalDocument = (global as any).document;
    (global as any).document = {
      body: createMockEl('body'),
      createElement: (tagName: string) => createMockEl(tagName),
      addEventListener: jest.fn(),
      removeEventListener: jest.fn(),
    };

    mockParent = createMockEl('div');
    currentSettings = {
      providerId: 'claude',
      model: 'haiku',
      reasoning: 'medium',
    };

    callbacks = {
      getSettings: () => currentSettings,
      getAvailableModels: () => [
        { value: 'haiku', label: 'Claude 3.5 Haiku', group: 'Claude', providerId: 'claude' },
        { value: 'sonnet', label: 'Claude 3.5 Sonnet', group: 'Claude', providerId: 'claude' },
        { value: 'gpt-4o', label: 'GPT-4o', group: 'Codex', providerId: 'codex' },
      ],
      onModelChange: jest.fn().mockResolvedValue(undefined),
      onEffortLevelChange: jest.fn().mockResolvedValue(undefined),
    };
  });

  afterEach(() => {
    (global as any).document = originalDocument;
  });

  it('renders model button with active model label and icon', () => {
    const selector = new ModelSelector(mockParent, callbacks);
    const btn = mockParent.querySelector('.codian-model-btn');
    expect(btn).not.toBeNull();
    expect(btn?.querySelector('.codian-model-label')?.textContent).toBe('Claude 3.5 Haiku (medium)');

    selector.destroy();
  });

  it('opens and closes dropdown on button click', () => {
    const selector = new ModelSelector(mockParent, callbacks);
    const btn = mockParent.querySelector('.codian-model-btn') as HTMLElement;
    const dropdown = mockParent.querySelector('.codian-model-dropdown') as HTMLElement;

    expect(selector.isOpen()).toBe(false);
    btn.click();
    expect(selector.isOpen()).toBe(true);
    expect(dropdown.classList.contains('visible')).toBe(true);

    btn.click();
    expect(selector.isOpen()).toBe(false);
    expect(dropdown.classList.contains('visible')).toBe(false);

    selector.destroy();
  });

  it('renders options grouped by provider with options selection', async () => {
    const selector = new ModelSelector(mockParent, callbacks);
    selector.open();

    const dropdown = mockParent.querySelector('.codian-model-dropdown') as HTMLElement;
    const groups = dropdown.querySelectorAll('.codian-model-group');
    expect(groups.length).toBe(2);
    expect(groups[0].textContent).toBe('Claude');
    expect(groups[1].textContent).toBe('Codex');

    const options = dropdown.querySelectorAll('.codian-model-option');
    expect(options.length).toBe(3);

    // Click third option (gpt-4o from Codex)
    (options[2] as HTMLElement).click();
    expect(callbacks.onModelChange).toHaveBeenCalledWith('gpt-4o', 'codex');
    expect(selector.isOpen()).toBe(false);

    selector.destroy();
  });

  it('supports floating layer for dropdown positioning', () => {
    const floatingLayer = createMockEl('div');
    const selector = new ModelSelector(mockParent, callbacks, floatingLayer);

    const dropdown = floatingLayer.querySelector('.codian-model-dropdown') as HTMLElement;
    expect(dropdown).not.toBeNull();

    const removeSpy = jest.spyOn(dropdown, 'remove');
    selector.destroy();
    expect(removeSpy).toHaveBeenCalled();
  });
});
