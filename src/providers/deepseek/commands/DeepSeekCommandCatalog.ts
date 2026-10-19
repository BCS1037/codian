import type {
  ProviderCommandCatalog,
  ProviderCommandDropdownConfig,
  ProviderCommandListContext,
} from '@/core/providers/commands/ProviderCommandCatalog';
import type { ProviderCommandEntry } from '@/core/providers/commands/ProviderCommandEntry';
import type { SlashCommand } from '@/core/types';

import { type DeepSeekReader, isRecord } from '../remote/DeepSeekRemoteClient';
import { discoverDeepSeekLocalSkills } from './DeepSeekSkillScanner';

function slashCommandToEntry(command: SlashCommand): ProviderCommandEntry {
  return {
    agent: command.agent,
    allowedTools: command.allowedTools,
    argumentHint: command.argumentHint,
    content: command.content,
    context: command.context,
    description: command.description,
    disableModelInvocation: command.disableModelInvocation,
    displayPrefix: '/',
    hooks: command.hooks,
    id: command.id,
    insertPrefix: '/',
    isDeletable: false,
    isEditable: false,
    kind: command.kind ?? 'command',
    model: command.model,
    name: command.name,
    providerId: 'deepseek',
    scope: command.kind === 'skill' ? 'user' : 'runtime',
    source: command.source ?? 'sdk',
    userInvocable: command.userInvocable,
  };
}

export class DeepSeekCommandCatalog implements ProviderCommandCatalog {
  private runtimeCommands: SlashCommand[] = [];

  constructor(private readonly getVaultCwd?: () => string | undefined) {}

  setRuntimeCommands(commands: SlashCommand[]): void {
    this.runtimeCommands = commands.map(command => ({ ...command }));
  }

  async listDropdownEntries(context: ProviderCommandListContext): Promise<ProviderCommandEntry[]> {
    let commands = context.runtimeCommands;
    if (commands === undefined) {
      const allowCached = context.allowCachedRuntimeCommands !== false;
      if (allowCached && this.runtimeCommands.length > 0) {
        commands = this.runtimeCommands;
      } else if (this.runtimeCommands.length > 0) {
        commands = this.runtimeCommands;
      } else {
        commands = await discoverDeepSeekLocalSkills(this.getVaultCwd?.());
      }
    }
    return commands.map(slashCommandToEntry);
  }

  getDropdownConfig(): ProviderCommandDropdownConfig {
    return {
      builtInPrefix: '/',
      commandPrefix: '/',
      providerId: 'deepseek',
      skillPrefix: '/',
      triggerChars: ['/'],
    };
  }

  async refresh(): Promise<void> {
    this.runtimeCommands = [];
  }
}

export async function readDeepSeekCommands(client: DeepSeekReader, sessionId: string): Promise<SlashCommand[]> {
  const [commands, skills] = await Promise.all([
    client.call('commands/list', { agentId: sessionId }).catch(() => []),
    readDeepSeekSkills(client, sessionId).catch(() => []),
  ]);
  const commandList = Array.isArray(commands) ? commands : [];
  return [
    ...commandList.filter(isRecord).filter(command => command.name === 'compact').map(command => ({
      id: 'deepseek:command:compact', name: 'compact', description: typeof command.description === 'string' ? command.description : 'Compact history', content: '', source: 'sdk' as const, kind: 'command' as const,
    })),
    ...skills,
  ];
}

/** User-invocable skills of one session's composition; saved sessions are read without activation. */
export async function readDeepSeekSkills(client: DeepSeekReader, sessionId: string): Promise<SlashCommand[]> {
  const skills = await client.call('skills/list', { request: { sessionId } });
  if (!isRecord(skills) || !Array.isArray(skills.skills)) throw new Error('Malformed DeepSeek skill catalog.');
  return skills.skills.filter(isRecord).filter(skill => typeof skill.name === 'string').map(skill => ({
    id: `deepseek:skill:${skill.name as string}`, name: skill.name as string, description: typeof skill.description === 'string' ? skill.description : '',
    content: '', source: 'sdk' as const, kind: 'skill' as const, userInvocable: true,
  }));
}
