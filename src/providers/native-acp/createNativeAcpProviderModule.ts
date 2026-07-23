import { QueryBackedInlineEditService } from '../../core/auxiliary/QueryBackedInlineEditService';
import { QueryBackedInstructionRefineService } from '../../core/auxiliary/QueryBackedInstructionRefineService';
import { QueryBackedTitleGenerationService } from '../../core/auxiliary/QueryBackedTitleGenerationService';
import type { ProviderHost } from '../../core/providers/ProviderHost';
import type {
  ProviderCapabilities,
  ProviderChatUIConfig,
  ProviderModule,
} from '../../core/providers/types';
import { createNativeAcpWorkspaceRegistration } from './app/createNativeAcpWorkspaceRegistration';
import { NativeAcpAuxQueryRunner } from './runtime/NativeAcpAuxQueryRunner';
import { NativeAcpChatRuntime } from './runtime/NativeAcpChatRuntime';
import type { NativeAcpSessionAdapter } from './runtime/types';
import {
  NativeAcpConversationHistoryService,
  nativeAcpSettingsReconciler,
  NativeAcpTaskResultInterpreter,
} from './services';
import { getNativeAcpProviderSettings, updateNativeAcpProviderSettings } from './settings';
import { createNativeAcpChatUIConfig } from './ui/createNativeAcpChatUIConfig';

export interface NativeAcpProviderModuleOptions {
  displayOrder: number;
  args: string[];
  capabilities: ProviderCapabilities;
  displayName: string;
  environmentKeyPatterns: RegExp[];
  id: string;
  defaultCommand: string;
  chatUIConfig?: ProviderChatUIConfig;
  createSessionAdapter?: (plugin: ProviderHost) => NativeAcpSessionAdapter;
}

export function createNativeAcpProviderModule(
  options: NativeAcpProviderModuleOptions,
): ProviderModule {
  const runtimeOptions = {
    args: options.args,
    capabilities: options.capabilities,
    defaultCommand: options.defaultCommand,
    providerId: options.id,
  };
  const createRunner = (plugin: Parameters<ProviderModule['createRuntime']>[0]['plugin']) => (
    new NativeAcpAuxQueryRunner(plugin, {
      ...runtimeOptions,
      sessionAdapter: options.createSessionAdapter?.(plugin),
    })
  );

  return {
    id: options.id,
    displayOrder: options.displayOrder,
    capabilities: options.capabilities,
    chatUIConfig: options.chatUIConfig ?? createNativeAcpChatUIConfig(options.id, options.displayName),
    createInlineEditService: plugin => new QueryBackedInlineEditService(createRunner(plugin)),
    createInstructionRefineService: plugin => new QueryBackedInstructionRefineService(createRunner(plugin)),
    createRuntime: ({ plugin }) => new NativeAcpChatRuntime(plugin, {
      ...runtimeOptions,
      sessionAdapter: options.createSessionAdapter?.(plugin),
    }),
    createTitleGenerationService: plugin => new QueryBackedTitleGenerationService({
      createRunner: () => createRunner(plugin),
    }),
    displayName: options.displayName,
    environmentKeyPatterns: options.environmentKeyPatterns,
    historyService: new NativeAcpConversationHistoryService(),
    isEnabled: settings => getNativeAcpProviderSettings(settings, options.id).enabled,
    setEnabled: (settings, enabled) => {
      updateNativeAcpProviderSettings(settings, options.id, { enabled });
    },
    settingsReconciler: nativeAcpSettingsReconciler,
    settingsStorage: {
      hostScopedFields: ['cliPathsByHost'],
      normalizeStored(target, stored) {
        updateNativeAcpProviderSettings(
          target,
          options.id,
          getNativeAcpProviderSettings(stored, options.id),
        );
        return false;
      },
    },
    taskResultInterpreter: new NativeAcpTaskResultInterpreter(),
    workspace: createNativeAcpWorkspaceRegistration({
      defaultCommand: options.defaultCommand,
      displayName: options.displayName,
      providerId: options.id,
    }),
  };
}
