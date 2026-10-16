import { Modal } from 'obsidian';

import { t } from '../../../i18n/i18n';
import type { TranslationKey } from '../../../i18n/types';
import type { ClaudeSkillMigration } from '../skills/ClaudeSkillMigration';
import { ClaudeSkillMigrationError } from '../skills/ClaudeSkillMigration';
import type {
  ClaudeSkillMigrationPreviewEntry,
  ClaudeSkillMigrationSourceStatus,
  ClaudeSkillMigrationTargetStatus,
} from '../skills/ClaudeSkillMigrationPreview';

const SOURCE_STATUS_KEYS: Record<ClaudeSkillMigrationSourceStatus, TranslationKey> = {
  'conversion-policy-required': 'settings.skillMigration.status.conversionPolicyRequired',
  'invalid-skill': 'settings.skillMigration.status.invalidSkill',
  'missing-skill-markdown': 'settings.skillMigration.status.missingSkillMarkdown',
  'review-required': 'settings.skillMigration.status.reviewRequired',
  'symlink-not-inspected': 'settings.skillMigration.status.symlinkNotInspected',
  'unreadable': 'settings.skillMigration.status.unreadable',
  'unsupported-entry': 'settings.skillMigration.status.unsupportedEntry',
};

const TARGET_STATUS_KEYS: Record<ClaudeSkillMigrationTargetStatus, TranslationKey> = {
  absent: 'settings.skillMigration.target.absent',
  ambiguous: 'settings.skillMigration.target.ambiguous',
  entry: 'settings.skillMigration.target.entry',
  symlink: 'settings.skillMigration.target.symlink',
  unknown: 'settings.skillMigration.target.unknown',
};

export class ClaudeSkillMigrationPreviewModal extends Modal {
  private closed = false;
  private busy = false;
  private selectedPaths = new Set<string>();
  private previewEntries: ClaudeSkillMigrationPreviewEntry[] = [];
  private resultsEl!: HTMLElement;
  private controlsEl!: HTMLElement;
  private statusEl!: HTMLElement;
  private applyButton?: HTMLButtonElement;

  constructor(app: ConstructorParameters<typeof Modal>[0], private readonly migration: ClaudeSkillMigration) {
    super(app);
  }

  onOpen(): void {
    this.closed = false;
    this.contentEl.empty();
    this.contentEl.createEl('h2', { text: t('settings.skillMigration.modalTitle') });
    this.contentEl.createEl('p', { text: t('settings.skillMigration.selectInstruction') });
    this.controlsEl = this.contentEl.createDiv({ cls: 'codian-skill-migration-controls' });
    this.statusEl = this.contentEl.createDiv({ cls: 'codian-skill-migration-status' });
    this.resultsEl = this.contentEl.createDiv({ cls: 'codian-skill-migration-preview' });
    this.resultsEl.setText(t('settings.skillMigration.loading'));
    void this.renderPreview();
  }

  onClose(): void {
    this.closed = true;
    this.contentEl.empty();
  }

  private async renderPreview(): Promise<void> {
    let result;
    try {
      result = await this.migration.preview();
    } catch {
      if (!this.closed) this.resultsEl.setText(t('settings.skillMigration.failed'));
      return;
    }
    if (this.closed || !this.resultsEl.isConnected) return;

    this.previewEntries = result.entries;
    const eligiblePaths = new Set(result.entries
      .filter(entry => this.isEligible(entry))
      .map(entry => entry.sourcePath));
    this.selectedPaths = new Set([...this.selectedPaths].filter(path => eligiblePaths.has(path)));

    this.resultsEl.empty();
    this.controlsEl.empty();
    this.applyButton = undefined;
    if (result.entries.length === 0) {
      this.resultsEl.createEl('p', { text: t('settings.skillMigration.empty') });
    } else {
      for (const entry of result.entries) this.renderEntry(entry);
    }

    if (result.applyAvailable) {
      this.applyButton = this.controlsEl.createEl('button', {
        text: t('settings.skillMigration.applySelected'),
      });
      this.applyButton.disabled = this.selectedPaths.size === 0 || this.busy;
      this.applyButton.addEventListener('click', () => void this.applySelected());
    }

    if (result.diagnostics.length > 0) {
      const diagnostics = this.resultsEl.createDiv({ cls: 'codian-skill-migration-preview-diagnostics' });
      diagnostics.createEl('h3', { text: t('settings.skillMigration.diagnostics') });
      for (const diagnostic of result.diagnostics) {
        diagnostics.createEl('p', { text: diagnostic });
      }
    }
  }

  private renderEntry(entry: ClaudeSkillMigrationPreviewEntry): void {
    const row = this.resultsEl.createDiv({ cls: 'codian-skill-migration-preview-entry' });
    if (this.isEligible(entry)) {
      const checkbox = row.createEl('input', {
        attr: { type: 'checkbox', 'aria-label': entry.name },
      });
      checkbox.checked = this.selectedPaths.has(entry.sourcePath);
      checkbox.disabled = this.busy;
      checkbox.addEventListener('change', () => {
        if (checkbox.checked) this.selectedPaths.add(entry.sourcePath);
        else this.selectedPaths.delete(entry.sourcePath);
        if (this.applyButton) {
          this.applyButton.disabled = this.selectedPaths.size === 0 || this.busy;
        }
      });
    }
    row.createEl('h3', {
      text: `${entry.name} · ${t(SOURCE_STATUS_KEYS[entry.sourceStatus])}`,
    });
    row.createEl('code', { text: entry.sourcePath });
    row.createEl('p', {
      text: `${entry.targetPath ?? ''} · ${t(TARGET_STATUS_KEYS[entry.targetStatus])}`,
    });
    if (entry.additionalEntries.length > 0) {
      row.createEl('p', {
        text: `${t('settings.skillMigration.additionalEntries')} ${entry.additionalEntries.join(', ')}`,
      });
    }
    if (entry.diagnostic) {
      row.createEl('p', {
        text: `${t('settings.skillMigration.diagnostic')} ${entry.diagnostic}`,
      });
    }
  }

  private isEligible(entry: ClaudeSkillMigrationPreviewEntry): boolean {
    return entry.kind === 'skill'
      && entry.sourceStatus === 'review-required'
      && entry.targetStatus === 'absent'
      && Boolean(entry.sourceFingerprint);
  }

  private async applySelected(): Promise<void> {
    if (this.busy || this.selectedPaths.size === 0) return;
    this.busy = true;
    if (this.applyButton) this.applyButton.disabled = true;
    const selected = this.previewEntries.filter(entry => this.selectedPaths.has(entry.sourcePath));
    const migrated: string[] = [];
    const failures: Array<{ name: string; error: string }> = [];

    for (const entry of selected) {
      try {
        await this.migration.apply(entry);
        migrated.push(entry.name);
      } catch (error) {
        failures.push({
          name: entry.name,
          error: error instanceof ClaudeSkillMigrationError && error.code === 'stale-preview'
            ? t('settings.skillMigration.stalePreview')
            : error instanceof Error ? error.message : String(error),
        });
      }
    }

    this.selectedPaths.clear();
    this.statusEl.empty();
    if (migrated.length > 0) {
      this.statusEl.createEl('p', {
        text: `${t('settings.skillMigration.migrationSucceeded')} ${migrated.join(', ')}`,
      });
    }
    for (const failure of failures) {
      this.statusEl.createEl('p', {
        text: `${t('settings.skillMigration.migrationFailed')} ${failure.name}: ${failure.error}`,
      });
    }
    this.busy = false;
    await this.renderPreview();
  }
}
