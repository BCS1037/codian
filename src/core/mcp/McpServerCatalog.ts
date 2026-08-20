import type { ManagedMcpServer } from '../types';

/** Storage interface for loading provider-owned MCP catalogs. */
export interface McpStorageAdapter {
  load(): Promise<ManagedMcpServer[]>;
}

/** Read-only catalog contract shared by MCP-aware UI and Provider workspace services. */
export class McpServerCatalog {
  private servers: ManagedMcpServer[] = [];
  private loadPromise: Promise<void> | null = null;
  private loaded = false;

  constructor(private readonly storage: McpStorageAdapter) {}

  async loadServers(): Promise<void> {
    if (this.loadPromise) {
      return this.loadPromise;
    }

    const promise = this.storage.load().then((servers) => {
      this.servers = servers;
      this.loaded = true;
    });
    this.loadPromise = promise;
    try {
      await promise;
    } finally {
      if (this.loadPromise === promise) {
        this.loadPromise = null;
      }
    }
  }

  async ensureLoaded(): Promise<void> {
    if (this.loaded) {
      return;
    }
    await this.loadServers();
  }

  isLoaded(): boolean {
    return this.loaded;
  }

  getServers(): ManagedMcpServer[] {
    return this.servers;
  }

  getEnabledCount(): number {
    return this.servers.filter(server => server.enabled).length;
  }

  hasServers(): boolean {
    return this.servers.length > 0;
  }

  getContextSavingServers(): ManagedMcpServer[] {
    return this.servers.filter(server => server.enabled && server.contextSaving);
  }
}
