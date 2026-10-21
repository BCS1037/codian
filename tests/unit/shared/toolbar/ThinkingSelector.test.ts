import '@/providers';

import { createMockEl } from '@test/helpers/mockElement';

import { ThinkingSelector } from '@/shared/toolbar/ThinkingSelector';
import type { ModelPickerCallbacks, ModelPickerSettings } from '@/shared/toolbar/types';

describe('ThinkingSelector', () => {
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
      getAvailableModels: () => [],
      onModelChange: jest.fn().mockResolvedValue(undefined),
      onEffortLevelChange: jest.fn().mockResolvedValue(undefined),
    };
  });

  afterEach(() => {
    (global as any).document = originalDocument;
  });

  it('renders effort selector with current effort label for adaptive reasoning model', () => {
    const selector = new ThinkingSelector(mockParent, callbacks);
    const container = mockParent.querySelector('.codian-thinking-selector');
    expect(container).not.toBeNull();
    expect(container?.classList.contains('codian-hidden')).toBe(false);

    const current = mockParent.querySelector('.codian-thinking-current');
    expect(current?.textContent).toBe('Medium');

    selector.destroy();
  });

  it('opens options dropdown and selects effort level', () => {
    const selector = new ThinkingSelector(mockParent, callbacks);
    const current = mockParent.querySelector('.codian-thinking-current') as HTMLElement;
    const optionsEl = mockParent.querySelector('.codian-thinking-options') as HTMLElement;

    expect(selector.isOpen()).toBe(false);
    current.click();
    expect(selector.isOpen()).toBe(true);
    expect(optionsEl.classList.contains('visible')).toBe(true);

    const gears = optionsEl.querySelectorAll('.codian-thinking-gear');
    expect(gears.length).toBeGreaterThan(1);

    // Click Low
    const lowGear = Array.from(gears).find(g => g.textContent === 'Low') as HTMLElement;
    expect(lowGear).toBeDefined();
    lowGear.click();

    expect(callbacks.onEffortLevelChange).toHaveBeenCalledWith('low');
    expect(selector.isOpen()).toBe(false);

    selector.destroy();
  });

  it('supports floating layer for dropdown positioning', () => {
    const floatingLayer = createMockEl('div');
    const selector = new ThinkingSelector(mockParent, callbacks, floatingLayer);

    const optionsEl = floatingLayer.querySelector('.codian-thinking-options') as HTMLElement;
    expect(optionsEl).not.toBeNull();

    const removeSpy = jest.spyOn(optionsEl, 'remove');
    selector.destroy();
    expect(removeSpy).toHaveBeenCalled();
  });
});
