import type { ProviderCapabilities } from '../../core/providers/types';
import { t } from '../../i18n/i18n';

export const CODEX_PROVIDER_CAPABILITIES: Readonly<ProviderCapabilities> = Object.freeze({
  providerId: 'codex',
  supportsPersistentRuntime: true,
  supportsNativeHistory: true,
  supportsPlanMode: true,
  supportsRewind: false,
  supportsFork: true,
  supportsProviderCommands: true,
  supportsImageAttachments: true,
  supportsInstructionMode: true,
  supportsMcpTools: false,
  mcpSelectorMode: 'display-only',
  mcpDisplayOnlyNotice: () => t('settings.codex.mcp.manageHint'),
  supportsSharedAgentSkills: true,
  supportsTurnSteer: true,
  reasoningControl: 'effort',
});
