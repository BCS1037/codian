import type { VaultFileAdapter } from '../storage/VaultFileAdapter';
import {
  DEFAULT_MEMORY_FILE_PATH,
  DEFAULT_MEMORY_MAX_INJECTION_CHARS,
  MEMORY_FILE_TEMPLATE,
  type MemoryEntry,
  type MemoryStoreOptions,
} from './types';

interface MemorySection {
  category: string;
  items: string[];
}

function generateMemoryId(): string {
  return `mem_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeMemoryContent(content: string): string {
  return content.trim().replace(/\s+/g, ' ').toLocaleLowerCase();
}

/** Persists editable, category-grouped memories in one Markdown file. */
export class MemoryStore {
  private options: MemoryStoreOptions;
  private mutationTail: Promise<void> = Promise.resolve();

  constructor(
    private readonly adapter: VaultFileAdapter,
    options?: Partial<MemoryStoreOptions>,
  ) {
    this.options = {
      filePath: options?.filePath || DEFAULT_MEMORY_FILE_PATH,
      maxInjectionChars: options?.maxInjectionChars ?? DEFAULT_MEMORY_MAX_INJECTION_CHARS,
    };
  }

  get filePath(): string {
    return this.options.filePath;
  }

  updateOptions(options: Partial<MemoryStoreOptions>): void {
    if (options.filePath !== undefined) this.options.filePath = options.filePath;
    if (options.maxInjectionChars !== undefined) this.options.maxInjectionChars = options.maxInjectionChars;
  }

  async load(): Promise<MemoryEntry[]> {
    if (!await this.adapter.exists(this.options.filePath)) return [];
    return this.parseMarkdown(await this.adapter.read(this.options.filePath));
  }

  async save(entries: MemoryEntry[]): Promise<void> {
    await this.enqueueMutation(() => this.writeEntries(entries));
  }

  async add(entry: Omit<MemoryEntry, 'id' | 'createdAt' | 'updatedAt'>): Promise<MemoryEntry> {
    return this.enqueueMutation(async () => {
      await this.ensureFileExists();
      const existing = await this.load();
      const duplicate = existing.find(candidate => (
        normalizeMemoryContent(candidate.content) === normalizeMemoryContent(entry.content)
      ));
      if (duplicate) return duplicate;

      const now = Date.now();
      const fullEntry: MemoryEntry = {
        ...entry,
        id: generateMemoryId(),
        createdAt: now,
        updatedAt: now,
      };
      await this.writeEntries([...existing, fullEntry]);
      return fullEntry;
    });
  }

  async remove(searchTerm: string): Promise<number> {
    const normalizedSearch = searchTerm.trim().toLocaleLowerCase();
    if (!normalizedSearch) return 0;

    return this.enqueueMutation(async () => {
      const existing = await this.load();
      const remaining = existing.filter(entry => (
        !entry.content.toLocaleLowerCase().includes(normalizedSearch)
      ));
      const removed = existing.length - remaining.length;
      if (removed > 0) await this.writeEntries(remaining);
      return removed;
    });
  }

  async buildInjectionText(): Promise<string | null> {
    const entries = await this.load();
    if (entries.length === 0) return null;

    let text = '';
    for (const section of this.groupByCategory(entries)) {
      const heading = `### ${section.category}\n`;
      if (text.length + heading.length > this.options.maxInjectionChars) break;
      text += heading;
      for (const item of section.items) {
        const line = `- ${item}\n`;
        if (text.length + line.length > this.options.maxInjectionChars) {
          return text.trim() || null;
        }
        text += line;
      }
    }
    return text.trim() || null;
  }

  private async ensureFileExists(): Promise<void> {
    if (!await this.adapter.exists(this.options.filePath)) {
      await this.adapter.write(this.options.filePath, MEMORY_FILE_TEMPLATE);
    }
  }

  private writeEntries(entries: MemoryEntry[]): Promise<void> {
    return this.adapter.write(this.options.filePath, this.serializeMarkdown(entries));
  }

  private async enqueueMutation<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.mutationTail;
    let release!: () => void;
    this.mutationTail = new Promise<void>(resolve => { release = resolve; });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private parseMarkdown(content: string): MemoryEntry[] {
    const entries: MemoryEntry[] = [];
    let category = 'General';
    let index = 0;
    for (const rawLine of content.split('\n')) {
      const line = rawLine.trim();
      if (!line || line.startsWith('# ') || line.startsWith('This file stores') || line.startsWith('<!--') || line.startsWith('-->')) continue;
      const heading = line.match(/^##\s+(.+)$/);
      if (heading) {
        category = heading[1].trim();
        continue;
      }
      const item = line.match(/^[-*+]\s+(.+)$/);
      if (item?.[1].trim()) {
        entries.push({
          id: `mem_parsed_${index++}`,
          category,
          content: item[1].trim(),
          source: 'user-explicit',
          createdAt: 0,
          updatedAt: 0,
        });
      }
    }
    return entries;
  }

  private serializeMarkdown(entries: MemoryEntry[]): string {
    const sections = this.groupByCategory(entries);
    const present = new Set(sections.map(section => section.category));
    for (const category of ['User Preferences', 'Project Context']) {
      if (!present.has(category)) sections.push({ category, items: [] });
    }
    return [
      '# Codian Memory',
      '',
      'This file stores long-term preferences and context retained from conversations.',
      'You can edit it directly to add, change, or remove memories.',
      '',
      ...sections.flatMap(section => [
        `## ${section.category}`,
        ...section.items.map(item => `- ${item}`),
        '',
      ]),
    ].join('\n');
  }

  private groupByCategory(entries: MemoryEntry[]): MemorySection[] {
    const grouped = new Map<string, string[]>();
    for (const entry of entries) {
      const items = grouped.get(entry.category) ?? [];
      items.push(entry.content);
      grouped.set(entry.category, items);
    }
    return Array.from(grouped, ([category, items]) => ({ category, items }));
  }
}
