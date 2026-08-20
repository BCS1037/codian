import { TOOL_EXIT_PLAN_MODE } from '@/core/tools/toolNames';
import { createClaudeApprovalCallback } from '@/providers/claude/runtime/ClaudeApprovalHandler';

function createDeps(decision: 'allow' | 'allow-always') {
  return {
    getAllowedTools: () => null,
    getApprovalCallback: () => jest.fn().mockResolvedValue(decision),
    getAskUserQuestionCallback: () => null,
    getExitPlanModeCallback: () => null,
    getPermissionMode: () => 'normal' as const,
    resolveSDKPermissionMode: () => 'default' as const,
    syncPermissionMode: jest.fn(),
    notifyAlwaysAppliedOnce: jest.fn(),
  };
}

describe('createClaudeApprovalCallback', () => {
  const options = {
    signal: new AbortController().signal,
    suggestions: undefined,
  } as any;

  it('classifies an unscoped always decision as permanent without returning updates', async () => {
    const deps = createDeps('allow-always');
    const callback = createClaudeApprovalCallback(deps);

    const result = await callback('Read', {}, options);

    expect(result).toEqual({
      behavior: 'allow',
      updatedInput: {},
      decisionClassification: 'user_permanent',
    });
    expect(deps.notifyAlwaysAppliedOnce).toHaveBeenCalledTimes(1);
  });

  it('keeps allow-once decisions scoped to the current invocation', async () => {
    const deps = createDeps('allow');
    const callback = createClaudeApprovalCallback(deps);
    const suggestions = [{
      type: 'addRules' as const,
      behavior: 'allow' as const,
      rules: [{ toolName: 'Bash', ruleContent: 'git *' }],
      destination: 'session' as const,
    }];

    const result = await callback('Bash', { command: 'git status' }, {
      ...options,
      suggestions,
    });

    expect(result).toEqual({
      behavior: 'allow',
      updatedInput: { command: 'git status' },
      decisionClassification: 'user_temporary',
    });
    expect(result).not.toHaveProperty('updatedPermissions');
  });

  it('does not notify when an always decision has a derived scope', async () => {
    const deps = createDeps('allow-always');
    const callback = createClaudeApprovalCallback(deps);

    const result = await callback('Bash', { command: 'git status' }, options);

    expect(result).toMatchObject({
      behavior: 'allow',
      decisionClassification: 'user_permanent',
      updatedPermissions: [{
        type: 'addRules',
        rules: [{ toolName: 'Bash', ruleContent: 'git status' }],
        destination: 'projectSettings',
      }],
    });
    expect(deps.notifyAlwaysAppliedOnce).not.toHaveBeenCalled();
  });

  it('reports denied tool IDs to the provider boundary', async () => {
    const onToolBlocked = jest.fn();
    const deps = {
      ...createDeps('allow'),
      getApprovalCallback: () => jest.fn().mockResolvedValue('cancel'),
      onToolBlocked,
    };
    const callback = createClaudeApprovalCallback(deps);

    await expect(callback('Bash', {}, {
      ...options,
      toolUseID: 'tool-denied',
    })).resolves.toMatchObject({ behavior: 'deny' });

    expect(onToolBlocked).toHaveBeenCalledWith('tool-denied');
  });

  it('does not persist allow-once approvals when no scope can be derived', async () => {
    const deps = createDeps('allow');
    const callback = createClaudeApprovalCallback(deps);

    const result = await callback('Read', {}, options);

    expect(result).toMatchObject({
      behavior: 'allow',
      updatedInput: {},
      decisionClassification: 'user_temporary',
    });
    expect(result).not.toHaveProperty('updatedPermissions');
    expect(deps.notifyAlwaysAppliedOnce).not.toHaveBeenCalled();
  });

  it('does not interpret a provider-specific abandon decision as Claude approval', async () => {
    const deps = {
      ...createDeps('allow'),
      getExitPlanModeCallback: () => jest.fn().mockResolvedValue({ type: 'abandon' }),
    };
    const callback = createClaudeApprovalCallback(deps);

    await expect(callback(TOOL_EXIT_PLAN_MODE, {}, options)).resolves.toEqual({
      behavior: 'deny',
      interrupt: true,
      message: 'User abandoned the plan.',
    });
  });
});
