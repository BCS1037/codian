import { buildPersistentPermissionUpdates } from '@/providers/claude/security/ClaudePermissionUpdates';

describe('buildPersistentPermissionUpdates', () => {
  it('constructs a project allow rule from the action', () => {
    const updates = buildPersistentPermissionUpdates('Bash', { command: 'git status' });
    expect(updates).toEqual([{
      type: 'addRules',
      behavior: 'allow',
      rules: [{ toolName: 'Bash', ruleContent: 'git status' }],
      destination: 'projectSettings',
    }]);
  });

  it('uses scoped SDK suggestions for persistent approval', () => {
    const suggestions = [{
      type: 'addRules' as const,
      behavior: 'allow' as const,
      rules: [{ toolName: 'Bash', ruleContent: 'git *' }],
      destination: 'session' as const,
    }];
    expect(buildPersistentPermissionUpdates('Bash', { command: 'git status' }, suggestions)).toEqual([{
      type: 'addRules',
      behavior: 'allow',
      rules: [{ toolName: 'Bash', ruleContent: 'git *' }],
      destination: 'projectSettings',
    }]);
  });

  it('falls back to a constructed rule when no addRules suggestion exists', () => {
    expect(buildPersistentPermissionUpdates('Bash', { command: 'ls' }, [])).toEqual([{
      type: 'addRules',
      behavior: 'allow',
      rules: [{ toolName: 'Bash', ruleContent: 'ls' }],
      destination: 'projectSettings',
    }]);
  });

  it('does not persist an unscoped fallback rule', () => {
    expect(buildPersistentPermissionUpdates('Read', {})).toEqual([]);
    expect(buildPersistentPermissionUpdates('Bash', { command: '   ' })).toEqual([]);
    expect(buildPersistentPermissionUpdates('UnknownTool', {})).toEqual([]);
  });

  it('includes addDirectories suggestions without overriding their destination', () => {
    const suggestions = [
      {
        type: 'addRules' as const,
        behavior: 'allow' as const,
        rules: [{ toolName: 'Read', ruleContent: '/external/path/*' }],
        destination: 'session' as const,
      },
      {
        type: 'addDirectories' as const,
        directories: ['/external/path'],
        destination: 'session' as const,
      },
    ];
    expect(buildPersistentPermissionUpdates('Read', { file_path: '/external/path/file.md' }, suggestions)).toEqual([
      {
        type: 'addRules',
        behavior: 'allow',
        rules: [{ toolName: 'Read', ruleContent: '/external/path/*' }],
        destination: 'projectSettings',
      },
      {
        type: 'addDirectories',
        directories: ['/external/path'],
        destination: 'session',
      },
    ]);
  });

  it('includes removeDirectories suggestions', () => {
    const suggestions = [{
      type: 'removeDirectories' as const,
      directories: ['/revoked/path'],
      destination: 'session' as const,
    }];
    expect(buildPersistentPermissionUpdates('Bash', { command: 'ls' }, suggestions)).toEqual([
      {
        type: 'addRules',
        behavior: 'allow',
        rules: [{ toolName: 'Bash', ruleContent: 'ls' }],
        destination: 'projectSettings',
      },
      {
        type: 'removeDirectories',
        directories: ['/revoked/path'],
        destination: 'session',
      },
    ]);
  });

  it('includes setMode suggestions without overriding their destination', () => {
    const suggestions = [{
      type: 'setMode' as const,
      mode: 'default' as const,
      destination: 'session' as const,
    }];
    expect(buildPersistentPermissionUpdates('Bash', { command: 'echo hi' }, suggestions)).toEqual([
      {
        type: 'addRules',
        behavior: 'allow',
        rules: [{ toolName: 'Bash', ruleContent: 'echo hi' }],
        destination: 'projectSettings',
      },
      {
        type: 'setMode',
        mode: 'default',
        destination: 'session',
      },
    ]);
  });

  it('prepends an addRules fallback when suggestions have no rule update', () => {
    const suggestions = [{
      type: 'addDirectories' as const,
      directories: ['/new/dir'],
      destination: 'session' as const,
    }];
    expect(buildPersistentPermissionUpdates('Read', { file_path: '/new/dir/file.md' }, suggestions)).toEqual([
      {
        type: 'addRules',
        behavior: 'allow',
        rules: [{ toolName: 'Read', ruleContent: '/new/dir/file.md' }],
        destination: 'projectSettings',
      },
      {
        type: 'addDirectories',
        directories: ['/new/dir'],
        destination: 'session',
      },
    ]);
  });

  it('does not prepend a fallback when replaceRules is present', () => {
    const suggestions = [{
      type: 'replaceRules' as const,
      behavior: 'allow' as const,
      rules: [{ toolName: 'Bash', ruleContent: 'git *' }],
      destination: 'session' as const,
    }];
    expect(buildPersistentPermissionUpdates('Bash', { command: 'git status' }, suggestions)).toEqual([{
      type: 'replaceRules',
      behavior: 'allow',
      rules: [{ toolName: 'Bash', ruleContent: 'git *' }],
      destination: 'projectSettings',
    }]);
  });

  it('preserves removeRules behavior and destination', () => {
    const suggestions = [{
      type: 'removeRules' as const,
      behavior: 'deny' as const,
      rules: [{ toolName: 'Bash', ruleContent: 'git status' }],
      destination: 'session' as const,
    }];
    const updates = buildPersistentPermissionUpdates('Bash', { command: 'git status' }, suggestions);
    expect(updates).toEqual([
      {
        type: 'addRules',
        behavior: 'allow',
        rules: [{ toolName: 'Bash', ruleContent: 'git status' }],
        destination: 'projectSettings',
      },
      {
        type: 'removeRules',
        behavior: 'deny',
        rules: [{ toolName: 'Bash', ruleContent: 'git status' }],
        destination: 'session',
      },
    ]);
  });

  it('ignores whitespace-only suggested scopes', () => {
    const suggestions = [{
      type: 'addRules' as const,
      behavior: 'allow' as const,
      rules: [{ toolName: 'Read', ruleContent: '   ' }],
      destination: 'session' as const,
    }];
    expect(buildPersistentPermissionUpdates('Read', {}, suggestions)).toEqual([]);
  });
});
