import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import type { App } from 'obsidian';

import type { ManagedFolderEntry } from '@/core/storage/VaultFileAdapter';
import { VaultFileAdapter } from '@/core/storage/VaultFileAdapter';
import { ClaudeSkillMigrationPreviewer } from '@/providers/claude/skills/ClaudeSkillMigrationPreview';

function entry(folder: string, name: string, kind: ManagedFolderEntry['kind']): ManagedFolderEntry {
  return { name, path: `${folder}/${name}`, kind };
}

describe('ClaudeSkillMigrationPreviewer', () => {
  it('composes with a desktop vault and leaves linked content and all files untouched', async () => {
    const vaultPath = await fs.mkdtemp(path.join(os.tmpdir(), 'codian-preview-vault-'));
    const externalPath = await fs.mkdtemp(path.join(os.tmpdir(), 'codian-preview-external-'));
    const localSkillPath = '.claude/skills/local-skill/SKILL.md';
    const externalSkillContent = 'external linked skill';
    const adapter = {
      getBasePath: () => vaultPath,
      read: jest.fn((relativePath: string) => (
        fs.readFile(path.join(vaultPath, relativePath), 'utf8')
      )),
      write: jest.fn(),
      remove: jest.fn(),
      rename: jest.fn(),
      mkdir: jest.fn(),
      rmdir: jest.fn(),
      trashSystem: jest.fn(),
      trashLocal: jest.fn(),
    };

    try {
      await fs.mkdir(path.join(vaultPath, '.claude/skills/local-skill'), { recursive: true });
      await fs.mkdir(path.join(vaultPath, '.claude/commands'), { recursive: true });
      await fs.mkdir(path.join(vaultPath, '.agents/skills/local-skill'), { recursive: true });
      await fs.mkdir(path.join(externalPath, 'external-skill'));
      await fs.writeFile(
        path.join(vaultPath, localSkillPath),
        '---\nname: local-skill\ndescription: Local skill\n---\nUse it.',
      );
      await fs.writeFile(path.join(externalPath, 'external-skill/SKILL.md'), externalSkillContent);
      await fs.writeFile(path.join(vaultPath, '.claude/commands/format.md'), 'command body');
      await fs.symlink(
        path.join(externalPath, 'external-skill'),
        path.join(vaultPath, '.claude/skills/external-skill'),
        'dir',
      );
      await fs.symlink(
        path.join(externalPath, 'missing-skill'),
        path.join(vaultPath, '.claude/skills/dangling-skill'),
        'dir',
      );

      const app = { vault: { adapter } } as unknown as App;
      const result = await new ClaudeSkillMigrationPreviewer(new VaultFileAdapter(app)).preview();

      expect(result.entries).toEqual(expect.arrayContaining([
        expect.objectContaining({
          name: 'local-skill',
          sourceStatus: 'review-required',
          targetStatus: 'entry',
        }),
        expect.objectContaining({
          name: 'external-skill',
          sourceStatus: 'symlink-not-inspected',
        }),
        expect.objectContaining({
          name: 'dangling-skill',
          sourceStatus: 'symlink-not-inspected',
        }),
      ]));
      expect(adapter.read).not.toHaveBeenCalled();
      expect(adapter.write).not.toHaveBeenCalled();
      expect(adapter.remove).not.toHaveBeenCalled();
      expect(adapter.rename).not.toHaveBeenCalled();
      expect(adapter.mkdir).not.toHaveBeenCalled();
      expect(adapter.rmdir).not.toHaveBeenCalled();
      expect(adapter.trashSystem).not.toHaveBeenCalled();
      expect(adapter.trashLocal).not.toHaveBeenCalled();
      await expect(fs.readFile(path.join(externalPath, 'external-skill/SKILL.md'), 'utf8'))
        .resolves.toBe(externalSkillContent);
    } finally {
      await fs.rm(vaultPath, { recursive: true, force: true });
      await fs.rm(externalPath, { recursive: true, force: true });
    }
  });

  it('previews regular skills, conflicts, links, commands, and leftovers without mutation', async () => {
    const lists: Record<string, ManagedFolderEntry[]> = {
      '.claude/skills': [
        entry('.claude/skills', 'copy-skill', 'folder'),
        entry('.claude/skills', 'linked-skill', 'symlink'),
        entry('.claude/skills', 'missing-skill', 'folder'),
        entry('.claude/skills', 'broken-skill', 'folder'),
      ],
      '.claude/commands': [
        entry('.claude/commands', 'format.md', 'file'),
        entry('.claude/commands', 'linked.md', 'symlink'),
        entry('.claude/commands', 'notes.txt', 'file'),
      ],
      '.agents/skills': [
        entry('.agents/skills', 'copy-skill', 'folder'),
        entry('.agents/skills', 'managed-link', 'symlink'),
      ],
      '.claude/skills/copy-skill': [
        entry('.claude/skills/copy-skill', 'SKILL.md', 'file'),
        entry('.claude/skills/copy-skill', 'references', 'folder'),
      ],
      '.claude/skills/missing-skill': [
        entry('.claude/skills/missing-skill', 'README.md', 'file'),
      ],
      '.claude/skills/broken-skill': [
        entry('.claude/skills/broken-skill', 'SKILL.md', 'symlink'),
      ],
    };
    const readManagedBinary = jest.fn(async (filePath: string) => {
      if (filePath === '.claude/skills/copy-skill/SKILL.md') {
        const content = Buffer.from('---\nname: copy-skill\ndescription: A portable skill\n---\nUse it.');
        return content.buffer.slice(content.byteOffset, content.byteOffset + content.byteLength) as ArrayBuffer;
      }
      if (filePath === '.claude/skills/missing-skill/README.md') {
        const content = Buffer.from('readme');
        return content.buffer.slice(content.byteOffset, content.byteOffset + content.byteLength) as ArrayBuffer;
      }
      throw new Error(`Unexpected file read: ${filePath}`);
    });
    const storage = {
      verifyManagedPath: jest.fn(async () => true),
      listManagedFolderEntries: jest.fn(async (folder: string) => lists[folder] ?? []),
      readManagedBinary,
      writeManagedFile: jest.fn(),
      removeManagedFile: jest.fn(),
      removeManagedFolderIfEmpty: jest.fn(),
      trash: jest.fn(),
      rename: jest.fn(),
    };

    const result = await new ClaudeSkillMigrationPreviewer(storage).preview();

    expect(result.applyAvailable).toBe(false);
    expect(result.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'skill',
        name: 'copy-skill',
        sourceStatus: 'review-required',
        targetStatus: 'entry',
        additionalEntries: ['.claude/skills/copy-skill/references'],
      }),
      expect.objectContaining({
        kind: 'skill',
        name: 'linked-skill',
        sourceStatus: 'symlink-not-inspected',
        targetStatus: 'absent',
      }),
      expect.objectContaining({
        kind: 'skill',
        name: 'missing-skill',
        sourceStatus: 'missing-skill-markdown',
      }),
      expect.objectContaining({
        kind: 'skill',
        name: 'broken-skill',
        sourceStatus: 'symlink-not-inspected',
      }),
      expect.objectContaining({
        kind: 'command',
        name: 'format',
        sourceStatus: 'conversion-policy-required',
        targetStatus: 'absent',
      }),
      expect.objectContaining({
        kind: 'command',
        name: 'linked',
        sourceStatus: 'symlink-not-inspected',
      }),
      expect.objectContaining({
        kind: 'other',
        sourcePath: '.claude/commands/notes.txt',
        sourceStatus: 'unsupported-entry',
      }),
    ]));
    expect(readManagedBinary).toHaveBeenCalledTimes(2);
    expect(readManagedBinary).toHaveBeenCalledWith('.claude/skills/copy-skill/SKILL.md');
    expect(readManagedBinary.mock.calls.some(([filePath]) => filePath.startsWith('.agents/skills/')))
      .toBe(false);
    expect(storage.writeManagedFile).not.toHaveBeenCalled();
    expect(storage.removeManagedFile).not.toHaveBeenCalled();
    expect(storage.removeManagedFolderIfEmpty).not.toHaveBeenCalled();
    expect(storage.trash).not.toHaveBeenCalled();
    expect(storage.rename).not.toHaveBeenCalled();
  });

  it('reports invalid skill frontmatter and does not read link targets', async () => {
    const lists: Record<string, ManagedFolderEntry[]> = {
      '.claude/skills': [
        entry('.claude/skills', 'invalid-skill', 'folder'),
        entry('.claude/skills', 'linked-destination', 'folder'),
      ],
      '.agents/skills': [entry('.agents/skills', 'linked-destination', 'symlink')],
      '.claude/skills/invalid-skill': [
        entry('.claude/skills/invalid-skill', 'SKILL.md', 'file'),
      ],
      '.claude/skills/linked-destination': [
        entry('.claude/skills/linked-destination', 'SKILL.md', 'file'),
      ],
    };
    const readManagedBinary = jest.fn(async (filePath: string) => {
      const content = Buffer.from(filePath.endsWith('invalid-skill/SKILL.md')
        ? '---\nname: invalid-skill\n---\nBody'
        : '---\nname: linked-destination\ndescription: Local copy\n---\nBody');
      return content.buffer.slice(content.byteOffset, content.byteOffset + content.byteLength) as ArrayBuffer;
    });
    const storage = {
      verifyManagedPath: jest.fn(async () => true),
      listManagedFolderEntries: jest.fn(async (folder: string) => lists[folder] ?? []),
      readManagedBinary,
    };

    const result = await new ClaudeSkillMigrationPreviewer(storage).preview();

    expect(result.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: 'invalid-skill',
        sourceStatus: 'invalid-skill',
        targetStatus: 'absent',
      }),
      expect.objectContaining({
        name: 'linked-destination',
        sourceStatus: 'review-required',
        targetStatus: 'symlink',
      }),
    ]));
    expect(readManagedBinary).toHaveBeenCalledTimes(2);
    expect(readManagedBinary).toHaveBeenCalledWith('.claude/skills/invalid-skill/SKILL.md');
    expect(readManagedBinary).toHaveBeenCalledWith('.claude/skills/linked-destination/SKILL.md');
    expect(readManagedBinary.mock.calls.some(([filePath]) => filePath.startsWith('.agents/skills/')))
      .toBe(false);
  });

  it('marks target listing failures as unknown instead of suggesting a safe destination', async () => {
    const storage = {
      verifyManagedPath: jest.fn(async () => true),
      listManagedFolderEntries: jest.fn(async (folder: string) => {
        if (folder === '.agents/skills') throw new Error('permission denied');
        return folder === '.claude/skills'
          ? [entry('.claude/skills', 'portable-skill', 'folder')]
          : [entry('.claude/skills/portable-skill', 'SKILL.md', 'file')];
      }),
      readManagedBinary: jest.fn(async () => {
        const content = Buffer.from('---\nname: portable-skill\ndescription: Portable\n---\nUse it.');
        return content.buffer.slice(content.byteOffset, content.byteOffset + content.byteLength) as ArrayBuffer;
      }),
    };

    const result = await new ClaudeSkillMigrationPreviewer(storage).preview();

    expect(result.entries[0]).toMatchObject({
      name: 'portable-skill',
      sourceStatus: 'review-required',
      targetStatus: 'unknown',
    });
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.stringContaining('.agents/skills'),
    ]));
  });

  it('surfaces unreadable source content without treating it as malformed', async () => {
    const storage = {
      verifyManagedPath: jest.fn(async () => true),
      listManagedFolderEntries: jest.fn(async (folder: string) => folder === '.claude/skills'
        ? [entry('.claude/skills', 'portable-skill', 'folder')]
        : folder === '.claude/skills/portable-skill'
          ? [entry('.claude/skills/portable-skill', 'SKILL.md', 'file')]
          : []),
      readManagedBinary: jest.fn(async () => { throw new Error('read denied'); }),
    };

    const result = await new ClaudeSkillMigrationPreviewer(storage).preview();

    expect(result.entries[0]).toMatchObject({
      name: 'portable-skill',
      sourceStatus: 'unreadable',
      diagnostic: 'Could not read .claude/skills/portable-skill/SKILL.md: read denied',
      targetStatus: 'absent',
    });
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.stringContaining('.claude/skills/portable-skill/SKILL.md'),
    ]));
  });
});
