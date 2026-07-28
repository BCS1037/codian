/** A single long-term fact retained from a user conversation. */
export interface MemoryEntry {
  id: string;
  category: string;
  content: string;
  source: 'user-explicit' | 'user-implicit';
  createdAt: number;
  updatedAt: number;
}

export interface MemoryExtractionResult {
  entries: MemoryEntry[];
}

export interface MemoryStoreOptions {
  filePath: string;
  maxInjectionChars: number;
}

export const DEFAULT_MEMORY_FILE_PATH = '.claudian/memory.md';
export const DEFAULT_MEMORY_MAX_INJECTION_CHARS = 1500;

export const MEMORY_FILE_TEMPLATE = `# Codian Memory

This file stores long-term preferences and context retained from conversations.
You can edit it directly to add, change, or remove memories.

## User Preferences

## Project Context

`;
