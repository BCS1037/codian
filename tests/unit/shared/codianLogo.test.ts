/** @jest-environment jsdom */

import { CODIAN_RIBBON_ICON_SVG } from '@/shared/codianLogo';

describe('CODIAN_RIBBON_ICON_SVG', () => {
  it('scales its 24-unit artwork into Obsidian custom icons 100-unit viewBox', () => {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 100 100');
    svg.innerHTML = CODIAN_RIBBON_ICON_SVG;

    expect(svg.querySelector('g')?.getAttribute('transform')).toBe('scale(4.166667)');
  });
});
