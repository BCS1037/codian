import { McpServerCatalog } from '@/core/mcp/McpServerCatalog';

describe('McpServerCatalog', () => {
  it('loads provider-owned servers once and exposes read-only catalog queries', async () => {
    const load = jest.fn().mockResolvedValue([
      { name: 'enabled', config: { command: 'enabled' }, enabled: true, contextSaving: false },
      { name: 'context', config: { command: 'context' }, enabled: true, contextSaving: true },
      { name: 'disabled', config: { command: 'disabled' }, enabled: false, contextSaving: true },
    ]);
    const catalog = new McpServerCatalog({ load });

    await catalog.ensureLoaded();
    await catalog.ensureLoaded();

    expect(load).toHaveBeenCalledTimes(1);
    expect(catalog.getEnabledCount()).toBe(2);
    expect(catalog.hasServers()).toBe(true);
    expect(catalog.getContextSavingServers().map(server => server.name)).toEqual(['context']);
  });

  it('retries after a provider catalog failure', async () => {
    const load = jest.fn()
      .mockRejectedValueOnce(new Error('temporary failure'))
      .mockResolvedValueOnce([]);
    const catalog = new McpServerCatalog({ load });

    await expect(catalog.loadServers()).rejects.toThrow('temporary failure');
    await expect(catalog.loadServers()).resolves.toBeUndefined();

    expect(catalog.isLoaded()).toBe(true);
    expect(catalog.getServers()).toEqual([]);
  });
});
