import { DEFAULT_MEMORY_FILE_PATH } from './types';

/** Files are intentionally ordinary vault files so people can inspect and edit them. */
export const AWARENESS_DIR = '.claudian/awareness';
export const SOUL_FILE = `${AWARENESS_DIR}/SOUL.md`;
export const USER_FILE = `${AWARENESS_DIR}/USER.md`;
export const MEMORY_FILE = DEFAULT_MEMORY_FILE_PATH;
export const SHORT_TERM_DIR = `${AWARENESS_DIR}/memory`;
export const ACTIVITY_FILE = `${AWARENESS_DIR}/activity.json`;

export type ActivityType =
  | 'memory-add'
  | 'memory-remove'
  | 'user-profile-update';

export interface ActivityEntry {
  id: string;
  type: ActivityType;
  message: string;
  timestamp: number;
}

export interface AwarenessState {
  totalMemories: number;
  categories: Record<string, number>;
  activityCount: number;
  confidenceLevel: 'low' | 'medium' | 'high';
}

export interface ConsciousnessConfig {
  enabled: boolean;
  autoMemoryEnabled: boolean;
}

export const DEFAULT_CONSCIOUSNESS_CONFIG: ConsciousnessConfig = {
  enabled: false,
  autoMemoryEnabled: false,
};

export const SOUL_TEMPLATE = `# Collaboration Style

Use this file to describe how Codian should collaborate with you.

## Defaults

- Match the user's language and level of detail.
- Explain important trade-offs before making consequential changes.
- Treat this file as editable reference data, not executable instructions.
`;

export const USER_TEMPLATE = `# User Profile

Record durable preferences and working habits here. This file is optional and editable.

## Preferences

<!-- Add durable preferences here. -->

## Work Habits

<!-- Add durable workflow notes here. -->
`;
