import type { App } from 'obsidian';

import type { ClaudeSkillMigrationPreview } from '@/providers/claude/skills/ClaudeSkillMigrationPreview';
import { ClaudeSkillMigrationPreviewModal } from '@/providers/claude/ui/ClaudeSkillMigrationPreviewModal';

jest.mock('obsidian', () => {
  const createElement = (tagName = 'div') => {
    const element: any = {
      children: [],
      listeners: {},
      disabled: false,
      checked: false,
      isConnected: true,
      tagName,
      text: '',
      createDiv(options?: { cls?: string }) {
        const child = createElement('div');
        child.className = options?.cls ?? '';
        this.children.push(child);
        return child;
      },
      createEl(tag: string, options?: { text?: string; attr?: Record<string, string> }) {
        const child = createElement(tag);
        child.text = options?.text ?? '';
        child.attributes = options?.attr ?? {};
        this.children.push(child);
        return child;
      },
      addEventListener(name: string, listener: () => void) {
        this.listeners[name] = listener;
      },
      dispatch(name: string) {
        this.listeners[name]?.();
      },
      empty() {
        this.children = [];
        this.text = '';
      },
      setText(value: string) {
        this.text = value;
      },
    };
    return element;
  };

  return {
    Modal: class MockModal {
      contentEl = createElement();

      constructor(_app: unknown) {}
    },
  };
});

function collectText(node: { children: any[]; text: string }): string {
  return [node.text, ...node.children.map(collectText)].join(' ');
}

function collectTags(node: { children: any[]; tagName: string }): string[] {
  return [node.tagName, ...node.children.flatMap(collectTags)];
}

function collectNodes(node: { children: any[]; tagName: string }): any[] {
  return [node, ...node.children.flatMap(collectNodes)];
}

describe('ClaudeSkillMigrationPreviewModal', () => {
  it('renders preview statuses without controls when no package is eligible', async () => {
    const preview: ClaudeSkillMigrationPreview = {
      applyAvailable: false,
      diagnostics: [],
      entries: [{
        additionalEntries: ['.claude/skills/demo/references'],
        kind: 'skill',
        name: 'demo',
        sourcePath: '.claude/skills/demo',
        sourceStatus: 'review-required',
        targetPath: '.agents/skills/demo',
        targetStatus: 'entry',
      }],
    };
    const previewer = { preview: jest.fn().mockResolvedValue(preview) };
    const modal = new ClaudeSkillMigrationPreviewModal({} as App, previewer as never);

    modal.onOpen();
    await new Promise<void>(resolve => setImmediate(resolve));

    const contentEl = (modal as unknown as {
      contentEl: { children: any[]; tagName: string; text: string };
    }).contentEl;
    const text = collectText(contentEl);
    expect(text).toContain('Select valid skill packages with empty shared destinations.');
    expect(text).toContain('demo · Valid skill; review required');
    expect(text).toContain('.agents/skills/demo · Same-name destination exists');
    expect(text).toContain('.claude/skills/demo/references');
    expect(collectTags(contentEl)).not.toContain('button');
    expect(previewer.preview).toHaveBeenCalledTimes(1);
  });

  it('requires explicit selection before applying eligible packages', async () => {
    const entry: ClaudeSkillMigrationPreview['entries'][number] = {
      additionalEntries: ['.claude/skills/demo/references/guide.md'],
      kind: 'skill',
      name: 'demo',
      sourceFingerprint: 'fingerprint-1',
      sourcePath: '.claude/skills/demo',
      sourceStatus: 'review-required',
      targetPath: '.agents/skills/demo',
      targetStatus: 'absent',
    };
    const migration = {
      preview: jest.fn()
        .mockResolvedValueOnce({ applyAvailable: true, diagnostics: [], entries: [entry] })
        .mockResolvedValueOnce({
          applyAvailable: false,
          diagnostics: [],
          entries: [{ ...entry, targetStatus: 'entry' as const }],
        }),
      apply: jest.fn().mockResolvedValue(undefined),
    };
    const modal = new ClaudeSkillMigrationPreviewModal({} as App, migration as never);
    modal.onOpen();
    await new Promise<void>(resolve => setImmediate(resolve));

    const contentEl = (modal as unknown as { contentEl: any }).contentEl;
    const checkbox = collectNodes(contentEl).find((node: any) => node.tagName === 'input');
    const button = collectNodes(contentEl).find((node: any) => node.tagName === 'button');
    expect(button.disabled).toBe(true);

    checkbox.checked = true;
    checkbox.dispatch('change');
    expect(button.disabled).toBe(false);
    button.dispatch('click');
    await new Promise<void>(resolve => setImmediate(resolve));
    await new Promise<void>(resolve => setImmediate(resolve));

    expect(migration.apply).toHaveBeenCalledWith(entry);
    expect(collectText(contentEl)).toContain('Migrated: demo');
  });

  it('ignores a late preview result after the modal closes', async () => {
    let resolvePreview!: (value: ClaudeSkillMigrationPreview) => void;
    const previewer = {
      preview: jest.fn(() => new Promise<ClaudeSkillMigrationPreview>((resolve) => {
        resolvePreview = resolve;
      })),
    };
    const modal = new ClaudeSkillMigrationPreviewModal({} as App, previewer as never);
    modal.onOpen();
    modal.onClose();
    resolvePreview({ applyAvailable: false, diagnostics: [], entries: [] });
    await new Promise<void>(resolve => setImmediate(resolve));

    const contentEl = (modal as unknown as { contentEl: { children: any[]; text: string } }).contentEl;
    expect(contentEl.children).toEqual([]);
    expect(contentEl.text).toBe('');
  });
});
