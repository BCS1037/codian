import { parseEnvironmentVariables } from '../../../utils/env';

export const CLAUDE_SERVICE_PRESET_IDS = [
  'custom',
  'cstcloud',
  'aliyun-coding-plan',
  'aliyun-token-plan',
  'aliyun-payg',
  'volcengine-coding-plan',
] as const;

export type ClaudeServicePresetId = typeof CLAUDE_SERVICE_PRESET_IDS[number];
export type ClaudeServiceAuthMode = 'api-key' | 'auth-token';

export interface ClaudeThirdPartyService {
  id: string;
  name: string;
  preset: ClaudeServicePresetId;
  baseUrl: string;
  authMode: ClaudeServiceAuthMode;
  secretId: string;
  defaultModel: string;
  lightweightModel: string;
  enabled: boolean;
  advancedEnvironmentVariables: string;
}

export interface ClaudeServicePreset {
  id: ClaudeServicePresetId;
  name: string;
  baseUrl: string;
  authMode: ClaudeServiceAuthMode;
}

const PRESETS: Readonly<Record<ClaudeServicePresetId, ClaudeServicePreset>> = {
  custom: {
    id: 'custom',
    name: '自定义服务',
    baseUrl: '',
    authMode: 'auth-token',
  },
  cstcloud: {
    id: 'cstcloud',
    name: '中国科技云',
    baseUrl: 'https://uni-api.cstcloud.cn',
    authMode: 'api-key',
  },
  'aliyun-coding-plan': {
    id: 'aliyun-coding-plan',
    name: '阿里百炼 · Coding Plan',
    baseUrl: 'https://coding.dashscope.aliyuncs.com/apps/anthropic',
    authMode: 'auth-token',
  },
  'aliyun-token-plan': {
    id: 'aliyun-token-plan',
    name: '阿里百炼 · Token Plan',
    baseUrl: 'https://token-plan.cn-beijing.maas.aliyuncs.com/apps/anthropic',
    authMode: 'auth-token',
  },
  'aliyun-payg': {
    id: 'aliyun-payg',
    name: '阿里百炼 · 按量付费（北京）',
    baseUrl: 'https://dashscope.aliyuncs.com/apps/anthropic',
    authMode: 'auth-token',
  },
  'volcengine-coding-plan': {
    id: 'volcengine-coding-plan',
    name: '火山方舟 · Coding Plan',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/coding',
    authMode: 'auth-token',
  },
};

const OWNED_ENVIRONMENT_KEYS = new Set([
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_FABLE_MODEL',
  'CLAUDE_CODE_SUBAGENT_MODEL',
]);

const SERVICE_MODEL_PREFIX = 'claude-code/service/';

function isPresetId(value: unknown): value is ClaudeServicePresetId {
  return typeof value === 'string'
    && (CLAUDE_SERVICE_PRESET_IDS as readonly string[]).includes(value);
}

function isAuthMode(value: unknown): value is ClaudeServiceAuthMode {
  return value === 'api-key' || value === 'auth-token';
}

function readTrimmedString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function resolveClaudeServicePreset(id: ClaudeServicePresetId): ClaudeServicePreset {
  return { ...PRESETS[id] };
}

export function getClaudeServicePresets(): ClaudeServicePreset[] {
  return CLAUDE_SERVICE_PRESET_IDS.map(resolveClaudeServicePreset);
}

export function createClaudeServiceSecretId(serviceId: string): string {
  const normalized = serviceId.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-');
  return `codian-claude-${normalized}`;
}

export function normalizeClaudeThirdPartyServices(value: unknown): ClaudeThirdPartyService[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const services: ClaudeThirdPartyService[] = [];
  const seenIds = new Set<string>();
  for (const entry of value) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      continue;
    }
    const record = entry as Record<string, unknown>;
    const id = readTrimmedString(record.id);
    const name = readTrimmedString(record.name);
    const baseUrl = readTrimmedString(record.baseUrl).replace(/\/$/, '');
    const defaultModel = readTrimmedString(record.defaultModel);
    if (!id || !name || !baseUrl || !defaultModel || seenIds.has(id)) {
      continue;
    }

    const preset = isPresetId(record.preset) ? record.preset : 'custom';
    const lightweightModel = readTrimmedString(record.lightweightModel) || defaultModel;
    seenIds.add(id);
    services.push({
      id,
      name,
      preset,
      baseUrl,
      authMode: isAuthMode(record.authMode) ? record.authMode : PRESETS[preset].authMode,
      secretId: readTrimmedString(record.secretId) || createClaudeServiceSecretId(id),
      defaultModel,
      lightweightModel,
      enabled: record.enabled === true,
      advancedEnvironmentVariables: readTrimmedString(record.advancedEnvironmentVariables),
    });
  }
  return services;
}

export function encodeClaudeServiceModelSelection(serviceId: string, modelId: string): string {
  return `${SERVICE_MODEL_PREFIX}${encodeURIComponent(serviceId.trim())}/${encodeURIComponent(modelId.trim())}`;
}

export function decodeClaudeServiceModelSelection(
  value: string,
): { serviceId: string; modelId: string } | null {
  if (!value.startsWith(SERVICE_MODEL_PREFIX)) {
    return null;
  }
  const remainder = value.slice(SERVICE_MODEL_PREFIX.length);
  const separator = remainder.indexOf('/');
  if (separator <= 0 || separator === remainder.length - 1) {
    return null;
  }
  try {
    const serviceId = decodeURIComponent(remainder.slice(0, separator)).trim();
    const modelId = decodeURIComponent(remainder.slice(separator + 1)).trim();
    return serviceId && modelId ? { serviceId, modelId } : null;
  } catch {
    return null;
  }
}

export function findClaudeThirdPartyService(
  services: readonly ClaudeThirdPartyService[],
  serviceId: string,
): ClaudeThirdPartyService | null {
  return services.find(service => service.id === serviceId) ?? null;
}

export function buildClaudeServiceEnvironment(
  service: ClaudeThirdPartyService,
  secret: string,
): Record<string, string> {
  const advanced = parseEnvironmentVariables(service.advancedEnvironmentVariables);
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(advanced)) {
    if (!OWNED_ENVIRONMENT_KEYS.has(key)) {
      env[key] = value;
    }
  }

  env[service.authMode === 'api-key' ? 'ANTHROPIC_API_KEY' : 'ANTHROPIC_AUTH_TOKEN'] = secret;
  env.ANTHROPIC_BASE_URL = service.baseUrl;
  env.ANTHROPIC_MODEL = service.defaultModel;
  env.ANTHROPIC_DEFAULT_HAIKU_MODEL = service.lightweightModel;
  env.ANTHROPIC_DEFAULT_SONNET_MODEL = service.defaultModel;
  env.ANTHROPIC_DEFAULT_OPUS_MODEL = service.defaultModel;
  env.CLAUDE_CODE_SUBAGENT_MODEL = service.defaultModel;
  return env;
}

export interface ClaudeServiceRuntimeResolution {
  service: ClaudeThirdPartyService;
  modelId: string;
  environment: Record<string, string>;
}

export function resolveClaudeServiceRuntime(
  selection: string,
  services: readonly ClaudeThirdPartyService[],
  getSecret: (id: string) => string | null,
): ClaudeServiceRuntimeResolution | null {
  const decoded = decodeClaudeServiceModelSelection(selection);
  if (!decoded) {
    return null;
  }
  const service = findClaudeThirdPartyService(services, decoded.serviceId);
  if (!service) {
    return null;
  }
  const secret = getSecret(service.secretId)?.trim();
  if (!secret) {
    return null;
  }
  return {
    service,
    modelId: decoded.modelId,
    environment: buildClaudeServiceEnvironment(service, secret),
  };
}

export function applyClaudeServiceEnvironment(
  baseEnvironment: Record<string, string>,
  selection: string,
  services: readonly ClaudeThirdPartyService[],
  getSecret: (id: string) => string | null,
): Record<string, string> {
  const decoded = decodeClaudeServiceModelSelection(selection);
  if (!decoded) {
    return { ...baseEnvironment };
  }
  const resolution = resolveClaudeServiceRuntime(selection, services, getSecret);
  if (!resolution) {
    const service = findClaudeThirdPartyService(services, decoded.serviceId);
    throw new Error(service
      ? `Claude service "${service.name}" API key is unavailable.`
      : 'Claude service configuration is unavailable.');
  }

  const environment = { ...baseEnvironment };
  for (const key of OWNED_ENVIRONMENT_KEYS) {
    delete environment[key];
  }
  return { ...environment, ...resolution.environment };
}

export function resolveClaudeServiceLightweightSelection(
  selection: string,
  services: readonly ClaudeThirdPartyService[],
): string {
  const decoded = decodeClaudeServiceModelSelection(selection);
  if (!decoded) {
    return selection;
  }
  const service = findClaudeThirdPartyService(services, decoded.serviceId);
  if (!service) {
    return selection;
  }
  return encodeClaudeServiceModelSelection(service.id, service.lightweightModel);
}

function serializeEnvironmentVariables(
  environment: Record<string, string>,
  excludedKeys: ReadonlySet<string>,
): string {
  return Object.entries(environment)
    .filter(([key]) => !excludedKeys.has(key))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
}

export function migrateLegacyClaudeEnvironment(
  envText: string,
  context: {
    createId: () => string;
    setSecret: (id: string, value: string) => void;
  },
): {
  service: ClaudeThirdPartyService | null;
  remainingEnvironmentVariables: string;
} {
  const env = parseEnvironmentVariables(envText);
  const baseUrl = env.ANTHROPIC_BASE_URL?.trim();
  const authToken = env.ANTHROPIC_AUTH_TOKEN?.trim();
  const apiKey = env.ANTHROPIC_API_KEY?.trim();
  const secret = authToken || apiKey;
  if (!baseUrl || !secret) {
    return { service: null, remainingEnvironmentVariables: envText.trim() };
  }

  const id = context.createId();
  const secretId = createClaudeServiceSecretId(id);
  context.setSecret(secretId, secret);
  const defaultModel = env.ANTHROPIC_MODEL
    || env.ANTHROPIC_DEFAULT_SONNET_MODEL
    || env.ANTHROPIC_DEFAULT_OPUS_MODEL
    || 'default';
  const lightweightModel = env.ANTHROPIC_DEFAULT_HAIKU_MODEL || defaultModel;
  const advancedEnvironmentVariables = serializeEnvironmentVariables(env, OWNED_ENVIRONMENT_KEYS);

  return {
    service: {
      id,
      name: '已迁移的 Claude 服务',
      preset: 'custom',
      baseUrl: baseUrl.replace(/\/$/, ''),
      authMode: authToken ? 'auth-token' : 'api-key',
      secretId,
      defaultModel,
      lightweightModel,
      enabled: true,
      advancedEnvironmentVariables,
    },
    remainingEnvironmentVariables: '',
  };
}
