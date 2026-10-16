import { createHash } from 'node:crypto';

import { parseAgentSkillMarkdown } from '../../../core/skills/AgentSkillCodec';
import { validateAgentSkillName } from '../../../core/skills/validateAgentSkill';
import type { ManagedFolderEntry, VaultFileAdapter } from '../../../core/storage/VaultFileAdapter';

const CLAUDE_SKILLS_ROOT = '.claude/skills';
const CLAUDE_COMMANDS_ROOT = '.claude/commands';
const SHARED_SKILLS_ROOT = '.agents/skills';
const SHARED_SKILLS_PARENTS = ['.agents', SHARED_SKILLS_ROOT];

type PreviewStorage = Pick<
  VaultFileAdapter,
  'verifyManagedPath' | 'listManagedFolderEntries' | 'readManagedBinary'
>;

type MigrationStorage = PreviewStorage & Pick<
  VaultFileAdapter,
  | 'createManagedFolderExclusive'
  | 'writeManagedBinaryExclusive'
  | 'removeManagedFile'
  | 'removeManagedFolderIfEmpty'
>;

export type ClaudeSkillMigrationSourceKind = 'skill' | 'command' | 'other';
export type ClaudeSkillMigrationSourceStatus =
  | 'review-required'
  | 'conversion-policy-required'
  | 'symlink-not-inspected'
  | 'missing-skill-markdown'
  | 'invalid-skill'
  | 'unreadable'
  | 'unsupported-entry';
export type ClaudeSkillMigrationTargetStatus =
  | 'absent'
  | 'entry'
  | 'symlink'
  | 'ambiguous'
  | 'unknown';

export interface ClaudeSkillMigrationPreviewEntry {
  kind: ClaudeSkillMigrationSourceKind;
  name: string;
  sourcePath: string;
  sourceStatus: ClaudeSkillMigrationSourceStatus;
  sourceFingerprint?: string;
  targetPath?: string;
  targetStatus: ClaudeSkillMigrationTargetStatus;
  additionalEntries: string[];
  diagnostic?: string;
}

export interface ClaudeSkillMigrationPreview {
  entries: ClaudeSkillMigrationPreviewEntry[];
  diagnostics: string[];
  applyAvailable: boolean;
}

interface FolderReadResult {
  entries: ManagedFolderEntry[];
  readable: boolean;
}

interface PackageManifestEntry {
  kind: 'file' | 'folder';
  path: string;
  relativePath: string;
  digest?: string;
}

interface PackageInspection {
  entries: PackageManifestEntry[];
  fingerprint: string;
  skillMarkdown?: string;
}

class UnsafePackageEntryError extends Error {
  constructor(readonly status: 'symlink-not-inspected' | 'unsupported-entry', message: string) {
    super(message);
    this.name = 'UnsafePackageEntryError';
  }
}

export class ClaudeSkillMigrationError extends Error {
  constructor(readonly code: 'stale-preview' | 'invalid-selection', message: string) {
    super(message);
    this.name = 'ClaudeSkillMigrationError';
  }
}

export class ClaudeSkillMigrationRollbackError extends Error {
  readonly rollbackErrors: readonly Error[];

  constructor(cause: unknown, rollbackErrors: Error[]) {
    super('Skill migration failed and rollback was incomplete', { cause });
    this.name = 'ClaudeSkillMigrationRollbackError';
    this.rollbackErrors = rollbackErrors;
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function digest(bytes: ArrayBuffer): string {
  return createHash('sha256').update(new Uint8Array(bytes)).digest('hex');
}

function isSafeEntryName(name: string): boolean {
  return Boolean(name)
    && name !== '.'
    && name !== '..'
    && !name.includes('/')
    && !name.includes('\\');
}

function entryPath(parent: string, name: string): string {
  return `${parent}/${name}`;
}

function compareManifestEntries(left: PackageManifestEntry, right: PackageManifestEntry): number {
  if (left.kind !== right.kind) return left.kind === 'folder' ? -1 : 1;
  if (left.kind === 'folder' && right.kind === 'folder') {
    return left.relativePath.split('/').length - right.relativePath.split('/').length
      || left.relativePath.localeCompare(right.relativePath);
  }
  const leftSkill = left.relativePath === 'SKILL.md';
  const rightSkill = right.relativePath === 'SKILL.md';
  if (leftSkill !== rightSkill) return leftSkill ? 1 : -1;
  return left.relativePath.localeCompare(right.relativePath);
}

export class ClaudeSkillMigrationPreviewer {
  constructor(protected readonly files: PreviewStorage) {}

  async preview(): Promise<ClaudeSkillMigrationPreview> {
    const diagnostics: string[] = [];
    const [claudeSkills, claudeCommands, sharedSkills] = await Promise.all([
      this.listOptionalFolder(CLAUDE_SKILLS_ROOT, diagnostics),
      this.listOptionalFolder(CLAUDE_COMMANDS_ROOT, diagnostics),
      this.listOptionalFolder(SHARED_SKILLS_ROOT, diagnostics),
    ]);
    const targets = this.indexTargets(sharedSkills);
    const entries = [
      ...await this.previewSkills(claudeSkills, targets, sharedSkills.readable, diagnostics),
      ...this.previewCommands(claudeCommands, targets, sharedSkills.readable),
    ].sort((left, right) => (
      left.sourcePath.localeCompare(right.sourcePath)
      || left.kind.localeCompare(right.kind)
    ));
    const applyAvailable = entries.some(entry => (
      entry.kind === 'skill'
      && entry.sourceStatus === 'review-required'
      && entry.targetStatus === 'absent'
      && Boolean(entry.sourceFingerprint)
    ));

    return { entries, diagnostics, applyAvailable };
  }

  protected async inspectSkillPackage(
    rootPath: string,
    name: string,
  ): Promise<PackageInspection> {
    const manifest: PackageManifestEntry[] = [];
    const hash = createHash('sha256');
    let skillMarkdown: string | undefined;

    const walk = async (folderPath: string, parentRelativePath: string): Promise<void> => {
      const directEntries = await this.files.listManagedFolderEntries(folderPath);
      for (const entry of directEntries) {
        if (!isSafeEntryName(entry.name) || entry.path !== entryPath(folderPath, entry.name)) {
          throw new UnsafePackageEntryError(
            'unsupported-entry',
            `Unexpected package entry path: ${entry.path}`,
          );
        }
        const relativePath = parentRelativePath
          ? `${parentRelativePath}/${entry.name}`
          : entry.name;
        if (entry.kind === 'symlink') {
          throw new UnsafePackageEntryError(
            'symlink-not-inspected',
            `Linked package entry was not inspected: ${entry.path}`,
          );
        }
        if (entry.kind === 'other') {
          throw new UnsafePackageEntryError(
            'unsupported-entry',
            `Unsupported package entry: ${entry.path}`,
          );
        }
        if (entry.kind === 'folder') {
          manifest.push({ kind: 'folder', path: entry.path, relativePath });
          hash.update(JSON.stringify(['folder', relativePath]));
          await walk(entry.path, relativePath);
          continue;
        }

        let bytes: ArrayBuffer;
        try {
          bytes = await this.files.readManagedBinary(entry.path);
        } catch (error) {
          throw new Error(`Could not read ${entry.path}: ${messageOf(error)}`, { cause: error });
        }
        const fileDigest = digest(bytes);
        manifest.push({ kind: 'file', path: entry.path, relativePath, digest: fileDigest });
        hash.update(JSON.stringify(['file', relativePath, fileDigest]));
        if (relativePath === 'SKILL.md') {
          skillMarkdown = Buffer.from(bytes).toString('utf8');
        }
      }
    };

    await walk(rootPath, '');
    if (skillMarkdown === undefined) {
      throw new Error('SKILL.md is missing from skill package');
    }
    parseAgentSkillMarkdown(skillMarkdown, name);
    manifest.sort(compareManifestEntries);
    return { entries: manifest, fingerprint: hash.digest('hex'), skillMarkdown };
  }

  private async listOptionalFolder(
    folder: string,
    diagnostics: string[],
  ): Promise<FolderReadResult> {
    try {
      const exists = await this.files.verifyManagedPath(folder, {
        expectedType: 'folder',
        allowMissing: true,
      });
      if (!exists) return { entries: [], readable: true };
      return {
        entries: await this.files.listManagedFolderEntries(folder),
        readable: true,
      };
    } catch (error) {
      diagnostics.push(`Could not inspect ${folder}: ${messageOf(error)}`);
      return { entries: [], readable: false };
    }
  }

  private indexTargets(sharedSkills: FolderReadResult): Map<string, ManagedFolderEntry[]> {
    const targets = new Map<string, ManagedFolderEntry[]>();
    if (!sharedSkills.readable) return targets;
    for (const entry of sharedSkills.entries) {
      const key = entry.name.toLowerCase();
      targets.set(key, [...(targets.get(key) ?? []), entry]);
    }
    return targets;
  }

  private targetStatus(
    name: string,
    targets: Map<string, ManagedFolderEntry[]>,
    sharedSkillsReadable: boolean,
  ): ClaudeSkillMigrationTargetStatus {
    if (!sharedSkillsReadable) return 'unknown';
    const matches = targets.get(name.toLowerCase()) ?? [];
    if (matches.length === 0) return 'absent';
    if (matches.length > 1) return 'ambiguous';
    return matches[0].kind === 'symlink' ? 'symlink' : 'entry';
  }

  private async previewSkills(
    source: FolderReadResult,
    targets: Map<string, ManagedFolderEntry[]>,
    sharedSkillsReadable: boolean,
    diagnostics: string[],
  ): Promise<ClaudeSkillMigrationPreviewEntry[]> {
    if (!source.readable) return [];
    const results: ClaudeSkillMigrationPreviewEntry[] = [];

    for (const entry of source.entries) {
      const name = entry.name;
      const result: ClaudeSkillMigrationPreviewEntry = {
        kind: 'skill',
        name,
        sourcePath: entry.path,
        sourceStatus: 'unsupported-entry',
        targetPath: `${SHARED_SKILLS_ROOT}/${name}`,
        targetStatus: this.targetStatus(name, targets, sharedSkillsReadable),
        additionalEntries: [],
      };

      if (entry.kind === 'symlink') {
        result.sourceStatus = 'symlink-not-inspected';
        results.push(result);
        continue;
      }
      if (entry.kind !== 'folder') {
        results.push(result);
        continue;
      }
      if (validateAgentSkillName(name)) {
        result.sourceStatus = 'invalid-skill';
        result.diagnostic = 'Skill directory name is not portable';
        results.push(result);
        continue;
      }

      try {
        const inspection = await this.inspectSkillPackage(entry.path, name);
        result.sourceStatus = 'review-required';
        result.sourceFingerprint = inspection.fingerprint;
        result.additionalEntries = inspection.entries
          .filter(child => child.relativePath !== 'SKILL.md')
          .map(child => child.path);
      } catch (error) {
        if (error instanceof UnsafePackageEntryError) {
          result.sourceStatus = error.status;
          result.diagnostic = error.message;
        } else if (messageOf(error) === 'SKILL.md is missing from skill package') {
          result.sourceStatus = 'missing-skill-markdown';
        } else if (error instanceof Error && error.name === 'AgentSkillCodecError') {
          result.sourceStatus = 'invalid-skill';
          result.diagnostic = error.message;
        } else {
          result.sourceStatus = 'unreadable';
          result.diagnostic = messageOf(error);
          diagnostics.push(`Could not inspect ${entry.path}: ${result.diagnostic}`);
        }
      }
      results.push(result);
    }

    return results;
  }

  private previewCommands(
    source: FolderReadResult,
    targets: Map<string, ManagedFolderEntry[]>,
    sharedSkillsReadable: boolean,
  ): ClaudeSkillMigrationPreviewEntry[] {
    if (!source.readable) return [];
    return source.entries.map((entry): ClaudeSkillMigrationPreviewEntry => {
      const isMarkdown = entry.name.toLowerCase().endsWith('.md');
      const name = isMarkdown ? entry.name.slice(0, -3) : entry.name;
      const sourceStatus: ClaudeSkillMigrationSourceStatus = entry.kind === 'symlink'
        ? 'symlink-not-inspected'
        : entry.kind === 'file' && isMarkdown
          ? 'conversion-policy-required'
          : 'unsupported-entry';
      return {
        kind: sourceStatus === 'unsupported-entry' ? 'other' : 'command',
        name,
        sourcePath: entry.path,
        sourceStatus,
        targetPath: isMarkdown ? `${SHARED_SKILLS_ROOT}/${name}` : undefined,
        targetStatus: isMarkdown
          ? this.targetStatus(name, targets, sharedSkillsReadable)
          : 'absent',
        additionalEntries: [],
      };
    });
  }
}

export class ClaudeSkillMigration extends ClaudeSkillMigrationPreviewer {
  private mutationQueue: Promise<void> = Promise.resolve();

  constructor(private readonly migrationFiles: MigrationStorage) {
    super(migrationFiles);
  }

  async apply(selected: ClaudeSkillMigrationPreviewEntry): Promise<void> {
    const operation = this.mutationQueue.then(() => this.applySelected(selected));
    this.mutationQueue = operation.then(() => undefined, () => undefined);
    await operation;
  }

  private async applySelected(selected: ClaudeSkillMigrationPreviewEntry): Promise<void> {
    if (
      selected.kind !== 'skill'
      || !selected.sourceFingerprint
      || selected.sourcePath !== `${CLAUDE_SKILLS_ROOT}/${selected.name}`
      || selected.targetPath !== `${SHARED_SKILLS_ROOT}/${selected.name}`
    ) {
      throw new ClaudeSkillMigrationError('invalid-selection', 'Selected item is not a migratable Claude skill');
    }

    const preview = await this.preview();
    const fresh = preview.entries.find(entry => entry.sourcePath === selected.sourcePath);
    if (
      !fresh
      || fresh.kind !== 'skill'
      || fresh.sourceStatus !== 'review-required'
      || fresh.targetStatus !== 'absent'
      || !fresh.sourceFingerprint
      || fresh.sourceFingerprint !== selected.sourceFingerprint
    ) {
      throw new ClaudeSkillMigrationError('stale-preview', 'Skill changed or destination is no longer empty; refresh preview');
    }

    const manifest = await this.inspectSkillPackage(selected.sourcePath, selected.name);
    if (manifest.fingerprint !== selected.sourceFingerprint) {
      throw new ClaudeSkillMigrationError('stale-preview', 'Skill changed after preview; refresh preview');
    }

    const createdFolders: string[] = [];
    const createdFiles: string[] = [];
    try {
      for (const parent of SHARED_SKILLS_PARENTS) {
        const exists = await this.migrationFiles.verifyManagedPath(parent, {
          expectedType: 'folder',
          allowMissing: true,
        });
        if (exists) continue;
        await this.migrationFiles.createManagedFolderExclusive(parent);
        createdFolders.push(parent);
      }

      await this.migrationFiles.createManagedFolderExclusive(fresh.targetPath!);
      createdFolders.push(fresh.targetPath!);

      for (const entry of manifest.entries.filter(item => item.kind === 'folder')) {
        await this.migrationFiles.verifyManagedPath(entry.path, { expectedType: 'folder' });
        const targetPath = `${fresh.targetPath}/${entry.relativePath}`;
        await this.migrationFiles.createManagedFolderExclusive(targetPath);
        createdFolders.push(targetPath);
      }

      for (const entry of manifest.entries.filter(item => item.kind === 'file')) {
        await this.migrationFiles.verifyManagedPath(entry.path, { expectedType: 'file' });
        const bytes = await this.migrationFiles.readManagedBinary(entry.path);
        if (digest(bytes) !== entry.digest) {
          throw new ClaudeSkillMigrationError('stale-preview', 'Skill changed during migration; refresh preview');
        }
        const targetPath = `${fresh.targetPath}/${entry.relativePath}`;
        await this.migrationFiles.writeManagedBinaryExclusive(targetPath, bytes);
        createdFiles.push(targetPath);
      }

      const copied = await this.inspectSkillPackage(fresh.targetPath!, selected.name);
      if (copied.fingerprint !== manifest.fingerprint) {
        throw new Error('Copied skill package did not match source bytes');
      }
      const sourceAfterCopy = await this.inspectSkillPackage(selected.sourcePath, selected.name);
      if (sourceAfterCopy.fingerprint !== manifest.fingerprint) {
        throw new ClaudeSkillMigrationError('stale-preview', 'Source changed during migration; refresh preview');
      }
    } catch (error) {
      const rollbackErrors: Error[] = [];
      for (const file of [...createdFiles].reverse()) {
        try {
          await this.migrationFiles.removeManagedFile(file);
        } catch (rollbackError) {
          rollbackErrors.push(toError(rollbackError));
        }
      }
      for (const folder of [...createdFolders].reverse()) {
        try {
          await this.migrationFiles.removeManagedFolderIfEmpty(folder);
        } catch (rollbackError) {
          rollbackErrors.push(toError(rollbackError));
        }
      }
      if (rollbackErrors.length > 0) {
        throw new ClaudeSkillMigrationRollbackError(error, rollbackErrors);
      }
      throw error;
    }
  }
}
