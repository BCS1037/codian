import type {
  ProviderPermissionModeOption,
  ProviderPermissionModePolicy,
  ProviderPermissionModeToggleConfig,
} from '@/core/providers/types';

export const DEEPSEEK_PERMISSION_MODES = ['normal', 'yolo'] as const;

export const DEEPSEEK_PERMISSION_MODE_POLICY: ProviderPermissionModePolicy = Object.freeze({
  values: DEEPSEEK_PERMISSION_MODES,
  defaultValue: 'normal',
  fallbackValue: 'normal',
});

export const DEEPSEEK_PERMISSION_MODE_OPTIONS: readonly ProviderPermissionModeOption[] = Object.freeze([
  { value: 'normal', label: 'Workspace write', description: 'Ask before extra access.' },
  { value: 'yolo', label: 'Full access', description: 'Unrestricted files and internet.', bypassesApprovals: true },
]);

export const DEEPSEEK_PERMISSION_MODE_TOGGLE: ProviderPermissionModeToggleConfig = Object.freeze({
  inactiveValue: 'normal',
  inactiveLabel: 'Workspace write',
  activeValue: 'yolo',
  activeLabel: 'Full access',
});
