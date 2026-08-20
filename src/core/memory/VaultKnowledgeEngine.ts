import type { App, TFile } from 'obsidian';

import type { VaultFileAdapter } from '../storage/VaultFileAdapter';

const KNOWLEDGE_FILE = '.claudian/awareness/vault-knowledge.json';

export interface NoteKnowledge {
  path: string;
  title: string;
  tags: string[];
  headings: string[];
  wordCount: number;
  lastModified: number;
}

export interface VaultKnowledgeIndex {
  version: 1;
  lastScanAt: number;
  noteCount: number;
  totalWords: number;
  notes: NoteKnowledge[];
  tagCloud: Record<string, number>;
  folderStructure: string[];
}

export interface VaultKnowledgeConfig {
  enabled: boolean;
  maxNotes: number;
  excludeFolders: string[];
  excludePatterns: string[];
}

export const DEFAULT_VAULT_KNOWLEDGE_CONFIG: VaultKnowledgeConfig = {
  enabled: false,
  maxNotes: 500,
  excludeFolders: ['.obsidian', '.trash', '.claudian', 'node_modules', 'templates'],
  excludePatterns: ['*.canvas', '*.excalidraw'],
};

/**
 * Builds a local metadata index on demand. Prompt injection deliberately uses
 * only aggregate metadata; note bodies remain in the vault unless explicitly
 * attached to a chat.
 */
export class VaultKnowledgeEngine {
  private config: VaultKnowledgeConfig;
  private index: VaultKnowledgeIndex | null = null;

  constructor(
    private readonly app: App,
    private readonly adapter: VaultFileAdapter,
    config?: Partial<VaultKnowledgeConfig>,
  ) {
    this.config = { ...DEFAULT_VAULT_KNOWLEDGE_CONFIG, ...config };
  }

  updateConfig(config: Partial<VaultKnowledgeConfig>): void {
    this.config = { ...this.config, ...config };
  }

  async loadIndex(): Promise<VaultKnowledgeIndex | null> {
    if (this.index) return this.index;
    if (!await this.adapter.exists(KNOWLEDGE_FILE)) return null;
    try {
      const parsed: unknown = JSON.parse(await this.adapter.read(KNOWLEDGE_FILE));
      if (!this.isIndex(parsed)) return null;
      this.index = parsed;
      return parsed;
    } catch {
      return null;
    }
  }

  async scanVault(onProgress?: (current: number, total: number) => void): Promise<VaultKnowledgeIndex> {
    const files = this.filterFiles(this.app.vault.getMarkdownFiles());
    const selected = files.slice(0, this.config.maxNotes || files.length);
    const notes: NoteKnowledge[] = [];
    const tagCloud: Record<string, number> = {};
    const folders = new Set<string>();

    for (const [index, file] of selected.entries()) {
      onProgress?.(index + 1, selected.length);
      try {
        const note = await this.extractNoteKnowledge(file);
        notes.push(note);
        for (const tag of note.tags) tagCloud[tag] = (tagCloud[tag] ?? 0) + 1;
        const folder = file.path.split('/').slice(0, -1).join('/');
        if (folder) folders.add(folder);
      } catch {
        // A locked or malformed note must not abort an explicit scan.
      }
    }

    const result: VaultKnowledgeIndex = {
      version: 1,
      lastScanAt: Date.now(),
      noteCount: notes.length,
      totalWords: notes.reduce((total, note) => total + note.wordCount, 0),
      notes,
      tagCloud,
      folderStructure: [...folders].sort(),
    };
    await this.adapter.write(KNOWLEDGE_FILE, JSON.stringify(result, null, 2));
    this.index = result;
    return result;
  }

  async getKnowledgeSummary(): Promise<string | null> {
    const index = await this.loadIndex();
    if (!index || index.noteCount === 0) return null;
    const tags = Object.entries(index.tagCloud)
      .sort(([, left], [, right]) => right - left)
      .slice(0, 10)
      .map(([tag, count]) => `${tag} (${count})`)
      .join(', ');
    const folders = index.folderStructure.slice(0, 10).join(', ');
    return [
      '### Vault Knowledge Summary',
      `- Notes: ${index.noteCount}`,
      `- Words: ${index.totalWords.toLocaleString()}`,
      tags ? `- Top tags: ${tags}` : '',
      folders ? `- Folders: ${folders}` : '',
      `- Last scan: ${new Date(index.lastScanAt).toLocaleString()}`,
    ].filter(Boolean).join('\n');
  }

  async clearIndex(): Promise<void> {
    await this.adapter.delete(KNOWLEDGE_FILE);
    this.index = null;
  }

  private filterFiles(files: TFile[]): TFile[] {
    return files.filter(file => {
      const segments = file.path.split('/');
      if (this.config.excludeFolders.some(folder => segments.includes(folder))) return false;
      return !this.config.excludePatterns.some(pattern => this.matchesPattern(file.path, pattern));
    });
  }

  private matchesPattern(path: string, pattern: string): boolean {
    return pattern.startsWith('*.') ? path.endsWith(pattern.slice(1)) : path.includes(pattern);
  }

  private async extractNoteKnowledge(file: TFile): Promise<NoteKnowledge> {
    const content = await this.app.vault.read(file);
    const cache = this.app.metadataCache.getFileCache(file);
    const frontmatterTags = cache?.frontmatter?.tags;
    const tags = [
      ...(Array.isArray(frontmatterTags)
        ? frontmatterTags.filter((tag): tag is string => typeof tag === 'string')
        : typeof frontmatterTags === 'string'
          ? frontmatterTags.split(',').map(tag => tag.trim())
          : []),
      ...(cache?.tags?.map(tag => tag.tag.replace(/^#/, '')) ?? []),
    ];
    return {
      path: file.path,
      title: file.basename,
      tags: [...new Set(tags.filter(Boolean))],
      headings: cache?.headings?.map(heading => heading.heading) ?? [],
      wordCount: content.split(/\s+/).filter(Boolean).length,
      lastModified: file.stat.mtime,
    };
  }

  private isIndex(value: unknown): value is VaultKnowledgeIndex {
    return !!value
      && typeof value === 'object'
      && (value as { version?: unknown }).version === 1
      && Array.isArray((value as { notes?: unknown }).notes)
      && typeof (value as { noteCount?: unknown }).noteCount === 'number';
  }
}
