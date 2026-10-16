import { createMockEl } from '@test/helpers/mockElement';
import { loadPrism } from 'obsidian';

import {
  getPluginFenceLanguageSet,
  hasDeferredDiagramFence,
  prepareDisplayOnlyCodeFences,
  restoreDisplayOnlyCodeFences,
} from '@/features/chat/rendering/DisplayOnlyCodeFences';

describe('DisplayOnlyCodeFences', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('replaces every fenced language while preserving fence structure and metadata', () => {
    const markdown = [
      '> ```dataview',
      '> TABLE file.name',
      '> ```',
      '- ~~~typescript title="sample"',
      '  const value = 1;',
      '  ~~~',
    ].join('\n');

    const prepared = prepareDisplayOnlyCodeFences(markdown);

    expect(prepared.markdown).toBe([
      '> ```codian-display-only-fence-0',
      '> TABLE file.name',
      '> ```',
      '- ~~~codian-display-only-fence-1 title="sample"',
      '  const value = 1;',
      '  ~~~',
    ].join('\n'));
    expect(prepared.fences).toEqual([
      {
        placeholderLanguage: 'codian-display-only-fence-0',
        originalLanguage: 'dataview',
      },
      {
        placeholderLanguage: 'codian-display-only-fence-1',
        originalLanguage: 'typescript',
      },
    ]);
  });

  it('does not treat fence-like content inside an outer fence as a new block', () => {
    const markdown = [
      '````markdown',
      '```dataview',
      'TABLE file.name',
      '```',
      '````',
    ].join('\n');

    const prepared = prepareDisplayOnlyCodeFences(markdown);

    expect(prepared.markdown).toBe([
      '````codian-display-only-fence-0',
      '```dataview',
      'TABLE file.name',
      '```',
      '````',
    ].join('\n'));
    expect(prepared.fences).toHaveLength(1);
    expect(prepared.fences[0]?.originalLanguage).toBe('markdown');
  });

  it('protects unclosed streaming fences and leaves non-language syntax unchanged', () => {
    const markdown = [
      '` ```dataview`',
      '```',
      'plain code',
      '```',
      '```dataview',
      'TABLE file.name',
    ].join('\n');

    const prepared = prepareDisplayOnlyCodeFences(markdown);

    expect(prepared.markdown).toBe([
      '` ```dataview`',
      '```',
      'plain code',
      '```',
      '```codian-display-only-fence-0',
      'TABLE file.name',
    ].join('\n'));
    expect(prepared.fences).toHaveLength(1);
  });

  it('restores original language classes and reapplies Prism highlighting', async () => {
    const highlightElement = jest.fn();
    (loadPrism as jest.Mock).mockResolvedValueOnce({ highlightElement });
    const container = createMockEl();
    const code = container.createEl('code', {
      cls: 'language-codian-display-only-fence-0 extra-class',
      text: 'const value = 1;',
    });

    await restoreDisplayOnlyCodeFences(container, [{
      placeholderLanguage: 'codian-display-only-fence-0',
      originalLanguage: 'typescript',
    }]);

    expect(code.hasClass('language-codian-display-only-fence-0')).toBe(false);
    expect(code.hasClass('language-typescript')).toBe(true);
    expect(code.hasClass('extra-class')).toBe(true);
    expect(highlightElement).toHaveBeenCalledWith(code);
  });

  it('restores language classes even when Prism loading fails', async () => {
    (loadPrism as jest.Mock).mockRejectedValueOnce(new Error('Prism unavailable'));
    const container = createMockEl();
    const code = container.createEl('code', {
      cls: 'language-codian-display-only-fence-0',
      text: 'TABLE file.name',
    });

    await expect(restoreDisplayOnlyCodeFences(container, [{
      placeholderLanguage: 'codian-display-only-fence-0',
      originalLanguage: 'dataview',
    }])).resolves.toBeUndefined();

    expect(code.hasClass('language-dataview')).toBe(true);
  });

  describe('plugin fence languages', () => {
    it('leaves opted-in plugin languages untouched and excludes them from fences', () => {
      const markdown = [
        '```Vega-Lite',
        '{"mark": "bar"}',
        '```',
        '```dataview',
        'TABLE file.name',
        '```',
        '```typescript',
        'const x = 1;',
        '```',
      ].join('\n');

      const pluginLanguages = new Set(['vega-lite', 'dataview']);
      const prepared = prepareDisplayOnlyCodeFences(markdown, pluginLanguages);

      expect(prepared.markdown).toContain('```Vega-Lite\n{"mark": "bar"}\n```');
      expect(prepared.markdown).toContain('```dataview\nTABLE file.name\n```');
      expect(prepared.markdown).toContain('```codian-display-only-fence-0\nconst x = 1;\n```');
      expect(prepared.fences).toEqual([
        {
          placeholderLanguage: 'codian-display-only-fence-0',
          originalLanguage: 'typescript',
        },
      ]);
    });

    it('normalizes fence languages in getPluginFenceLanguageSet', () => {
      expect(getPluginFenceLanguageSet(undefined)).toEqual(new Set());
      expect(getPluginFenceLanguageSet([])).toEqual(new Set());
      expect(getPluginFenceLanguageSet([' Vega-Lite ', 'DATAVIEW', '', '  ', 'tasks'])).toEqual(
        new Set(['vega-lite', 'dataview', 'tasks']),
      );
    });

    it('detects deferred diagram and plugin fences in hasDeferredDiagramFence', () => {
      const pluginLanguages = new Set(['vega-lite']);

      expect(hasDeferredDiagramFence('```mermaid\ngraph TD;\n```', pluginLanguages)).toBe(true);
      expect(hasDeferredDiagramFence('```Mermaid\ngraph TD;\n```', new Set())).toBe(true);
      expect(hasDeferredDiagramFence('```Vega-Lite\n{"mark": "bar"}\n```', pluginLanguages)).toBe(true);
      expect(hasDeferredDiagramFence('<div>\n```vega-lite\n{"mark": "bar"}\n```\n</div>', pluginLanguages)).toBe(true);
      expect(hasDeferredDiagramFence('```dataview\nTABLE file.name\n```', pluginLanguages)).toBe(false);
      expect(hasDeferredDiagramFence('```python\nprint(1)\n```', pluginLanguages)).toBe(false);
    });
  });
});
