/** @jest-environment jsdom */

import { readFileSync } from 'node:fs';
import path from 'node:path';

describe('inline-edit.css', () => {
  let styles: HTMLStyleElement[] = [];

  beforeEach(() => {
    styles = ['base/variables.css', 'features/inline-edit.css'].map((file) => {
      const style = document.createElement('style');
      style.textContent = readFileSync(path.resolve('src/style', file), 'utf8');
      document.head.appendChild(style);
      return style;
    });
  });

  afterEach(() => {
    document.body.replaceChildren();
    for (const style of styles) style.remove();
  });

  function mountComposer(): HTMLElement {
    const container = document.createElement('div');
    container.className = 'codian-inline-input-container';
    container.innerHTML = '<div class="codian-inline-composer">'
      + '<div class="codian-inline-input-wrap">'
      + '<input class="codian-inline-input" type="text" />'
      + '<div class="codian-inline-spinner"></div>'
      + '</div></div>';
    document.body.appendChild(container);
    return container;
  }

  it('spins in the Obsidian accent rather than the provider brand', () => {
    const spinner = mountComposer().querySelector<HTMLElement>('.codian-inline-spinner')!;

    expect(window.getComputedStyle(spinner).borderTopColor).toBe('var(--interactive-accent)');
  });

  it('keeps the review gutter bars inside the widget box, which Obsidian clips', () => {
    document.body.innerHTML = '<div class="codian-inline-diff-preview"><div class="codian-inline-diff-preview-body">'
      + '<div class="codian-diff-block codian-diff-del"></div></div></div>';

    for (const selector of ['.codian-inline-diff-preview-body', '.codian-diff-block']) {
      const style = window.getComputedStyle(document.querySelector(selector)!);
      expect(`${style.marginLeft} ${style.getPropertyValue('margin-inline')}`).not.toMatch(/-\d/);
    }
  });

  it('separates the composer from the selected text below with padding, since Obsidian zeroes widget margins', () => {
    const host = document.createElement('style');
    host.textContent = '.markdown-source-view.mod-cm6 .cm-content > * { margin: 0 !important; }';
    document.head.appendChild(host);
    for (const style of styles) document.head.appendChild(style);
    styles.push(host);
    document.body.innerHTML = '<div class="markdown-source-view mod-cm6"><div class="cm-content">'
      + '<div class="codian-inline-input-container" contenteditable="false"></div></div></div>';
    const composer = window.getComputedStyle(document.querySelector('.codian-inline-input-container')!);

    expect(parseFloat(composer.marginBottom || '0') + parseFloat(composer.paddingBottom || '0')).toBeGreaterThanOrEqual(8);
  });
});
