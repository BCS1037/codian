import type { Plugin } from 'obsidian';
import { Notice } from 'obsidian';

import { SessionStorage } from '../../core/bootstrap/SessionStorage';
import type { SharedAppStorage } from '../../core/bootstrap/storage';
import {
  CODIAN_SETTINGS_PATH,
  CODIAN_STORAGE_PATH,
  LEGACY_CODIAN_STORAGE_PATH,
} from '../../core/bootstrap/StoragePaths';
import {
  isValidTabManagerState,
  normalizeTabManagerState,
} from '../../core/bootstrap/tabManagerState';
import type { AppTabManagerState } from '../../core/providers/types';
import { VaultFileAdapter } from '../../core/storage/VaultFileAdapter';
import { CodianSettingsStorage, type StoredCodianSettings } from '../settings/CodianSettingsStorage';

const LEGACY_PLUGIN_ID = 'codian';
const CURRENT_PLUGIN_ID = 'codianz';

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export class SharedStorageService implements SharedAppStorage {
  readonly codianSettings: CodianSettingsStorage;
  readonly sessions: SessionStorage;

  private adapter: VaultFileAdapter;
  private plugin: Plugin;

  constructor(plugin: Plugin) {
    this.plugin = plugin;
    this.adapter = new VaultFileAdapter(plugin.app);
    this.codianSettings = new CodianSettingsStorage(this.adapter);
    this.sessions = new SessionStorage(this.adapter);
  }

  async initialize(): Promise<{
    codianz: Record<string, unknown>;
    migratedLegacyPluginData: boolean;
  }> {
    const migratedLegacyPluginData = await this.migrateLegacyPluginData();
    await this.migrateLegacyClaudianStorage();
    const codian = await this.codianSettings.load();
    return { codianz: codian, migratedLegacyPluginData };
  }

  async saveCodianSettings(settings: Record<string, unknown>): Promise<void> {
    await this.codianSettings.save(settings as StoredCodianSettings);
  }

  async setTabManagerState(state: AppTabManagerState): Promise<void> {
    try {
      if (!isValidTabManagerState(state)) {
        throw new TypeError('Invalid tab manager state');
      }
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
    const legacyFiles = await this.adapter.listFilesRecursive(LEGACY_CODIAN_STORAGE_PATH);
    for (const legacyPath of legacyFiles) {
      const targetPath = legacyPath === `${LEGACY_CODIAN_STORAGE_PATH}/codian-settings.json`
        ? CODIAN_SETTINGS_PATH
        : `${CODIAN_STORAGE_PATH}${legacyPath.slice(LEGACY_CODIAN_STORAGE_PATH.length)}`;
      if (await this.adapter.exists(targetPath)) {
        continue;
      }
      await this.adapter.write(targetPath, await this.adapter.read(legacyPath));
    }
  }

  private async migrateLegacyPluginData(): Promise<boolean> {
    if (this.plugin.manifest.id !== CURRENT_PLUGIN_ID) {
      return false;
    }

    try {
      const currentData = await this.plugin.loadData();
      if (currentData !== null && currentData !== undefined) {
        return false;
      }

      const legacyDataPath = `.obsidian/plugins/${LEGACY_PLUGIN_ID}/data.json`;
      if (!(await this.adapter.exists(legacyDataPath))) {
        return false;
      }

      const legacyData = JSON.parse(await this.adapter.read(legacyDataPath));
      await this.plugin.saveData(legacyData);
      return true;
    } catch {
      // Keep startup available when old plugin data cannot be migrated.
      return false;
    }
  }

}
