import type { VaultFileAdapter } from '@/core/storage/VaultFileAdapter';
import { MemoryStore } from '@/core/memory/MemoryStore';

function createAdapter(): VaultFileAdapter {
  const files = new Map<string, string>();
  return {
    exists: async (path: string) => files.has(path),
    read: async (path: string) => files.get(path) ?? '',
    write: async (path: string, content: string) => { files.set(path, content); },
  } as unknown as VaultFileAdapter;
}

describe('MemoryStore', () => {
  it('serializes concurrent writes and removes duplicates', async () => {
    const store = new MemoryStore(createAdapter());

    await Promise.all([
      store.add({ category: 'User Preferences', content: 'Prefers concise replies', source: 'user-explicit' }),
      store.add({ category: 'User Preferences', content: 'prefers concise replies', source: 'user-implicit' }),
      store.add({ category: 'Project Context', content: 'Project uses TypeScript', source: 'user-explicit' }),
    ]);

    await expect(store.load()).resolves.toMatchObject([
      { category: 'User Preferences', content: 'Prefers concise replies' },
      { category: 'Project Context', content: 'Project uses TypeScript' },
    ]);
  });

  it('bounds the injection text without splitting an entry', async () => {
    const store = new MemoryStore(createAdapter(), { maxInjectionChars: 55 });
    await store.add({ category: 'User Preferences', content: 'Likes compact release notes', source: 'user-explicit' });
    await store.add({ category: 'Project Context', content: 'Uses a provider-native workflow', source: 'user-explicit' });

    const text = await store.buildInjectionText();

    expect(text).toContain('Likes compact release notes');
    expect(text).not.toContain('Uses a provider-native workflow');
    expect(text!.length).toBeLessThanOrEqual(55);
  });

  it('removes matching entries from the editable Markdown store', async () => {
    const store = new MemoryStore(createAdapter());
    await store.add({ category: 'Rules', content: 'Use Conventional Commits', source: 'user-explicit' });

    await expect(store.remove('conventional')).resolves.toBe(1);
    await expect(store.load()).resolves.toEqual([]);
  });
});
