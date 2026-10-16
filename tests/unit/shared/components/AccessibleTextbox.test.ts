/** @jest-environment jsdom */

import {
  getAccessibleTextbox,
  InputPopupRelationships,
  registerAccessibleTextbox,
} from '@/shared/components/AccessibleTextbox';

describe('accessible textbox relationships', () => {
  it('resolves the visible textbox and restores the source when registration ends', () => {
    const source = document.createElement('textarea');
    const editor = document.createElement('div');
    expect(getAccessibleTextbox(source)).toBe(source);
    const unregister = registerAccessibleTextbox(source, () => editor);

    expect(getAccessibleTextbox(source)).toBe(editor);

    unregister();

    expect(getAccessibleTextbox(source)).toBe(source);
  });

  it('does not revive a resolver disposed before a newer registration', () => {
    const source = document.createElement('textarea');
    const firstEditor = document.createElement('div');
    const secondEditor = document.createElement('div');
    const unregisterFirst = registerAccessibleTextbox(source, () => firstEditor);
    const unregisterSecond = registerAccessibleTextbox(source, () => secondEditor);

    unregisterFirst();
    expect(getAccessibleTextbox(source)).toBe(secondEditor);
    unregisterSecond();
    expect(getAccessibleTextbox(source)).toBe(source);
  });

  it('moves owned popup relationships when the accessible textbox changes', () => {
    const source = document.createElement('textarea');
    const firstEditor = document.createElement('div');
    const secondEditor = document.createElement('div');
    let activeEditor = firstEditor;
    const unregister = registerAccessibleTextbox(source, () => activeEditor);
    const relationships = new InputPopupRelationships(source);

    relationships.set({
      'aria-autocomplete': 'list',
      'aria-controls': 'suggestions-1',
      'aria-activedescendant': 'suggestion-1',
    });
    expect(firstEditor.getAttribute('aria-controls')).toBe('suggestions-1');

    activeEditor = secondEditor;
    relationships.set({
      'aria-autocomplete': 'list',
      'aria-controls': 'suggestions-1',
      'aria-activedescendant': 'suggestion-2',
    });
    expect(firstEditor.hasAttribute('aria-controls')).toBe(false);
    expect(secondEditor.getAttribute('aria-activedescendant')).toBe('suggestion-2');

    relationships.release();
    expect(secondEditor.hasAttribute('aria-controls')).toBe(false);
    expect(secondEditor.hasAttribute('aria-activedescendant')).toBe(false);
    expect(secondEditor.hasAttribute('aria-autocomplete')).toBe(false);
    unregister();
  });

  it('does not release an attribute claimed later by another popup', () => {
    const source = document.createElement('textarea');
    const first = new InputPopupRelationships(source);
    const second = new InputPopupRelationships(source);

    first.set({ 'aria-autocomplete': 'list', 'aria-controls': 'old-listbox' });
    second.set({ 'aria-autocomplete': 'list', 'aria-controls': 'new-listbox' });
    first.release();

    expect(source.getAttribute('aria-controls')).toBe('new-listbox');
    expect(source.getAttribute('aria-autocomplete')).toBe('list');

    second.release();
    expect(source.hasAttribute('aria-controls')).toBe(false);
    expect(source.hasAttribute('aria-autocomplete')).toBe(false);
  });
});
