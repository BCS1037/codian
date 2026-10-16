import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import type { App, DataAdapter } from 'obsidian';

import { VaultFileAdapter } from '@/core/storage/VaultFileAdapter';
import { ClaudeSkillMigration } from '@/providers/claude/skills/ClaudeSkillMigration';

function createVaultAdapter(root: string): DataAdapter {
  const resolve = (relativePath: string) => path.join(root, ...relativePath.split('/'));
  return {
    copy: async (source: string, target: string) => fs.copyFile(
      resolve(source),
      resolve(target),
      fs.constants.COPYFILE_EXCL,
    ),
    exists: async (relativePath: string) => fs.access(resolve(relativePath)).then(
      () => true,
      () => false,
    ),
    getBasePath: () => root,
    getName: () => 'test',
    getResourcePath: () => '',
    list: async (relativePath: string) => {
      const entries = await fs.readdir(resolve(relativePath), { withFileTypes: true });
      return {
        files: entries.filter(entry => entry.isFile()).map(entry => `${relativePath}/${entry.name}`),
        folders: entries.filter(entry => entry.isDirectory()).map(entry => `${relativePath}/${entry.name}`),
      };
    },
    mkdir: async (relativePath: string) => fs.mkdir(resolve(relativePath)),
    read: async (relativePath: string) => fs.readFile(resolve(relativePath), 'utf8'),
    readBinary: async (relativePath: string) => {
      const content = await fs.readFile(resolve(relativePath));
      return content.buffer.slice(
        content.byteOffset,
        content.byteOffset + content.byteLength,
      ) as ArrayBuffer;
    },
    remove: async (relativePath: string) => fs.unlink(resolve(relativePath)),
    rename: async (source: string, target: string) => fs.rename(resolve(source), resolve(target)),
    rmdir: async (relativePath: string) => fs.rmdir(resolve(relativePath)),
    stat: async (relativePath: string) => {
      try {
        const stat = await fs.stat(resolve(relativePath));
        return {
          ctime: stat.ctimeMs,
          mtime: stat.mtimeMs,
          size: stat.size,
          type: stat.isDirectory() ? 'folder' : 'file',
        };
      } catch {
        return null;
      }
    },
    trashLocal: async () => {},
    trashSystem: async () => false,
    write: async (relativePath: string, content: string) => fs.writeFile(resolve(relativePath), content),
    writeBinary: async (relativePath: string, content: ArrayBuffer) => fs.writeFile(resolve(relativePath), new Uint8Array(content)),
    append: async (relativePath: string, content: string) => fs.appendFile(resolve(relativePath), content),
    appendBinary: async (relativePath: string, content: ArrayBuffer) => fs.appendFile(resolve(relativePath), new Uint8Array(content)),
    process: async (relativePath: string, fn: (data: string) => string) => {
      const next = fn(await fs.readFile(resolve(relativePath), 'utf8'));
      await fs.writeFile(resolve(relativePath), next);
      return next;
    },
  } as unknown as DataAdapter;
}

describe('ClaudeSkillMigration.apply', () => {
  it('copies a selected skill package byte-for-byte and keeps the Claude source intact', async () => {
    const vaultPath = await fs.mkdtemp(path.join(os.tmpdir(), 'codian-skill-migration-'));
    const sourceRoot = path.join(vaultPath, '.claude/skills/demo');
    const sourceMarkdown = '---\nname: demo\ndescription: Demo skill\n---\nUse the demo skill.\n';
    const guide = '# Reference\nKeep exact line endings.\r\n';
    const binaryAsset = new Uint8Array([0, 255, 13, 10, 42]);

    try {
      await fs.mkdir(path.join(sourceRoot, 'references/nested'), { recursive: true });
      await fs.mkdir(path.join(sourceRoot, 'assets'), { recursive: true });
      await fs.writeFile(path.join(sourceRoot, 'SKILL.md'), sourceMarkdown);
      await fs.writeFile(path.join(sourceRoot, 'references/nested/guide.md'), guide);
      await fs.writeFile(path.join(sourceRoot, 'assets/sample.bin'), binaryAsset);

      const adapter = createVaultAdapter(vaultPath);
      const migration = new ClaudeSkillMigration(new VaultFileAdapter({
        vault: { adapter },
      } as unknown as App));
      const preview = await migration.preview();
      const selected = preview.entries.find((entry) => entry.name === 'demo');

      expect(selected).toMatchObject({
        kind: 'skill',
        sourceStatus: 'review-required',
        targetPath: '.agents/skills/demo',
        targetStatus: 'absent',
      });
      if (!selected) throw new Error('Expected demo skill preview');

      await migration.apply(selected);

      const targetRoot = path.join(vaultPath, '.agents/skills/demo');
      await expect(fs.readFile(path.join(targetRoot, 'SKILL.md'), 'utf8')).resolves.toBe(sourceMarkdown);
      await expect(fs.readFile(path.join(targetRoot, 'references/nested/guide.md'), 'utf8')).resolves.toBe(guide);
      await expect(fs.readFile(path.join(targetRoot, 'assets/sample.bin')))
        .resolves.toEqual(Buffer.from(binaryAsset));
      await expect(fs.readFile(path.join(sourceRoot, 'SKILL.md'), 'utf8')).resolves.toBe(sourceMarkdown);
      await expect(fs.readFile(path.join(sourceRoot, 'assets/sample.bin')))
        .resolves.toEqual(Buffer.from(binaryAsset));
    } finally {
      await fs.rm(vaultPath, { recursive: true, force: true });
    }
  });

  it('rejects a stale preview after source changes and leaves target absent', async () => {
    const vaultPath = await fs.mkdtemp(path.join(os.tmpdir(), 'codian-skill-migration-stale-'));
    const sourceRoot = path.join(vaultPath, '.claude/skills/demo');
    const sourceMarkdown = '---\nname: demo\ndescription: Demo skill\n---\nUse the demo skill.\n';

    try {
      await fs.mkdir(sourceRoot, { recursive: true });
      await fs.writeFile(path.join(sourceRoot, 'SKILL.md'), sourceMarkdown);
      const migration = new ClaudeSkillMigration(new VaultFileAdapter({
        vault: { adapter: createVaultAdapter(vaultPath) },
      } as unknown as App));
      const selected = (await migration.preview()).entries.find(entry => entry.name === 'demo');
      if (!selected) throw new Error('Expected demo skill preview');

      await fs.writeFile(path.join(sourceRoot, 'SKILL.md'), `${sourceMarkdown}\nChanged after preview.`);

      await expect(migration.apply(selected)).rejects.toMatchObject({ code: 'stale-preview' });
      await expect(fs.access(path.join(vaultPath, '.agents/skills/demo'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
      await expect(fs.readFile(path.join(sourceRoot, 'SKILL.md'), 'utf8'))
        .resolves.toContain('Changed after preview.');
    } finally {
      await fs.rm(vaultPath, { recursive: true, force: true });
    }
  });

  it('rejects a destination created after preview without overwriting it', async () => {
    const vaultPath = await fs.mkdtemp(path.join(os.tmpdir(), 'codian-skill-migration-collision-'));
    const sourceRoot = path.join(vaultPath, '.claude/skills/demo');
    const targetRoot = path.join(vaultPath, '.agents/skills/demo');
    const sourceMarkdown = '---\nname: demo\ndescription: Demo skill\n---\nUse the demo skill.\n';
    const existingContent = 'user-owned destination';

    try {
      await fs.mkdir(sourceRoot, { recursive: true });
      await fs.writeFile(path.join(sourceRoot, 'SKILL.md'), sourceMarkdown);
      const migration = new ClaudeSkillMigration(new VaultFileAdapter({
        vault: { adapter: createVaultAdapter(vaultPath) },
      } as unknown as App));
      const selected = (await migration.preview()).entries.find(entry => entry.name === 'demo');
      if (!selected) throw new Error('Expected demo skill preview');
      await fs.mkdir(targetRoot, { recursive: true });
      await fs.writeFile(path.join(targetRoot, 'notes.txt'), existingContent);

      await expect(migration.apply(selected)).rejects.toMatchObject({ code: 'stale-preview' });
      await expect(fs.readFile(path.join(targetRoot, 'notes.txt'), 'utf8')).resolves.toBe(existingContent);
      await expect(fs.readdir(targetRoot)).resolves.toEqual(['notes.txt']);
    } finally {
      await fs.rm(vaultPath, { recursive: true, force: true });
    }
  });

  it('rejects linked package entries without reading their targets', async () => {
    const vaultPath = await fs.mkdtemp(path.join(os.tmpdir(), 'codian-skill-migration-link-'));
    const externalPath = await fs.mkdtemp(path.join(os.tmpdir(), 'codian-skill-migration-external-'));
    const sourceRoot = path.join(vaultPath, '.claude/skills/demo');
    const externalContent = 'private linked content';

    try {
      await fs.mkdir(sourceRoot, { recursive: true });
      await fs.writeFile(
        path.join(sourceRoot, 'SKILL.md'),
        '---\nname: demo\ndescription: Demo skill\n---\nUse the demo skill.\n',
      );
      await fs.writeFile(path.join(externalPath, 'outside.txt'), externalContent);
      await fs.symlink(externalPath, path.join(sourceRoot, 'external'), 'dir');
      const migration = new ClaudeSkillMigration(new VaultFileAdapter({
        vault: { adapter: createVaultAdapter(vaultPath) },
      } as unknown as App));
      const selected = (await migration.preview()).entries.find(entry => entry.name === 'demo');

      expect(selected).toMatchObject({ sourceStatus: 'symlink-not-inspected' });
      if (!selected) throw new Error('Expected demo skill preview');
      await expect(migration.apply(selected)).rejects.toMatchObject({ code: 'invalid-selection' });
      await expect(fs.access(path.join(vaultPath, '.agents'))).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(fs.readFile(path.join(externalPath, 'outside.txt'), 'utf8')).resolves.toBe(externalContent);
    } finally {
      await fs.rm(vaultPath, { recursive: true, force: true });
      await fs.rm(externalPath, { recursive: true, force: true });
    }
  });

  it('rejects Claude command entries until conversion rules are defined', async () => {
    const vaultPath = await fs.mkdtemp(path.join(os.tmpdir(), 'codian-skill-migration-command-'));

    try {
      await fs.mkdir(path.join(vaultPath, '.claude/commands'), { recursive: true });
      await fs.writeFile(path.join(vaultPath, '.claude/commands/format.md'), 'format instructions');
      const migration = new ClaudeSkillMigration(new VaultFileAdapter({
        vault: { adapter: createVaultAdapter(vaultPath) },
      } as unknown as App));
      const command = (await migration.preview()).entries.find(entry => entry.name === 'format');
      if (!command) throw new Error('Expected format command preview');

      await expect(migration.apply(command)).rejects.toMatchObject({ code: 'invalid-selection' });
      await expect(fs.access(path.join(vaultPath, '.agents'))).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(fs.readFile(path.join(vaultPath, '.claude/commands/format.md'), 'utf8'))
        .resolves.toBe('format instructions');
    } finally {
      await fs.rm(vaultPath, { recursive: true, force: true });
    }
  });

  it('rolls back only package items created by failed migration', async () => {
    const vaultPath = await fs.mkdtemp(path.join(os.tmpdir(), 'codian-skill-migration-rollback-'));
    const sourceRoot = path.join(vaultPath, '.claude/skills/demo');
    const existingRoot = path.join(vaultPath, '.agents/skills/other');
    const existingContent = 'keep unrelated package';

    try {
      await fs.mkdir(sourceRoot, { recursive: true });
      await fs.mkdir(existingRoot, { recursive: true });
      await fs.writeFile(
        path.join(sourceRoot, 'SKILL.md'),
        '---\nname: demo\ndescription: Demo skill\n---\nUse the demo skill.\n',
      );
      await fs.writeFile(path.join(sourceRoot, 'references.md'), 'reference');
      await fs.writeFile(path.join(existingRoot, 'notes.txt'), existingContent);
      const files = new VaultFileAdapter({
        vault: { adapter: createVaultAdapter(vaultPath) },
      } as unknown as App);
      const writeBinary = files.writeManagedBinaryExclusive.bind(files);
      jest.spyOn(files, 'writeManagedBinaryExclusive')
        .mockImplementationOnce((filePath, bytes) => writeBinary(filePath, bytes))
        .mockRejectedValueOnce(new Error('disk full'));
      const migration = new ClaudeSkillMigration(files);
      const selected = (await migration.preview()).entries.find(entry => entry.name === 'demo');
      if (!selected) throw new Error('Expected demo skill preview');

      await expect(migration.apply(selected)).rejects.toThrow('disk full');
      await expect(fs.access(path.join(vaultPath, '.agents/skills/demo'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
      await expect(fs.readFile(path.join(existingRoot, 'notes.txt'), 'utf8')).resolves.toBe(existingContent);
      await expect(fs.readFile(path.join(sourceRoot, 'SKILL.md'), 'utf8'))
        .resolves.toContain('name: demo');
    } finally {
      await fs.rm(vaultPath, { recursive: true, force: true });
    }
  });
});
