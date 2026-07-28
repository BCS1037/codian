import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const containerCss = readFileSync(resolve('src/style/base/container.css'), 'utf8');
const headerCss = readFileSync(resolve('src/style/components/header.css'), 'utf8');
const tabsCss = readFileSync(resolve('src/style/components/tabs.css'), 'utf8');
const inputCss = readFileSync(resolve('src/style/components/input.css'), 'utf8');

describe('chat layout styles', () => {
  it('keeps header and tab badges pinned to inline start', () => {
    expect(headerCss).toMatch(/\.claudian-container > \.claudian-header\s*\{[\s\S]*?justify-content:\s*flex-start;/);
    expect(headerCss).toMatch(/\.claudian-container \.claudian-title\s*\{[\s\S]*?justify-content:\s*flex-start;/);
    expect(tabsCss).toMatch(/\.claudian-container \.claudian-tab-badges\s*\{[\s\S]*?justify-content:\s*flex-start;/);
  });

  it('fills chat host and prevents its outer view from scrolling below composer', () => {
    expect(containerCss).toMatch(/\.claudian-container\s*\{[\s\S]*?min-height:\s*100%;/);
    expect(containerCss).toMatch(/\.claudian-container\s*\{[\s\S]*?box-sizing:\s*border-box;/);
    expect(inputCss).toMatch(/\.claudian-input-footer\s*\{[\s\S]*?margin-top:\s*auto;/);
  });
});
