import * as de from '@/i18n/locales/de.json';
import * as en from '@/i18n/locales/en.json';
import * as es from '@/i18n/locales/es.json';
import * as fr from '@/i18n/locales/fr.json';
import * as ja from '@/i18n/locales/ja.json';
import * as ko from '@/i18n/locales/ko.json';
import * as pt from '@/i18n/locales/pt.json';
import * as ru from '@/i18n/locales/ru.json';
import * as zhCN from '@/i18n/locales/zh-CN.json';
import * as zhTW from '@/i18n/locales/zh-TW.json';

interface TranslationTree {
  [key: string]: string | TranslationTree;
}

const locales = {
  de,
  es,
  fr,
  ja,
  ko,
  pt,
  ru,
  'zh-CN': zhCN,
  'zh-TW': zhTW,
} as const;

const localizedKeys = [
  'common.enable',
  'common.disable',
  'chat.rewind.confirmMessageConversationOnly',
  'chat.rewind.confirmMessageConflicts',
  'chat.rewind.inProgress',
  'chat.rewind.menuConversationOnly',
  'chat.rewind.menuCodeAndConversation',
  'chat.rewind.noticeConversationOnly',
  'chat.rewind.noticeConversationOnlySaveFailed',
  'chat.fork.errorMessageNotFound',
  'chat.fork.errorNoSession',
  'chat.fork.errorNoActiveTab',
  'chat.bangBash.placeholder',
  'chat.bangBash.commandPanel',
  'chat.bangBash.copyAriaLabel',
  'chat.bangBash.clearAriaLabel',
  'chat.bangBash.statusLabel',
  'chat.bangBash.collapseOutput',
  'chat.bangBash.expandOutput',
  'chat.bangBash.running',
  'chat.bangBash.copyFailed',
  'settings.subagents.name',
  'settings.subagents.desc',
  'settings.subagents.noAgents',
  'settings.subagents.deleteConfirm',
  'settings.subagents.saveFailed',
  'settings.subagents.deleteFailed',
  'settings.subagents.renameCleanupFailed',
  'settings.subagents.created',
  'settings.subagents.updated',
  'settings.subagents.deleted',
  'settings.subagents.duplicateName',
  'settings.subagents.descriptionRequired',
  'settings.subagents.promptRequired',
  'settings.subagents.modal.titleEdit',
  'settings.subagents.modal.titleAdd',
  'settings.subagents.modal.nameDesc',
  'settings.subagents.modal.descriptionDesc',
  'settings.subagents.modal.descriptionPlaceholder',
  'settings.subagents.modal.advancedOptions',
  'settings.subagents.modal.modelDesc',
  'settings.subagents.modal.toolsDesc',
  'settings.subagents.modal.disallowedTools',
  'settings.subagents.modal.disallowedToolsDesc',
  'settings.subagents.modal.skills',
  'settings.subagents.modal.skillsDesc',
  'settings.subagents.modal.prompt',
  'settings.subagents.modal.promptDesc',
  'settings.subagents.modal.promptPlaceholder',
  'settings.enableBangBash.name',
  'settings.enableBangBash.desc',
  'settings.enableBangBash.validation.noNode',
  'settings.requireCommandOrControlEnterToSend.name',
  'settings.requireCommandOrControlEnterToSend.desc',
  'settings.livePreviewComposer.name',
  'settings.livePreviewComposer.desc',
  'settings.claudeSafeMode.name',
  'settings.claudeSafeMode.desc',
  'settings.codexSafeMode.name',
  'settings.codexSafeMode.desc',
  'settings.customModels.name',
  'settings.customModels.desc',
  'settings.providerEnablement.name',
  'settings.providerEnablement.desc',
  'settings.codex.customModels.name',
  'settings.codex.customModels.desc',
  'settings.codex.reasoningSummary.name',
  'settings.codex.skills.name',
  'settings.codex.subagents.name',
  'settings.codex.environment.name',
  'settings.codexSkills.noSkills',
  'settings.codexSubagents.noAgents',
  'settings.plugins.manager.label',
  'settings.plugins.manager.empty',
  'settings.plugins.manager.project',
  'settings.plugins.manager.user',
  'settings.plugins.manager.restartFailed',
  'settings.plugins.manager.toggled',
  'settings.plugins.manager.rollbackFailed',
  'settings.plugins.manager.toggleFailed',
  'settings.plugins.manager.refreshed',
  'settings.plugins.manager.refreshFailed',
  'settings.plugins.manager.unknownError',
  'settings.providerPermissions.name',
  'settings.providerPermissions.cliManagedDesc',
  'settings.providerPermissions.opencodeDesc',
  'settings.providerPermissions.piDesc',
  'settings.settingsHub.visibleModels',
  'settings.settingsHub.cliUnavailable',
  'settings.providerModels.browse',
  'settings.providerModels.searchPlaceholder',
  'settings.providerModels.discover',
  'settings.providerModels.loadingModels',
  'settings.providerModels.available',
  'settings.providerModels.noneDiscovered',
  'settings.providerModels.loading',
  'settings.providerModels.refresh',
  'settings.providerModels.selected',
  'settings.providerModels.clearAll',
  'settings.providerModels.clearAllAria',
  'settings.providerModels.aliasAria',
  'settings.providerModels.aliasTitle',
  'settings.providerModels.removeAria',
  'settings.providerModels.allProviders',
  'settings.providerModels.noMatches',
  'settings.providerModels.defaultBadge',
  'settings.providerModels.selectedModel',
  'settings.providerModels.notReported',
  'settings.opencode.commandsAndSkills',
  'settings.opencode.commandsAndSkillsDesc',
  'settings.opencode.hiddenCommandsAndSkills',
  'settings.opencode.hiddenCommandsAndSkillsDesc',
  'settings.opencode.subagents',
  'settings.opencode.subagentsDesc',
  'settings.opencode.environmentVariables',
  'settings.opencode.environmentVariablesDesc',
  'settings.pi.environmentVariables',
  'settings.pi.environmentVariablesDesc',
  'settings.providerCliPath.name',
  'settings.providerCliPath.desc',
  'settings.providerCliPath.notExist',
  'settings.providerCliPath.isDirectory',
  'settings.providerCatalog.empty',
  'settings.providerCatalog.failed',
  'settings.providerCatalog.loading',
  'settings.providerCatalog.discoveryFailed',
] as const;

const staleBangBashDesc =
  'Type ! on empty input to enter bash mode. Runs commands directly via Node.js child_process.';

function flattenTranslations(
  translations: TranslationTree,
  prefix = '',
  out: Record<string, string> = {}
): Record<string, string> {
  for (const [key, value] of Object.entries(translations)) {
    const nextKey = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === 'object') {
      flattenTranslations(value as TranslationTree, nextKey, out);
      continue;
    }

    out[nextKey] = String(value);
  }

  return out;
}

describe('locale files', () => {
  const english = flattenTranslations(en as unknown as TranslationTree);

  it('localizes conversation search copy in English and Simplified Chinese', () => {
    const simplifiedChinese = flattenTranslations(zhCN as unknown as TranslationTree);

    expect(english['chat.historySearch.placeholder']).toBe('Search conversations');
    expect(english['chat.historySearch.noMatches']).toBe('No matching conversations');
    expect(english['chat.historySearch.clear']).toBe('Clear search');
    expect(simplifiedChinese['chat.historySearch.placeholder']).toBe('搜索会话');
    expect(simplifiedChinese['chat.historySearch.noMatches']).toBe('没有匹配的会话');
    expect(simplifiedChinese['chat.historySearch.clear']).toBe('清除搜索');
  });

  it('keeps every locale structurally aligned with English', () => {
    const englishKeys = Object.keys(english).sort();

    for (const [locale, translations] of Object.entries(locales)) {
      const localeKeys = Object.keys(flattenTranslations(translations as unknown as TranslationTree)).sort();
      expect(localeKeys).toEqual(englishKeys);
      expect(locale).toBeTruthy();
    }
  });

  it('localizes the recent bang bash and subagent additions', () => {
    for (const translations of Object.values(locales)) {
      const locale = flattenTranslations(translations as unknown as TranslationTree);

      for (const key of localizedKeys) {
        expect(locale[key]).toBeDefined();
        expect(locale[key]).not.toBe(english[key]);
      }

      expect(locale['settings.enableBangBash.desc']).not.toBe(staleBangBashDesc);
    }
  });

  it('uses commands-and-skills copy for hidden Claude entries', () => {
    expect(english['settings.hiddenSlashCommands.name']).toBe('Hidden Commands and Skills');
    expect(english['settings.hiddenSlashCommands.desc']).toBe(
      'Hide specific commands and skills from the dropdown. Useful for hiding Claude Code entries that are not relevant to Claudian. Enter names without the leading slash, one per line.',
    );
  });

  it('localizes provider connection, model-management, and access terminology', () => {
    const simplifiedChinese = flattenTranslations(zhCN as unknown as TranslationTree);

    expect(english['settings.setup']).toBe('Connection');
    expect(english['settings.safety']).toBe('Access and isolation');
    expect(english['settings.claudeSafeMode.name']).toBe('Default execution permissions');
    expect(english['settings.codexSafeMode.name']).toBe('File access range');
    expect(english['settings.settingsHub.cliManagedModels']).toBe('Models managed by CLI');
    expect(simplifiedChinese['settings.setup']).toBe('连接');
    expect(simplifiedChinese['settings.safety']).toBe('权限与隔离');
    expect(simplifiedChinese['settings.claudeSafeMode.name']).toBe('默认执行权限');
    expect(simplifiedChinese['settings.codexSafeMode.name']).toBe('文件访问范围');
    expect(simplifiedChinese['settings.settingsHub.cliManagedModels']).toBe('模型由 CLI 管理');
    expect(simplifiedChinese['settings.settingsHub.defaultProvider']).toBe('默认提供商');
    expect(simplifiedChinese['settings.claudeSafeMode.acceptEdits']).toBe('自动接受文件编辑');
    expect(simplifiedChinese['settings.claudeSafeMode.desc']).not.toContain('Safe');
    expect(simplifiedChinese['settings.codexSafeMode.desc']).not.toContain('Safe');
    expect(simplifiedChinese['settings.plugins.manager.project']).toBe('项目扩展');
  });
});
