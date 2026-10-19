import { normalizeProviderCommandDiscoveryItems } from '../../../core/providers/commands/ProviderCommandDiscoveryResult';
import type {
  ProviderCommandDiscoveryResult,
  ProviderRuntimeCommandLoader,
  ProviderRuntimeCommandLoaderContext,
} from '../../../core/providers/types';
import type { SlashCommand } from '../../../core/types';
import { getVaultPath } from '../../../utils/path';
import { readDeepSeekCommands } from '../commands/DeepSeekCommandCatalog';
import { discoverDeepSeekLocalSkills, mergeDeepSeekCommands } from '../commands/DeepSeekSkillScanner';
import { readDeepSeekProjection } from '../history/DeepSeekJournal';
import { type DeepSeekReader, isRecord } from '../remote/DeepSeekRemoteClient';
import { isSameDeepSeekHome } from '../runtime/DeepSeekHome';
import type { DeepSeekHost } from '../runtime/DeepSeekHost';
import { getDeepSeekProviderSettings } from '../settings';
import { decodeDeepSeekState, type DeepSeekPreset, isDeepSeekAuxiliaryPreset } from '../types';

/** Saved roots inspected when a blank tab looks for a catalog with its vault. */
const CATALOG_CANDIDATES = 20;

/**
 * Discovers skills from ~/.dsh/skills, workspace .agents/skills, and the active/saved dsh session.
 */
export function createDeepSeekCommandLoader(deepseek: DeepSeekHost): ProviderRuntimeCommandLoader {
  return {
    getCacheFingerprint: (settings: Record<string, unknown>) =>
      `deepseek:commands:${getDeepSeekProviderSettings(settings).enabled}`,
    isAvailable: (settings: Record<string, unknown>) =>
      getDeepSeekProviderSettings(settings).enabled,
    async loadCommands({
      allowSessionCreation,
      conversation,
      plugin,
    }: ProviderRuntimeCommandLoaderContext): Promise<ProviderCommandDiscoveryResult<SlashCommand>> {
      const cwd = getVaultPath(plugin.app);
      const localSkills = await discoverDeepSeekLocalSkills(cwd ?? undefined);

      try {
        const saved = decodeDeepSeekState(conversation?.providerState);
        const hasSession = Boolean(
          conversation?.sessionId
          || saved?.pendingFork?.sessionId,
        );

        if (!hasSession && !allowSessionCreation) {
          return localSkills.length > 0
            ? normalizeProviderCommandDiscoveryItems(localSkills)
            : { status: 'empty' };
        }

        const runtimeCommands = await deepseek.read(async (reader, home) => {
          const own = saved && !isSameDeepSeekHome(saved.home, home)
            ? undefined
            : conversation?.sessionId ?? saved?.pendingFork?.sessionId;
          const sessionId = own ?? (cwd ? await findCatalogSession(reader, cwd) : undefined);
          return sessionId ? readDeepSeekCommands(reader, sessionId) : undefined;
        });

        if (runtimeCommands && runtimeCommands.length > 0) {
          const merged = mergeDeepSeekCommands(localSkills, runtimeCommands);
          return normalizeProviderCommandDiscoveryItems(merged);
        }

        return localSkills.length > 0
          ? normalizeProviderCommandDiscoveryItems(localSkills)
          : { status: 'empty' };
      } catch {
        return localSkills.length > 0
          ? normalizeProviderCommandDiscoveryItems(localSkills)
          : { status: 'empty' };
      }
    },
  };
}

async function findCatalogSession(reader: DeepSeekReader, cwd: string): Promise<string | undefined> {
  const listed = await reader.call('session/list', { _request: {} });
  if (!isRecord(listed) || !Array.isArray(listed.items)) throw new Error('Malformed DeepSeek session roster.');
  const roots = listed.items
    .filter(isRecord)
    .filter(row => typeof row.sessionId === 'string' && row.cwd === cwd && row.origin !== 'subagent')
    .sort((left, right) => Number(right.updatedAt) - Number(left.updatedAt))
    .slice(0, CATALOG_CANDIDATES);
  for (const row of roots) {
    const sessionId = row.sessionId as string;
    // Chat presets mount skills; auxiliary presets mount none.
    const preset = (await readDeepSeekProjection(reader, sessionId)).values.agentPreset;
    if (typeof preset === 'string' && !isDeepSeekAuxiliaryPreset(preset as DeepSeekPreset)) return sessionId;
  }
  return undefined;
}
