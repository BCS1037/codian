import type {
  ApprovalCallback,
  ApprovalDecisionOption,
  AskUserQuestionCallback,
} from '../../../core/runtime/types';
import type { ApprovalDecision } from '../../../core/types';
import { t } from '../../../i18n/i18n';
import { normalizeCodexToolName } from '../normalization/codexToolNormalization';
import type {
  CommandApprovalRequest,
  CommandExecutionApprovalDecision,
  CommandExecutionApprovalResponse,
  DynamicToolCallParams,
  DynamicToolCallResponse,
  FileChangeApprovalDecision,
  FileChangeApprovalRequest,
  FileChangeApprovalResponse,
  PermissionsApprovalRequest,
  PermissionsApprovalResponse,
  RequestId,
  UserInputRequest,
  UserInputResponse,
} from './codexAppServerTypes';
import type { CodexDynamicToolRegistry } from './CodexDynamicToolRegistry';

export class CodexServerRequestRouter {
  private approvalCallback: ApprovalCallback | null = null;
  private askUserCallback: AskUserQuestionCallback | null = null;
  private pendingApprovalRequests = new Map<RequestId, string>();
  private askUserAbortController: AbortController | null = null;
  private pendingAskUserRequestId: RequestId | null = null;
  private pendingAskUserThreadId: string | null = null;
  private dynamicToolRegistry: CodexDynamicToolRegistry | null = null;
  private toolBlockedCallback: ((itemId: string) => void) | null = null;

  setApprovalCallback(callback: ApprovalCallback | null): void {
    this.approvalCallback = callback;
  }

  setAskUserCallback(callback: AskUserQuestionCallback | null): void {
    this.askUserCallback = callback;
  }

  setDynamicToolRegistry(registry: CodexDynamicToolRegistry | null): void {
    this.dynamicToolRegistry = registry;
  }

  setToolBlockedCallback(callback: ((itemId: string) => void) | null): void {
    this.toolBlockedCallback = callback;
  }

  async handleServerRequest(
    requestIdOrMethod: RequestId | string,
    methodOrParams: unknown,
    maybeParams?: unknown,
  ): Promise<unknown> {
    const hasExplicitRequestId = maybeParams !== undefined;
    const requestId = hasExplicitRequestId ? requestIdOrMethod : undefined;
    const method = (hasExplicitRequestId ? methodOrParams : requestIdOrMethod) as string;
    const params = (hasExplicitRequestId ? maybeParams : methodOrParams);

    switch (method) {
      case 'item/commandExecution/requestApproval':
        return this.handleCommandApproval(requestId, params as CommandApprovalRequest);

      case 'item/fileChange/requestApproval':
        return this.handleFileChangeApproval(requestId, params as FileChangeApprovalRequest);

      case 'item/permissions/requestApproval':
        return this.handlePermissionsApproval(requestId, params as PermissionsApprovalRequest);

      case 'item/tool/requestUserInput':
        return this.handleUserInputRequest(requestId, params as UserInputRequest);

      case 'item/tool/call':
        return this.handleDynamicToolCall(params as DynamicToolCallParams);

      default:
        throw new Error(`Unsupported server request: ${method}`);
    }
  }

  private async handleDynamicToolCall(
    params: DynamicToolCallParams,
  ): Promise<DynamicToolCallResponse> {
    if (!this.dynamicToolRegistry) {
      throw new Error(`Unsupported dynamic tool: ${params.tool}`);
    }
    return this.dynamicToolRegistry.execute(params);
  }

  hasPendingApprovalRequest(requestId: RequestId, threadId: string): boolean {
    return this.pendingApprovalRequests.get(requestId) === threadId;
  }

  private async handleCommandApproval(
    requestId: RequestId | undefined,
    params: CommandApprovalRequest,
  ): Promise<CommandExecutionApprovalResponse> {
    if (!this.approvalCallback) return { decision: 'decline' };

    const command = params.command ?? '';
    const toolName = normalizeCodexToolName('command_execution');
    const input = {
      command,
      cwd: params.cwd ?? null,
      reason: params.reason ?? null,
      commandActions: params.commandActions ?? null,
      approvalId: params.approvalId ?? null,
      networkApprovalContext: params.networkApprovalContext ?? null,
      additionalPermissions: params.additionalPermissions ?? null,
      skillMetadata: params.skillMetadata ?? null,
      proposedExecpolicyAmendment: params.proposedExecpolicyAmendment ?? null,
      proposedNetworkPolicyAmendments: params.proposedNetworkPolicyAmendments ?? null,
    };
    const description = describeCommandApproval(params);

    if (requestId !== undefined) {
      this.pendingApprovalRequests.set(requestId, params.threadId);
    }

    try {
      const decision = await this.approvalCallback(toolName, input, description, {
        ...(params.reason ? { decisionReason: params.reason } : {}),
        ...(params.networkApprovalContext ? { networkApprovalContext: params.networkApprovalContext } : {}),
        ...(params.additionalPermissions ? { additionalPermissions: params.additionalPermissions } : {}),
        decisionOptions: buildCommandApprovalDecisionOptions(params),
      });
      const mappedDecision = mapCommandApprovalDecision(decision);
      if (mappedDecision === 'decline') {
        this.toolBlockedCallback?.(params.itemId);
      }
      return { decision: mappedDecision };
    } finally {
      if (requestId !== undefined) {
        this.pendingApprovalRequests.delete(requestId);
      }
    }
  }

  private async handleFileChangeApproval(
    requestId: RequestId | undefined,
    params: FileChangeApprovalRequest,
  ): Promise<FileChangeApprovalResponse> {
    if (!this.approvalCallback) return { decision: 'decline' };

    const reason = params.reason ?? undefined;
    const toolName = normalizeCodexToolName('file_change');
    const input: Record<string, unknown> = { reason: reason ?? null };
    const description = reason ? t('chat.approval.fileChangeReason', { reason }) : t('chat.approval.fileChange');

    if (requestId !== undefined) {
      this.pendingApprovalRequests.set(requestId, params.threadId);
    }

    try {
      const decision = await this.approvalCallback(toolName, input, description, {});
      const mappedDecision = mapFileChangeApprovalDecision(decision);
      if (mappedDecision === 'decline') {
        this.toolBlockedCallback?.(params.itemId);
      }
      return { decision: mappedDecision };
    } finally {
      if (requestId !== undefined) {
        this.pendingApprovalRequests.delete(requestId);
      }
    }
  }

  private async handlePermissionsApproval(
    requestId: RequestId | undefined,
    params: PermissionsApprovalRequest,
  ): Promise<PermissionsApprovalResponse> {
    if (!this.approvalCallback) return { permissions: {}, scope: 'turn' };

    const requestedPermissions = params.permissions as Record<string, unknown> | undefined ?? {};
    const reason = params.reason ?? undefined;
    const toolName = 'permissions';
    const description = reason ? t('chat.approval.permissionReason', { reason }) : t('chat.approval.permissionRequest');

    if (requestId !== undefined) {
      this.pendingApprovalRequests.set(requestId, params.threadId);
    }

    let decision: ApprovalDecision;
    try {
      decision = await this.approvalCallback(toolName, requestedPermissions, description, {});
    } finally {
      if (requestId !== undefined) {
        this.pendingApprovalRequests.delete(requestId);
      }
    }

    if (decision === 'allow') {
      return { permissions: requestedPermissions, scope: 'turn' };
    }
    if (decision === 'allow-always') {
      return { permissions: requestedPermissions, scope: 'session' };
    }

    if (decision === 'deny') {
      this.toolBlockedCallback?.(params.itemId);
    }

    return { permissions: {}, scope: 'turn' };
  }

  abortPendingAskUser(requestId?: RequestId, threadId?: string): boolean {
    if (!this.askUserAbortController) {
      return false;
    }

    if (requestId !== undefined && requestId !== this.pendingAskUserRequestId) {
      return false;
    }

    if (threadId !== undefined && threadId !== this.pendingAskUserThreadId) {
      return false;
    }

    this.askUserAbortController.abort();
    this.askUserAbortController = null;
    this.pendingAskUserRequestId = null;
    this.pendingAskUserThreadId = null;
    return true;
  }

  private async handleUserInputRequest(
    requestId: RequestId | undefined,
    params: UserInputRequest,
  ): Promise<UserInputResponse> {
    if (!this.askUserCallback) return { answers: {} };

    const questions = params.questions ?? [];
    const input: Record<string, unknown> = { questions };

    this.askUserAbortController = new AbortController();
    this.pendingAskUserRequestId = requestId ?? null;
    this.pendingAskUserThreadId = params.threadId;

    let userAnswers: Record<string, string | string[]> | null;
    try {
      userAnswers = await this.askUserCallback(input, this.askUserAbortController.signal);
    } finally {
      this.askUserAbortController = null;
      this.pendingAskUserRequestId = null;
      this.pendingAskUserThreadId = null;
    }

    if (!userAnswers) return { answers: {} };

    const answers: Record<string, { answers: string[] }> = {};
    for (const [key, value] of Object.entries(userAnswers)) {
      answers[key] = { answers: normalizeAnswers(value) };
    }

    return { answers };
  }
}

function describeCommandApproval(params: CommandApprovalRequest): string {
  const networkContext = params.networkApprovalContext;
  if (networkContext) {
    return t('chat.approval.networkAccess', {
      protocol: networkContext.protocol,
      host: networkContext.host,
    });
  }

  const command = params.command ?? '';
  return command ? t('chat.approval.execute', { command }) : t('chat.approval.executeCommand');
}

function buildCommandApprovalDecisionOptions(
  params: CommandApprovalRequest,
): ApprovalDecisionOption[] {
  const availableDecisions = params.availableDecisions ?? ['accept', 'acceptForSession', 'decline'];

  return availableDecisions.map((decision) => mapDecisionOption(decision, params));
}

function mapDecisionOption(
  decision: CommandExecutionApprovalDecision,
  params: CommandApprovalRequest,
): ApprovalDecisionOption {
  if (decision === 'accept') {
    return { label: t('chat.approval.allowOnce'), value: 'allow-once', decision: 'allow' };
  }
  if (decision === 'acceptForSession') {
    return { label: t('chat.approval.alwaysAllow'), value: 'allow-always', decision: 'allow-always' };
  }
  if (decision === 'decline') {
    return { label: t('chat.approval.deny'), value: 'deny', decision: 'deny' };
  }
  if (decision === 'cancel') {
    return { label: t('common.cancel'), value: 'cancel', decision: 'cancel' };
  }
  if ('acceptWithExecpolicyAmendment' in decision) {
    return {
      label: t('chat.approval.allowSimilar'),
      description: t('chat.approval.execPolicy'),
      value: encodeCommandApprovalDecision(decision),
    };
  }

  const networkPolicyAmendment = decision.applyNetworkPolicyAmendment.network_policy_amendment;
  const host = networkPolicyAmendment.host || params.networkApprovalContext?.host || t('chat.approval.host');
  const isDeny = networkPolicyAmendment.action === 'deny';
  return {
    label: t(isDeny ? 'chat.approval.denyHost' : 'chat.approval.allowHost', { host }),
    description: t(isDeny ? 'chat.approval.denyRule' : 'chat.approval.allowRule', { host }),
    value: encodeCommandApprovalDecision(decision),
  };
}

function normalizeAnswers(value: string | string[]): string[] {
  if (Array.isArray(value)) {
    return value
      .map((item) => (typeof item === 'string' ? item : String(item)))
      .filter((item) => item.trim().length > 0);
  }

  return [value];
}

function mapCommandApprovalDecision(decision: ApprovalDecision): CommandExecutionApprovalDecision {
  switch (decision) {
    case 'allow':
      return 'accept';
    case 'allow-always':
      return 'acceptForSession';
    case 'deny':
      return 'decline';
    case 'cancel':
      return 'cancel';
    default:
      if (typeof decision === 'object' && decision !== null && decision.type === 'select-option') {
        const decoded = decodeCommandApprovalDecision(decision.value);
        if (decoded) {
          return decoded;
        }
      }
      return 'decline';
  }
}

function mapFileChangeApprovalDecision(decision: ApprovalDecision): FileChangeApprovalDecision {
  switch (decision) {
    case 'allow':
      return 'accept';
    case 'allow-always':
      return 'acceptForSession';
    case 'deny':
      return 'decline';
    case 'cancel':
      return 'cancel';
    default:
      return 'decline';
  }
}

function encodeCommandApprovalDecision(decision: CommandExecutionApprovalDecision): string {
  return JSON.stringify(decision);
}

function decodeCommandApprovalDecision(value: string): CommandExecutionApprovalDecision | null {
  try {
    return JSON.parse(value) as CommandExecutionApprovalDecision;
  } catch {
    return null;
  }
}
