import { Notice } from 'obsidian';

import { SharedStorageService } from '@/app/storage/SharedStorageService';

describe('SharedStorageService', () => {
  function createPluginDataMigrationHarness(options: {
    currentPluginId?: string;
    currentData?: unknown;
    legacyData?: string | null;
  }) {
    const legacyDataPath = '.obsidian/plugins/codian/data.json';
    const adapter = {
      exists: jest.fn().mockImplementation(async (path: string) => path === legacyDataPath && options.legacyData !== null),
      read: jest.fn().mockImplementation(async (path: string) => {
        if (path === legacyDataPath && options.legacyData !== null) return options.legacyData;
        throw new Error(`Missing test file: ${path}`);
      }),
      write: jest.fn(),
      mkdir: jest.fn(),
    };
    const plugin = {
      app: { vault: { adapter } },
      manifest: { id: options.currentPluginId ?? 'codianz' },
      loadData: jest.fn().mockResolvedValue(options.currentData),
      saveData: jest.fn().mockResolvedValue(undefined),
    } as any;

    return { adapter, plugin };
  }

  it('migrates legacy codian plugin data into an empty codianz plugin data store', async () => {
    const legacyData = JSON.stringify({
      tabManagerState: {
        activeTabId: 'tab-1',
        openTabs: [{ tabId: 'tab-1', conversationId: 'conversation-1' }],
      },
    });
    const { adapter, plugin } = createPluginDataMigrationHarness({
      currentData: null,
      legacyData,
    });
    const storage = new SharedStorageService(plugin);

    const result = await storage.initialize();

    expect(adapter.read).toHaveBeenCalledWith('.obsidian/plugins/codian/data.json');
    expect(plugin.saveData).toHaveBeenCalledWith(JSON.parse(legacyData));
    expect(result.migratedLegacyPluginData).toBe(true);
  });

  it('preserves existing codianz plugin data instead of overwriting it with legacy data', async () => {
    const { adapter, plugin } = createPluginDataMigrationHarness({
      currentData: { tabManagerState: { activeTabId: 'new-tab', openTabs: [] } },
      legacyData: JSON.stringify({ tabManagerState: { activeTabId: 'old-tab', openTabs: [] } }),
    });
    const storage = new SharedStorageService(plugin);

    const result = await storage.initialize();

    expect(adapter.read).not.toHaveBeenCalledWith('.obsidian/plugins/codian/data.json');
    expect(plugin.saveData).not.toHaveBeenCalled();
    expect(result.migratedLegacyPluginData).toBe(false);
  });

  it('does not create codianz plugin data from malformed legacy data', async () => {
    const { plugin } = createPluginDataMigrationHarness({
      currentData: null,
      legacyData: '{not valid json',
    });
    const storage = new SharedStorageService(plugin);

    await storage.initialize();

    expect(plugin.saveData).not.toHaveBeenCalled();
  });

  it('does not migrate plugin data when running under the legacy codian plugin id', async () => {
    const { adapter, plugin } = createPluginDataMigrationHarness({
      currentPluginId: 'codian',
      currentData: null,
      legacyData: JSON.stringify({ tabManagerState: { activeTabId: 'old-tab', openTabs: [] } }),
    });
    const storage = new SharedStorageService(plugin);

    await storage.initialize();

    expect(adapter.read).not.toHaveBeenCalledWith('.obsidian/plugins/codian/data.json');
    expect(plugin.saveData).not.toHaveBeenCalled();
  });

  it('does not create storage directories during read-only initialization', async () => {
    const adapter = {
      exists: jest.fn().mockResolvedValue(false),
      read: jest.fn(),
      write: jest.fn(),
      mkdir: jest.fn(),
    };
    const plugin = {
      app: { vault: { adapter } },
      manifest: { id: 'codian' },
    } as any;
    const storage = new SharedStorageService(plugin);

    await storage.initialize();

    expect(adapter.mkdir).not.toHaveBeenCalled();
    expect(adapter.write).not.toHaveBeenCalled();
  });

  it('reports and propagates tab layout persistence failures', async () => {
    const error = new Error('disk full');
    const plugin = {
      app: { vault: { adapter: {} } },
      loadData: jest.fn().mockResolvedValue({ existing: true }),
      saveData: jest.fn().mockRejectedValue(error),
    } as any;
    const storage = new SharedStorageService(plugin);

    await expect(storage.setTabManagerState({
      activeTabId: null,
      openTabs: [],
    })).rejects.toBe(error);
    expect(Notice).toHaveBeenCalledWith('Failed to save tab layout');
  });
});
