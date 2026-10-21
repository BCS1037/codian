import { getDefaultHiddenProviderCommands } from '../../core/providers/commands/hiddenCommands';
import { DEFAULT_REASONING_VALUE } from '../../core/providers/reasoning';
import { type CodianSettings } from '../../core/types/settings';
import { getBuiltInProviderDefaultConfigs } from '../../providers/defaultProviderConfigs';

export const DEFAULT_CODIAN_SETTINGS: CodianSettings = {
  userName: '',

  permissionMode: 'yolo',

  model: 'haiku',
  thinkingBudget: 'off',
  effortLevel: DEFAULT_REASONING_VALUE,
  serviceTier: 'default',
  enableAutoTitleGeneration: true,
  titleGenerationLocale: '',
  titleGenerationModel: '',

  excludedTags: [],
  mediaFolder: '',
  systemPrompt: '',
  persistentExternalContextPaths: [],

  sharedEnvironmentVariables: '',
  envSnippets: [],
  customContextLimits: {},
  customModelAliases: {},

  keyboardNavigation: {
    scrollUpKey: 'w',
    scrollDownKey: 's',
    focusInputKey: 'i',
  },
  requireCommandOrControlEnterToSend: false,
  enableLivePreviewComposer: true,

  providerConfigs: getBuiltInProviderDefaultConfigs(),

  defaultChatProviderId: '',
  settingsProvider: 'claude',
  inlineEditModel: null,
  savedProviderModel: {},
  savedProviderEffort: {},
  savedProviderServiceTier: {},
  savedProviderThinkingBudget: {},
  savedProviderPermissionMode: {},
  pendingProviderSessionInvalidations: {},

  lastCustomModel: '',

  maxTabs: 3,
  tabLimitBehavior: 'temporary',
  enableAutoScroll: true,
  deferMathRenderingDuringStreaming: true,
  pluginRenderedFenceLanguages: [],
  expandFileEditsByDefault: false,
  chatViewPlacement: 'right-sidebar',
  chatNavigationMode: 'conversation-rail',

  hiddenProviderCommands: getDefaultHiddenProviderCommands(),
};
