import * as fs from 'node:fs';
import * as path from 'node:path';

describe('Grok brand color', () => {
  const variablesCss = fs.readFileSync(
    path.join(process.cwd(), 'src/style/base/variables.css'),
    'utf8',
  );
  const tabsCss = fs.readFileSync(
    path.join(process.cwd(), 'src/style/components/tabs.css'),
    'utf8',
  );

  it('uses white in dark mode and black in light mode', () => {
    expect(variablesCss).toContain('--codian-brand-grok: #ffffff;');
    expect(variablesCss).toContain('--codian-brand-grok-rgb: 255, 255, 255;');
    expect(variablesCss).toMatch(
      /body\.theme-light \.codian-container \{[\s\S]*?--codian-brand-grok: #000000;[\s\S]*?--codian-brand-grok-rgb: 0, 0, 0;[\s\S]*?\}/,
    );
  });

  it('routes active and streaming Grok surfaces through its brand token', () => {
    expect(variablesCss).toMatch(
      /\.codian-container\[data-provider="grok"\] \{[\s\S]*?--codian-brand: var\(--codian-brand-grok\);[\s\S]*?--codian-brand-rgb: var\(--codian-brand-grok-rgb\);[\s\S]*?\}/,
    );
    expect(tabsCss).toMatch(
      /\.codian-tab-badge-streaming\[data-provider="grok"\] \{[\s\S]*?border-color: var\(--codian-brand-grok, #ffffff\);[\s\S]*?\}/,
    );
  });
});
