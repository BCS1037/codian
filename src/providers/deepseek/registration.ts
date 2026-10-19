import type { ProviderModule } from '../../core/providers/types';
import { deepseekWorkspaceRegistration } from './app/DeepSeekWorkspaceServices';
import { DeepSeekInlineEditService } from './auxiliary/DeepSeekInlineEditService';
import { DeepSeekInstructionRefineService } from './auxiliary/DeepSeekInstructionRefineService';
import { DeepSeekTaskResultInterpreter } from './auxiliary/DeepSeekTaskResultInterpreter';
import { DeepSeekTitleGenerationService } from './auxiliary/DeepSeekTitleGenerationService';
import { DEEPSEEK_PROVIDER_CAPABILITIES } from './capabilities';
import { deepseekSettingsReconciler } from './env/DeepSeekSettingsReconciler';
import { DeepSeekConversationHistoryService } from './history/DeepSeekConversationHistoryService';
import { deepseekSubagentAdapter } from './normalization/DeepSeekSubagents';
import { DeepSeekChatRuntime } from './runtime/DeepSeekChatRuntime';
import {
  getDeepSeekProviderSettings,
  updateDeepSeekProviderSettings,
} from './settings';
import { deepseekChatUIConfig } from './ui/DeepSeekChatUIConfig';

export const deepseekProviderRegistration: ProviderModule = {
  id: 'deepseek',
  displayName: 'DeepSeek Harness',
  displayOrder: 35,
  blankTabOrder: 13,
  capabilities: DEEPSEEK_PROVIDER_CAPABILITIES,
  chatUIConfig: deepseekChatUIConfig,
  createInlineEditService: plugin => new DeepSeekInlineEditService(plugin),
  createInstructionRefineService: plugin => new DeepSeekInstructionRefineService(plugin),
  createRuntime: ({ plugin }) => new DeepSeekChatRuntime(plugin),
  createTitleGenerationService: plugin => new DeepSeekTitleGenerationService(plugin),
  environmentKeyPatterns: [/^DSH_/i, /^DEEPSEEK_/i],
  historyService: new DeepSeekConversationHistoryService(async () => {
    const { getDeepSeekWorkspaceServices } = await import('./app/DeepSeekWorkspaceServices');
    return getDeepSeekWorkspaceServices().deepseek;
  }),
  isEnabled: settings => getDeepSeekProviderSettings(settings).enabled,
  setEnabled: (settings, enabled) => {
    updateDeepSeekProviderSettings(settings, { enabled });
  },
  settingsReconciler: deepseekSettingsReconciler,
  settingsStorage: {
    hostScopedFields: ['cliPathsByHost'],
    normalizeStored(target, stored) {
      updateDeepSeekProviderSettings(target, getDeepSeekProviderSettings(stored));
      return false;
    },
  },
  subagentAdapter: deepseekSubagentAdapter,
  taskResultInterpreter: new DeepSeekTaskResultInterpreter(),
  workspace: deepseekWorkspaceRegistration,
};
