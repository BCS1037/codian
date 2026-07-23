import type { Plugin } from 'obsidian';
import { Notice } from 'obsidian';

import { SessionStorage } from '../../core/bootstrap/SessionStorage';
import type { SharedAppStorage } from '../../core/bootstrap/storage';
import {
  CLAUDIAN_SETTINGS_PATH,
  CLAUDIAN_STORAGE_PATH,
  LEGACY_CLAUDIAN_STORAGE_PATH,
} from '../../core/bootstrap/StoragePaths';
import { normalizeTabManagerState } from '../../core/bootstrap/tabManagerState';
import type { AppTabManagerState } from '../../core/providers/types';
import { VaultFileAdapter } from '../../core/storage/VaultFileAdapter';
import { ClaudianSettingsStorage, type StoredClaudianSettings } from '../settings/ClaudianSettingsStorage';

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export class SharedStorageService implements SharedAppStorage {
  readonly claudianSettings: ClaudianSettingsStorage;
  readonly sessions: SessionStorage;

  private adapter: VaultFileAdapter;
  private plugin: Plugin;

  constructor(plugin: Plugin) {
    this.plugin = plugin;
    this.adapter = new VaultFileAdapter(plugin.app);
    this.claudianSettings = new ClaudianSettingsStorage(this.adapter);
    this.sessions = new SessionStorage(this.adapter);
  }

  async initialize(): Promise<{ claudian: Record<string, unknown> }> {
    await this.migrateLegacyClaudianStorage();
    const claudian = await this.claudianSettings.load();
    return { claudian };
  }

  async saveClaudianSettings(settings: Record<string, unknown>): Promise<void> {
    await this.claudianSettings.save(settings as StoredClaudianSettings);
  }

  async setTabManagerState(state: AppTabManagerState): Promise<void> {
    try {
      const loaded: unknown = await this.plugin.loadData();
      const data = isRecord(loaded) ? loaded : {};
      data.tabManagerState = state;
      await this.plugin.saveData(data);
    } catch (error) {
      new Notice('Failed to save tab layout');
      throw error;
    }
  }

  async getTabManagerState(): Promise<AppTabManagerState | null> {
    try {
      const data: unknown = await this.plugin.loadData();
      if (!isRecord(data) || !data.tabManagerState) {
        return null;
      }

      return normalizeTabManagerState(data.tabManagerState);
    } catch {
      return null;
    }
  }

  getAdapter(): VaultFileAdapter {
    return this.adapter;
  }

  private async migrateLegacyClaudianStorage(): Promise<void> {
    const legacyFiles = await this.adapter.listFilesRecursive(LEGACY_CLAUDIAN_STORAGE_PATH);
    for (const legacyPath of legacyFiles) {
      const targetPath = legacyPath === `${LEGACY_CLAUDIAN_STORAGE_PATH}/claudian-settings.json`
        ? CLAUDIAN_SETTINGS_PATH
        : `${CLAUDIAN_STORAGE_PATH}${legacyPath.slice(LEGACY_CLAUDIAN_STORAGE_PATH.length)}`;
      if (await this.adapter.exists(targetPath)) {
        continue;
      }
      await this.adapter.write(targetPath, await this.adapter.read(legacyPath));
    }
  }

}
