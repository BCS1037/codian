import {
  buildMarkdownDiffDocuments,
  computeMarkdownDiff,
  countDiffLines,
  diffOpsEqual,
} from '@/features/inline-edit/ui/markdownLineDiff';

describe('markdown line diff', () => {
  it.each([
    {
      name: 'fenced code with block context',
      oldMarkdown: '```ts\nconst value = 1;\n```',
      newMarkdown: '```ts\nconst value = 2;\n```',
      expectedDiffOps: [
        { type: 'equal', text: '```ts\n' },
        { type: 'delete', text: 'const value = 1;\n' },
        { type: 'insert', text: 'const value = 2;\n' },
        { type: 'equal', text: '```' },
      ],
      expectedDocuments: ['delete', 'insert'],
    },
    {
      name: 'unchanged text',
      oldMarkdown: 'Hello world',
      newMarkdown: 'Hello world',
      expectedDiffOps: [{ type: 'equal', text: 'Hello world' }],
      expectedDocuments: ['equal'],
    },
    {
      name: 'insertion into empty text',
      oldMarkdown: '',
      newMarkdown: 'New text',
      expectedDiffOps: [{ type: 'insert', text: 'New text' }],
      expectedDocuments: ['insert'],
    },
    {
      name: 'complete deletion',
      oldMarkdown: 'Removed text',
      newMarkdown: '',
      expectedDiffOps: [{ type: 'delete', text: 'Removed text' }],
      expectedDocuments: ['delete'],
    },
    {
      name: 'empty documents',
      oldMarkdown: '',
      newMarkdown: '',
      expectedDiffOps: [],
      expectedDocuments: [],
    },
    {
      name: 'word insertion',
      oldMarkdown: 'Hello world',
      newMarkdown: 'Hello beautiful world',
      expectedDiffOps: [
        { type: 'delete', text: 'Hello world' },
        { type: 'insert', text: 'Hello beautiful world' },
      ],
      expectedDocuments: ['delete', 'insert'],
    },
    {
      name: 'word deletion',
      oldMarkdown: 'Hello beautiful world',
      newMarkdown: 'Hello world',
      expectedDiffOps: [
        { type: 'delete', text: 'Hello beautiful world' },
        { type: 'insert', text: 'Hello world' },
      ],
      expectedDocuments: ['delete', 'insert'],
    },
    {
      name: 'whitespace and multiline markdown',
      oldMarkdown: '# Heading\n\n  First paragraph.  \n\tSecond line.\n',
      newMarkdown: '# Heading\n\n  Updated paragraph!  \n\tSecond line.\n',
      expectedDiffOps: [
        { type: 'equal', text: '# Heading\n\n' },
        { type: 'delete', text: '  First paragraph.  \n' },
        { type: 'insert', text: '  Updated paragraph!  \n' },
        { type: 'equal', text: '\tSecond line.\n' },
      ],
      expectedDocuments: ['delete', 'insert'],
    },
    {
      name: 'literal HTML and punctuation in code',
      oldMarkdown: '```html\n<div title="old">Hello & goodbye.</div>\n```',
      newMarkdown: '```html\n<div title="new">Hello, world!</div>\n```',
      expectedDiffOps: [
        { type: 'equal', text: '```html\n' },
        { type: 'delete', text: '<div title="old">Hello & goodbye.</div>\n' },
        { type: 'insert', text: '<div title="new">Hello, world!</div>\n' },
        { type: 'equal', text: '```' },
      ],
      expectedDocuments: ['delete', 'insert'],
    },
  ] as const)('diffs $name into whole renderable Markdown documents', ({
    oldMarkdown, newMarkdown, expectedDiffOps, expectedDocuments,
  }) => {
    const diffOps = computeMarkdownDiff(oldMarkdown, newMarkdown);
    expect(diffOps).toEqual(expectedDiffOps);
    // Each side renders as a complete document so block context such as code fences survives.
    expect(buildMarkdownDiffDocuments(diffOps)).toEqual(expectedDocuments.map(type => ({
      type,
      markdown: type === 'delete' ? oldMarkdown : newMarkdown,
    })));
  });

  describe('countDiffLines', () => {
    it('counts lines accurately for insert and delete operations', () => {
      const diffOps = computeMarkdownDiff(
        'line 1\nline 2\nline 3\n',
        'line 1\nmodified 2\nadded 2.5\nline 3\n'
      );
      expect(countDiffLines(diffOps, 'delete')).toBe(1);
      expect(countDiffLines(diffOps, 'insert')).toBe(2);
      expect(countDiffLines(diffOps, 'equal')).toBe(2);
    });

    it('returns 0 when no operations match the requested type', () => {
      const diffOps = computeMarkdownDiff('abc', 'abc');
      expect(countDiffLines(diffOps, 'insert')).toBe(0);
      expect(countDiffLines(diffOps, 'delete')).toBe(0);
    });
  });

  describe('diffOpsEqual', () => {
    it('returns true for structurally identical diff operations', () => {
      const opsA = [{ type: 'insert' as const, text: 'hello\n' }];
      const opsB = [{ type: 'insert' as const, text: 'hello\n' }];
      expect(diffOpsEqual(opsA, opsB)).toBe(true);
    });

    it('returns false when length or properties differ', () => {
      const opsA = [{ type: 'insert' as const, text: 'hello\n' }];
      const opsB = [{ type: 'insert' as const, text: 'world\n' }];
      const opsC = [{ type: 'delete' as const, text: 'hello\n' }];
      const opsD = [...opsA, ...opsB];

      expect(diffOpsEqual(opsA, opsB)).toBe(false);
      expect(diffOpsEqual(opsA, opsC)).toBe(false);
      expect(diffOpsEqual(opsA, opsD)).toBe(false);
    });
  });
});
