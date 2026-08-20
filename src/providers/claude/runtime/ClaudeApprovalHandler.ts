import type {
  CanUseTool,
  PermissionMode as SDKPermissionMode,
  PermissionResult,
} from '@anthropic-ai/claude-agent-sdk';

import type {
  ApprovalCallback,
  AskUserQuestionCallback,
} from '../../../core/runtime/types';
import { getActionDescription } from '../../../core/security/ApprovalManager';
import {
  TOOL_ASK_USER_QUESTION,
  TOOL_EXIT_PLAN_MODE,
  TOOL_SKILL,
} from '../../../core/tools/toolNames';
import type {
  ApprovalDecision,
  ExitPlanModeCallback,
  ExitPlanModeDecision,
} from '../../../core/types';
import type { PermissionMode } from '../../../core/types/settings';
import { buildPersistentPermissionUpdates } from '../security/ClaudePermissionUpdates';

export interface ClaudeApprovalHandlerDeps {
  getAllowedTools: () => string[] | null;
  getApprovalCallback: () => ApprovalCallback | null;
  getAskUserQuestionCallback: () => AskUserQuestionCallback | null;
  getExitPlanModeCallback: () => ExitPlanModeCallback | null;
  getPermissionMode: () => PermissionMode;
  resolveSDKPermissionMode: (mode: PermissionMode) => SDKPermissionMode;
  syncPermissionMode: (mode: PermissionMode, sdkMode: SDKPermissionMode) => void;
  notifyAlwaysAppliedOnce: () => void;
  onToolBlocked?: (toolUseId: string) => void;
}

export function createClaudeApprovalCallback(
  deps: ClaudeApprovalHandlerDeps,
): CanUseTool {
  return async (toolName, input, options): Promise<PermissionResult> => {
    const deny = (result: PermissionResult): PermissionResult => {
      if (typeof options.toolUseID === 'string') {
        deps.onToolBlocked?.(options.toolUseID);
      }
      return result;
    };

    const currentAllowedTools = deps.getAllowedTools();
    if (currentAllowedTools !== null) {
      if (!currentAllowedTools.includes(toolName) && toolName !== TOOL_SKILL) {
        const allowedList = currentAllowedTools.length > 0
          ? ` Allowed tools: ${currentAllowedTools.join(', ')}.`
          : ' No tools are allowed for this query type.';
        return deny({
          behavior: 'deny',
          message: `Tool "${toolName}" is not allowed for this query.${allowedList}`,
        });
      }
    }

    const exitPlanModeCallback = deps.getExitPlanModeCallback();
    if (toolName === TOOL_EXIT_PLAN_MODE && exitPlanModeCallback) {
      try {
        const decision: ExitPlanModeDecision | null = await exitPlanModeCallback(input, options.signal);
        if (decision === null) {
          return deny({ behavior: 'deny', message: 'User cancelled.', interrupt: true });
        }
        if (decision.type === 'feedback') {
          return deny({ behavior: 'deny', message: decision.text, interrupt: false });
        }
        if (decision.type === 'abandon') {
          return deny({ behavior: 'deny', message: 'User abandoned the plan.', interrupt: true });
        }

        const permissionMode = deps.getPermissionMode();
        const sdkMode = deps.resolveSDKPermissionMode(permissionMode);
        deps.syncPermissionMode(permissionMode, sdkMode);
        return {
          behavior: 'allow',
          updatedInput: input,
          updatedPermissions: [
            { type: 'setMode', mode: sdkMode, destination: 'session' },
          ],
        };
      } catch (error) {
        return deny({
          behavior: 'deny',
          message: `Failed to handle plan mode exit: ${error instanceof Error ? error.message : 'Unknown error'}`,
          interrupt: true,
        });
      }
    }

    const askUserQuestionCallback = deps.getAskUserQuestionCallback();
    if (toolName === TOOL_ASK_USER_QUESTION && askUserQuestionCallback) {
      try {
        // The SDK's JSDoc says "Other will be provided automatically" but
        // the SDK doesn't inject isOther into the canUseTool input. Claudian
        // intercepts at canUseTool and renders its own UI, so we must inject
        // isOther here to match the Claude Code CLI's built-in behavior.
        const questions = input.questions;
        if (Array.isArray(questions)) {
          for (const q of questions) {
            if (isObjectRecord(q) && !('isOther' in q)) {
              q.isOther = true;
            }
          }
        }
        const answers = await askUserQuestionCallback(input, options.signal);
        if (answers === null) {
          return deny({ behavior: 'deny', message: 'User declined to answer.', interrupt: true });
        }
        return { behavior: 'allow', updatedInput: { ...input, answers } };
      } catch (error) {
        return deny({
          behavior: 'deny',
          message: `Failed to get user answers: ${error instanceof Error ? error.message : 'Unknown error'}`,
          interrupt: true,
        });
      }
    }

    const approvalCallback = deps.getApprovalCallback();
    if (!approvalCallback) {
      return deny({ behavior: 'deny', message: 'No approval handler available.' });
    }

    try {
      const { decisionReason, blockedPath, agentID } = options;
      const description = getActionDescription(toolName, input);
      const decision: ApprovalDecision = await approvalCallback(
        toolName,
        input,
        description,
        { decisionReason, blockedPath, agentID },
      );

      if (decision === 'cancel') {
        return deny({ behavior: 'deny', message: 'User interrupted.', interrupt: true });
      }

      if (decision === 'allow') {
        return {
          behavior: 'allow',
          updatedInput: input,
          decisionClassification: 'user_temporary',
        };
      }

      if (decision === 'allow-always') {
        const updatedPermissions = buildPersistentPermissionUpdates(
          toolName,
          input,
          options.suggestions,
        );
        if (updatedPermissions.length === 0) {
          deps.notifyAlwaysAppliedOnce();
          return {
            behavior: 'allow',
            updatedInput: input,
            decisionClassification: 'user_permanent',
          };
        }
        return {
          behavior: 'allow',
          updatedInput: input,
          updatedPermissions,
          decisionClassification: 'user_permanent',
        };
      }

      return deny({ behavior: 'deny', message: 'User denied this action.', interrupt: false });
    } catch (error) {
      return deny({
        behavior: 'deny',
        message: `Approval request failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
        interrupt: false,
      });
    }
  };
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
