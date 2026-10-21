import type { ProviderId, ProviderReasoningOption, ProviderUIOption } from '../../core/providers/types';

export interface ModelPickerSettings {
  providerId: ProviderId;
  model: string;
  reasoning?: string | null;
  [key: string]: unknown;
}

export interface ModelPickerCallbacks {
  getSettings: () => ModelPickerSettings;
  getAvailableModels: () => ProviderUIOption[];
  onModelChange: (model: string, providerId: ProviderId) => Promise<void>;
  onEffortLevelChange: (effort: string) => Promise<void>;
  getEffortOptions?: (model: ProviderUIOption) => ProviderReasoningOption[];
  getEnvironmentVariables?: (providerId: ProviderId) => string;
}
