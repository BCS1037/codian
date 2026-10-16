/**
 * @jest-environment jsdom
 */
import { Component, loadMermaid, MarkdownRenderer } from 'obsidian';

import { MessageRenderer } from '@/features/chat/rendering/MessageRenderer';

HTMLElement.prototype.empty = function () { this.replaceChildren(); };

const source = 'graph TD\nA --> B\n';
const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 50"><path d="M0 0L100 50"/></svg>';
const render = jest.fn();
let renderer: MessageRenderer;
let host: HTMLElement;

beforeEach(() => {
  document.body.replaceChildren();
  host = document.body.createDiv();
  renderer = new MessageRenderer({ app: {}, settings: { mediaFolder: '' } } as any,
    new Component(), host);
  render.mockReset().mockResolvedValue({ svg });
  jest.mocked(loadMermaid).mockResolvedValue({ render });
  jest.mocked(MarkdownRenderer.render).mockImplementation(async (_app, markdown, target) => {
    // Obsidian boundary fixture: preserve the neutralized language and native copy control.
    const language = markdown.match(/codian-display-only-fence-\d+/)?.[0];
    const pre = (target as HTMLElement).createEl('pre');
    pre.createEl('code', { cls: `language-${language}`, text: source });
    pre.createEl('button', { text: 'Copy', cls: 'copy-code-button', attr: { type: 'button' } });
  });
});

afterEach(() => renderer.dispose());

it.each(['mermaid', 'Mermaid', 'MERMAID'])('renders %s directly and retains accessible source', async language => {
  await renderer.renderContent(host, `\`\`\`${language}\n${source}\`\`\``);
  const img = host.querySelector<HTMLImageElement>('img[alt="Mermaid diagram"]');
  expect(img).not.toBeNull();
  expect(img!.getAttribute('src')).toContain('data:image/svg+xml');
  expect(render).toHaveBeenCalledWith(expect.any(String), source, expect.any(HTMLElement));

  const toggle = host.querySelector<HTMLButtonElement>('button[aria-label="Show diagram source"]');
  expect(toggle).not.toBeNull();
  expect(toggle!.getAttribute('type')).toBe('button');
  expect(toggle!.hasAttribute('title')).toBe(false);
  expect(host.querySelector('.copy-code-button')!.closest('[hidden]')).not.toBeNull();

  toggle!.focus();
  expect(document.activeElement).toBe(toggle);

  toggle!.click();
  expect(host.querySelector('img[alt="Mermaid diagram"]')!.hasAttribute('hidden')).toBe(true);
  expect(host.querySelector('button[aria-label="Show diagram"]')).toBeNull();
  expect(host.querySelector('.copy-code-button')!.closest('[hidden]')).toBeNull();

  const outside = document.body.createEl('button', { text: 'Outside' });
  outside.focus();
  const diagram = host.querySelector<HTMLElement>('.codian-mermaid');
  const sourceDiv = diagram?.querySelector<HTMLElement>('div[tabindex="-1"]');
  sourceDiv?.dispatchEvent(new FocusEvent('focusout', { relatedTarget: outside }));

  expect(host.querySelector('img[alt="Mermaid diagram"]')!.hasAttribute('hidden')).toBe(false);
  expect(host.querySelector('.copy-code-button')!.closest('[hidden]')).not.toBeNull();
  expect(jest.mocked(MarkdownRenderer.render).mock.calls.at(-1)?.[1]).not.toMatch(/```mermaid/i);
});

it('renders HTML-serialized label markup as a well-formed SVG image', async () => {
  // Mermaid serializes HTML labels with HTML rules: void `<br>` and named entities are not XML.
  render.mockResolvedValue({
    svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 50"><foreignObject width="100" height="50">'
      + '<div xmlns="http://www.w3.org/1999/xhtml"><span class="nodeLabel"><p>First line<br>Second&nbsp;line</p>'
      + '</span></div></foreignObject></svg>',
  });
  await renderer.renderContent(host, `\`\`\`mermaid\n${source}\`\`\``);
  const img = host.querySelector<HTMLImageElement>('img[alt="Mermaid diagram"]');
  expect(img).not.toBeNull();
  const src = img!.getAttribute('src')!;
  const image = new DOMParser().parseFromString(
    decodeURIComponent(src.slice(src.indexOf(',') + 1)), 'image/svg+xml');
  expect(image.querySelector('parsererror')).toBeNull();
  expect(image.documentElement.localName).toBe('svg');
  const label = image.getElementsByTagNameNS('http://www.w3.org/1999/xhtml', 'p')[0];
  expect(label.getElementsByTagNameNS('http://www.w3.org/1999/xhtml', 'br')).toHaveLength(1);
  expect(label.textContent).toBe('First lineSecond\u00a0line');
});

it('passes well-formed SVG output through unchanged', async () => {
  // Valid XML that an HTML reparse would truncate: `<br/>` inside SVG `<text>` breaks out of `<svg>`.
  const wellFormed = '<svg xmlns="http://www.w3.org/2000/svg"><g><text>a<br/>b</text><rect/></g></svg>';
  render.mockResolvedValue({ svg: wellFormed });
  await renderer.renderContent(host, `\`\`\`mermaid\n${source}\`\`\``);
  const img = host.querySelector<HTMLImageElement>('img[alt="Mermaid diagram"]');
  expect(img).not.toBeNull();
  const src = img!.getAttribute('src')!;
  expect(decodeURIComponent(src.slice(src.indexOf(',') + 1))).toBe(wellFormed);
});

it.each([undefined, '', '<svg><text>Syntax error</text><g class="error-icon"/></svg>'])('keeps source for invalid output %s', async output => {
  render.mockResolvedValue({ svg: output });
  await renderer.renderContent(host, `\`\`\`mermaid\n${source}\`\`\``);
  expect(host.querySelector('img[alt="Mermaid diagram"]')).toBeNull();
  expect(host.querySelector('.copy-code-button')).not.toBeNull();
  expect(host.querySelector('button[aria-label="Show diagram source"]')).toBeNull();
});

it('keeps source on a rejected render and cleans temporary DOM', async () => {
  render.mockRejectedValue(new Error('invalid diagram'));
  await renderer.renderContent(host, `\`\`\`mermaid\n${source}\`\`\``);
  expect(host.querySelector('.copy-code-button')).not.toBeNull();
  expect(document.body.children).toHaveLength(1);
});

it('defers diagrams without losing code during streaming', async () => {
  await renderer.renderContent(host, `\`\`\`mermaid\n${source}`, { deferDiagrams: true });
  expect(host.querySelector('img[alt="Mermaid diagram"]')).toBeNull();
  expect(host.querySelector('.copy-code-button')).not.toBeNull();
  await renderer.renderContent(host, `\`\`\`mermaid\n${source}\`\`\``);
  expect(host.querySelector('img[alt="Mermaid diagram"]')).not.toBeNull();
});

it('discards a diagram when the content is replaced before rendering completes', async () => {
  let finish!: (value: { svg: string }) => void;
  render.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const pending = renderer.renderContent(host, `\`\`\`mermaid\n${source}\`\`\``);
  while (!finish) await Promise.resolve();
  await renderer.renderContent(host, 'Replacement');
  finish({ svg });
  await pending;
  expect(host.querySelector('img[alt="Mermaid diagram"]')).toBeNull();
  expect(document.body.children).toHaveLength(1);
});

it('discards a diagram after renderer disposal', async () => {
  let finish!: (value: { svg: string }) => void;
  render.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const pending = renderer.renderContent(host, `\`\`\`mermaid\n${source}\`\`\``);
  while (!finish) await Promise.resolve();
  renderer.dispose();
  finish({ svg });
  await pending;
  expect(host.querySelector('img[alt="Mermaid diagram"]')).toBeNull();
  expect(document.body.children).toHaveLength(1);
});

it('reveals the source if the browser cannot display the diagram image', async () => {
  await renderer.renderContent(host, `\`\`\`mermaid\n${source}\`\`\``);
  const img = host.querySelector<HTMLImageElement>('img[alt="Mermaid diagram"]');
  expect(img).not.toBeNull();
  img!.dispatchEvent(new Event('error'));
  expect(host.querySelector('img[alt="Mermaid diagram"]')).toBeNull();
  expect(host.querySelector('.copy-code-button')).not.toBeNull();
});

it.each(['```dataview\nTABLE file.name\n```', '````markdown\n```mermaid\ngraph TD\n```\n````'])('keeps ordinary and outer fences as source: %s', async markdown => {
  await renderer.renderContent(host, markdown);
  expect(host.querySelector('img[alt="Mermaid diagram"]')).toBeNull();
  expect(host.querySelector('.copy-code-button')).not.toBeNull();
});

it('keeps source open when focus moves to its copy control', async () => {
  await renderer.renderContent(host, `\`\`\`mermaid\n${source}\`\`\``);
  const toggle = host.querySelector<HTMLButtonElement>('button[aria-label="Show diagram source"]');
  expect(toggle).not.toBeNull();
  toggle!.click();
  const copyBtn = host.querySelector<HTMLButtonElement>('.copy-code-button');
  expect(copyBtn).not.toBeNull();
  copyBtn!.focus();
  expect(host.querySelector('img[alt="Mermaid diagram"]')!.hasAttribute('hidden')).toBe(true);
  expect(document.activeElement).toBe(copyBtn);
});
