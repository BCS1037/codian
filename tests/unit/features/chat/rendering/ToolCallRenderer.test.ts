import { createMockEl } from '@test/helpers/mockElement';
import { setIcon } from 'obsidian';

import type { ToolCallInfo } from '@/core/types';
import {
  getToolLabel,
  getToolName,
  getToolSummary,
  renderStoredToolCall,
  renderTodoWriteResult,
  renderToolCall,
  setToolIcon,
  updateToolCallResult,
} from '@/features/chat/rendering/ToolCallRenderer';
import { setLocale } from '@/i18n/i18n';

// Mock obsidian
jest.mock('obsidian', () => ({
  setIcon: jest.fn(),
}));

// Helper to create a basic tool call
function createToolCall(overrides: Partial<ToolCallInfo> = {}): ToolCallInfo {
  return {
    id: 'tool-123',
    name: 'Read',
    input: { file_path: '/test/file.md' },
    status: 'running',
    ...overrides,
  };
}

describe('ToolCallRenderer', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('renderToolCall', () => {
    it('should store element in toolCallElements map', () => {
      const parentEl = createMockEl();
      const toolCall = createToolCall({ id: 'test-id' });
      const toolCallElements = new Map<string, HTMLElement>();

      const toolEl = renderToolCall(parentEl, toolCall, toolCallElements);

      expect(toolCallElements.get('test-id')).toBe(toolEl);
    });

    it('should set data-tool-id on element', () => {
      const parentEl = createMockEl();
      const toolCall = createToolCall({ id: 'my-tool-id' });
      const toolCallElements = new Map<string, HTMLElement>();

      const toolEl = renderToolCall(parentEl, toolCall, toolCallElements);

      expect(toolEl.dataset.toolId).toBe('my-tool-id');
    });

    it('should set correct ARIA attributes for accessibility', () => {
      const parentEl = createMockEl();
      const toolCall = createToolCall();
      const toolCallElements = new Map<string, HTMLElement>();

      const toolEl = renderToolCall(parentEl, toolCall, toolCallElements);

      const header = (toolEl as any)._children[0];
      expect(header.getAttribute('role')).toBe('button');
      expect(header.getAttribute('tabindex')).toBe('0');
    });

    it('keeps live tool output eager and replaces it when the result completes', () => {
      const parentEl = createMockEl();
      const toolCall = createToolCall({
        id: 'live-read',
        status: 'running',
        result: 'partial output',
      });
      const toolCallElements = new Map<string, HTMLElement>();

      const toolEl = renderToolCall(parentEl, toolCall, toolCallElements);
      expect(toolEl.querySelector('.codian-tool-result-text')?.textContent).toBe('Running...');

      toolCall.status = 'completed';
      toolCall.result = 'final output';
      updateToolCallResult(toolCall.id, toolCall, toolCallElements);

      expect(toolEl.querySelector('.codian-tool-line')?.textContent).toBe('final output');
    });

    it('should track isExpanded on toolCall object', () => {
      const parentEl = createMockEl();
      const toolCall = createToolCall();
      const toolCallElements = new Map<string, HTMLElement>();

      renderToolCall(parentEl, toolCall, toolCallElements);

      expect(toolCall.isExpanded).toBe(false);
    });

    it('should start expanded when requested', () => {
      const parentEl = createMockEl();
      const toolCall = createToolCall();
      const toolCallElements = new Map<string, HTMLElement>();

      const toolEl = renderToolCall(parentEl, toolCall, toolCallElements, { initiallyExpanded: true });
      const header = toolEl.querySelector('.codian-tool-header');
      const content = toolEl.querySelector('.codian-tool-content');

      expect(toolCall.isExpanded).toBe(true);
      expect(toolEl.hasClass('expanded')).toBe(true);
      expect(content?.hasClass('codian-hidden')).toBe(false);
      expect(header?.getAttribute('aria-expanded')).toBe('true');
    });

    it('builds Bash-specific classes, icon, command content, and toggle state', () => {
      const parentEl = createMockEl();
      const toolCall = createToolCall({
        name: 'Bash',
        input: { command: 'npm test' },
      });
      const toolEl = renderToolCall(parentEl, toolCall, new Map());
      const header = toolEl.querySelector('.codian-tool-header');
      const content = toolEl.querySelector('.codian-tool-content');

      expect(toolEl.hasClass('codian-tool-call-bash')).toBe(true);
      expect(toolEl.querySelector('.codian-tool-bash-command')?.textContent).toBe('$ npm test');
      expect(setIcon).toHaveBeenCalledWith(expect.anything(), 'terminal');

      (header as HTMLElement | null)?.click();
      expect(toolCall.isExpanded).toBe(true);
      expect(content?.hasClass('codian-hidden')).toBe(false);
    });

    it('builds TodoWrite preview, content, icon, and toggle handlers', () => {
      const parentEl = createMockEl();
      const toolCall = createToolCall({
        name: 'TodoWrite',
        input: {
          todos: [{ content: 'Task', status: 'in_progress', activeForm: 'Working' }],
        },
      });
      const toolEl = renderToolCall(parentEl, toolCall, new Map());
      const header = toolEl.querySelector('.codian-tool-header');
      const currentTask = toolEl.querySelector('.codian-tool-current');
      const status = toolEl.querySelector('.codian-tool-status');
      const content = toolEl.querySelector('.codian-tool-content');

      expect(currentTask?.textContent).toBe('Working');
      expect(content?.hasClass('codian-tool-content-todo')).toBe(true);
      expect(setIcon).toHaveBeenCalledWith(expect.anything(), 'list-checks');

      (header as HTMLElement | null)?.click();
      expect(toolCall.isExpanded).toBe(true);
      expect(currentTask?.hasClass('codian-hidden')).toBe(true);
      expect(status?.hasClass('codian-hidden')).toBe(true);
    });

    it('builds AskUserQuestion content and renders resolved answers through its dedicated updater', () => {
      const parentEl = createMockEl();
      const toolCall = createToolCall({
        name: 'AskUserQuestion',
        input: { questions: [{ id: 'color', question: 'Color?' }] },
        resolvedAnswers: { color: 'Blue' },
      });
      const toolCallElements = new Map<string, HTMLElement>();
      const toolEl = renderToolCall(parentEl, toolCall, toolCallElements);
      const content = toolEl.querySelector('.codian-tool-content');

      expect(content?.hasClass('codian-tool-content-ask')).toBe(true);
      expect(setIcon).toHaveBeenCalledWith(expect.anything(), 'help-circle');

      toolCall.status = 'completed';
      toolCall.result = 'answered';
      updateToolCallResult(toolCall.id, toolCall, toolCallElements);
      expect(toolEl.querySelector('.codian-ask-review-a-text')?.textContent).toBe('Blue');
    });
  });

  describe('renderStoredToolCall', () => {
    it('defers completed tool result rendering until first expansion and reuses it afterward', () => {
      const parentEl = createMockEl();
      const toolCall = createToolCall({
        status: 'completed',
        result: 'stored output',
      });

      const toolEl = renderStoredToolCall(parentEl, toolCall);
      const header = toolEl.querySelector('.codian-tool-header');
      const content = toolEl.querySelector('.codian-tool-content');

      expect(content?.children).toHaveLength(0);

      (header as HTMLElement | null)?.click();
      const renderedLine = content?.querySelector('.codian-tool-line');
      expect(renderedLine?.textContent).toBe('stored output');

      (header as HTMLElement | null)?.click();
      (header as HTMLElement | null)?.click();
      expect(content?.querySelector('.codian-tool-line')).toBe(renderedLine);
    });

    it('renders stored tool result immediately when initially expanded', () => {
      const parentEl = createMockEl();
      const toolCall = createToolCall({
        status: 'completed',
        result: 'visible on restore',
      });

      const toolEl = renderStoredToolCall(parentEl, toolCall, { initiallyExpanded: true });
      const header = toolEl.querySelector('.codian-tool-header');

      expect(header?.getAttribute('aria-expanded')).toBe('true');
      expect(toolEl.querySelector('.codian-tool-line')?.textContent).toBe('visible on restore');
    });

    it('defers stored error details while preserving the error status', () => {
      const parentEl = createMockEl();
      const toolCall = createToolCall({
        status: 'error',
        result: 'file read failed',
      });

      const toolEl = renderStoredToolCall(parentEl, toolCall);
      const header = toolEl.querySelector('.codian-tool-header');
      const content = toolEl.querySelector('.codian-tool-content');

      expect(content?.children).toHaveLength(0);
      expect(setIcon).toHaveBeenCalledWith(expect.anything(), 'x');

      (header as HTMLElement | null)?.click();
      expect(toolEl.querySelector('.codian-tool-line')?.textContent).toBe('file read failed');
    });

    it('creates empty-result fallback only after expansion', () => {
      const parentEl = createMockEl();
      const toolCall = createToolCall({
        status: 'completed',
        result: undefined,
      });

      const toolEl = renderStoredToolCall(parentEl, toolCall);
      const content = toolEl.querySelector('.codian-tool-content');

      expect(content?.children).toHaveLength(0);

      (toolEl.querySelector('.codian-tool-header') as HTMLElement).click();
      expect(toolEl.querySelector('.codian-tool-empty')?.textContent).toBe('No result');
    });

    it('should show completed status icon', () => {
      const parentEl = createMockEl();
      const toolCall = createToolCall({ status: 'completed' });

      renderStoredToolCall(parentEl, toolCall);

      expect(setIcon).toHaveBeenCalledWith(expect.anything(), 'check');
    });

    it('should show error status icon', () => {
      const parentEl = createMockEl();
      const toolCall = createToolCall({ status: 'error' });

      renderStoredToolCall(parentEl, toolCall);

      expect(setIcon).toHaveBeenCalledWith(expect.anything(), 'x');
    });

    it('renders AskUserQuestion answers from result text when resolvedAnswers is missing', () => {
      const parentEl = createMockEl();
      const toolCall = createToolCall({
        name: 'AskUserQuestion',
        status: 'completed',
        input: { questions: [{ question: 'Color?' }] },
        result: '"Color?"="Blue"',
      });

      const toolEl = renderStoredToolCall(parentEl, toolCall);
      const answerEls = toolEl.querySelectorAll('.codian-ask-review-a-text');

      expect(answerEls).toHaveLength(1);
      expect(answerEls[0].textContent).toBe('Blue');
    });

    it('renders AskUserQuestion answers by stable question id', () => {
      const parentEl = createMockEl();
      const toolCall = createToolCall({
        name: 'AskUserQuestion',
        status: 'completed',
        input: { questions: [{ id: 'q1', question: 'Color?' }] },
        result: '{"answers":{"q1":{"answers":["Blue"]}}}',
      });

      const toolEl = renderStoredToolCall(parentEl, toolCall);
      const answerEls = toolEl.querySelectorAll('.codian-ask-review-a-text');

      expect(answerEls).toHaveLength(1);
      expect(answerEls[0].textContent).toBe('Blue');
    });

    it('renders AskUserQuestion options during fallback state', () => {
      const parentEl = createMockEl();
      const toolCall = createToolCall({
        name: 'AskUserQuestion',
        status: 'running',
        input: {
          questions: [{
            question: 'Title timing?',
            options: [
              { label: 'Non-blocking', description: 'Generate title later.' },
              { label: 'Blocking', description: 'Wait for title first.' },
            ],
            multiSelect: true,
          }],
        },
      });

      const toolEl = renderStoredToolCall(parentEl, toolCall);
      const labelEls = toolEl.querySelectorAll('.codian-ask-item-label');
      const descEls = toolEl.querySelectorAll('.codian-ask-item-desc');
      const checkEls = toolEl.querySelectorAll('.codian-ask-check');

      expect(Array.from(labelEls, el => el.textContent)).toEqual(['Non-blocking', 'Blocking']);
      expect(Array.from(descEls, el => el.textContent)).toEqual(['Generate title later.', 'Wait for title first.']);
      expect(checkEls).toHaveLength(2);
    });
  });

  describe('updateToolCallResult', () => {
    it('should update status indicator', () => {
      const parentEl = createMockEl();
      const toolCall = createToolCall({ id: 'tool-1' });
      const toolCallElements = new Map<string, HTMLElement>();

      const toolEl = renderToolCall(parentEl, toolCall, toolCallElements);

      // Update with completed result
      toolCall.status = 'completed';
      toolCall.result = 'Success';
      updateToolCallResult('tool-1', toolCall, toolCallElements);

      const statusEl = toolEl.querySelector('.codian-tool-status');
      expect(statusEl?.hasClass('status-completed')).toBe(true);
    });

    it('shows raw AskUserQuestion result when answers cannot be parsed', () => {
      const parentEl = createMockEl();
      const toolCall = createToolCall({
        id: 'ask-1',
        name: 'AskUserQuestion',
        input: { questions: [{ question: 'Color?' }] },
      });
      const toolCallElements = new Map<string, HTMLElement>();

      const toolEl = renderToolCall(parentEl, toolCall, toolCallElements);
      toolCall.status = 'completed';
      toolCall.result = 'Answer submitted successfully.';

      updateToolCallResult('ask-1', toolCall, toolCallElements);

      const promptEl = toolEl.querySelector('.codian-ask-review-prompt');
      expect(promptEl?.textContent).toBe('Answer submitted successfully.');
    });
  });

  describe('setToolIcon', () => {
    it('should call setIcon with the resolved icon name', () => {
      const el = createMockEl() as unknown as HTMLElement;
      setToolIcon(el, 'Read');
      expect(setIcon).toHaveBeenCalledWith(el, expect.any(String));
    });

    it('should set MCP SVG for MCP tools', () => {
      const el = createMockEl();
      setToolIcon(el as unknown as HTMLElement, 'mcp__server__tool');
      expect(el.children[0]?.tagName).toBe('SVG');
    });
  });

  describe('getToolLabel', () => {
    it('should label Read tool with shortened path', () => {
      expect(getToolLabel('Read', { file_path: '/a/b/c/d/e.ts' })).toBe('Read: .../d/e.ts');
    });

    it('should label Read with fallback for missing path', () => {
      expect(getToolLabel('Read', {})).toBe('Read: file');
    });

    it('should label Write tool with path', () => {
      expect(getToolLabel('Write', { file_path: 'short.ts' })).toBe('Write: short.ts');
    });

    it('should label Edit tool with path', () => {
      expect(getToolLabel('Edit', { file_path: 'file.ts' })).toBe('Edit: file.ts');
    });

    it('should label Bash tool and truncate long commands', () => {
      const shortCmd = 'npm test';
      expect(getToolLabel('Bash', { command: shortCmd })).toBe('Bash: npm test');

      const longCmd = 'a'.repeat(50);
      expect(getToolLabel('Bash', { command: longCmd })).toBe(`Bash: ${'a'.repeat(40)}...`);
    });

    it('should label Bash with fallback for missing command', () => {
      expect(getToolLabel('Bash', {})).toBe('Bash: command');
    });

    it('should label Glob tool', () => {
      expect(getToolLabel('Glob', { pattern: '**/*.ts' })).toBe('Glob: **/*.ts');
    });

    it('should label Glob with fallback', () => {
      expect(getToolLabel('Glob', {})).toBe('Glob: files');
    });

    it('should label Grep tool', () => {
      expect(getToolLabel('Grep', { pattern: 'TODO' })).toBe('Grep: TODO');
    });

    it('should label WebSearch and truncate long queries', () => {
      expect(getToolLabel('WebSearch', { query: 'short' })).toBe('WebSearch: short');

      const longQuery = 'q'.repeat(50);
      expect(getToolLabel('WebSearch', { query: longQuery })).toBe(`WebSearch: ${'q'.repeat(40)}...`);
    });

    it('should label WebSearch open_page actions with the URL', () => {
      expect(getToolLabel('WebSearch', {
        actionType: 'open_page',
        url: 'https://example.com/docs',
      })).toBe('WebSearch: Open https://example.com/docs');
    });

    it('should label WebFetch and truncate long URLs', () => {
      expect(getToolLabel('WebFetch', { url: 'https://x.com' })).toBe('WebFetch: https://x.com');

      const longUrl = 'https://' + 'x'.repeat(50);
      expect(getToolLabel('WebFetch', { url: longUrl })).toBe(`WebFetch: ${longUrl.substring(0, 40)}...`);
    });

    it('should label LS tool with path', () => {
      expect(getToolLabel('LS', { path: '/src' })).toBe('LS: /src');
    });

    it('should label LS with fallback', () => {
      expect(getToolLabel('LS', {})).toBe('LS: .');
    });

    it('should label TodoWrite with completion count', () => {
      const todos = [
        { status: 'completed' },
        { status: 'completed' },
        { status: 'pending' },
      ];
      expect(getToolLabel('TodoWrite', { todos })).toBe('Tasks (2/3)');
    });

    it('should label TodoWrite without array', () => {
      expect(getToolLabel('TodoWrite', {})).toBe('Tasks');
    });

    it('should label Skill tool', () => {
      expect(getToolLabel('Skill', { skill: 'commit' })).toBe('Skill: commit');
    });

    it('should label Skill with fallback', () => {
      expect(getToolLabel('Skill', {})).toBe('Skill: skill');
    });

    it('should label ToolSearch with tool names', () => {
      expect(getToolLabel('ToolSearch', { query: 'select:Read,Glob' })).toBe('ToolSearch: Read, Glob');
    });

    it('should label ToolSearch with fallback for missing query', () => {
      expect(getToolLabel('ToolSearch', {})).toBe('ToolSearch: tools');
    });

    it('should return raw name for unknown tools', () => {
      expect(getToolLabel('CustomTool', {})).toBe('CustomTool');
    });
  });

  describe('getToolName', () => {
    it('should return tool name for standard tools', () => {
      expect(getToolName('Read', {})).toBe('Read');
      expect(getToolName('Write', {})).toBe('Write');
      expect(getToolName('Bash', {})).toBe('Bash');
      expect(getToolName('Glob', {})).toBe('Glob');
    });

    it('should return Tasks with count for TodoWrite', () => {
      const todos = [
        { status: 'completed' },
        { status: 'completed' },
        { status: 'pending' },
      ];
      expect(getToolName('TodoWrite', { todos })).toBe('Tasks 2/3');
      expect(getToolName('TodoWrite', {})).toBe('Tasks');
    });

    it('should return plan mode labels', () => {
      expect(getToolName('EnterPlanMode', {})).toBe('Entering plan mode');
      expect(getToolName('ExitPlanMode', {})).toBe('Plan complete');
    });

  });

  describe('getToolSummary', () => {
    it('should return filename-only for file tools', () => {
      expect(getToolSummary('Read', { file_path: '/a/b/c/file.ts' })).toBe('file.ts');
      expect(getToolSummary('Write', { file_path: '/src/index.ts' })).toBe('index.ts');
      expect(getToolSummary('Edit', { file_path: 'simple.md' })).toBe('simple.md');
    });

    it('should return empty for file tools with no path', () => {
      expect(getToolSummary('Read', {})).toBe('');
    });

    it('should return command for Bash', () => {
      expect(getToolSummary('Bash', { command: 'npm test' })).toBe('npm test');
    });

    it('should truncate long Bash commands', () => {
      const longCmd = 'a'.repeat(70);
      expect(getToolSummary('Bash', { command: longCmd })).toBe('a'.repeat(60) + '...');
    });

    it('should return pattern for Glob/Grep', () => {
      expect(getToolSummary('Glob', { pattern: '**/*.ts' })).toBe('**/*.ts');
      expect(getToolSummary('Grep', { pattern: 'TODO' })).toBe('TODO');
    });

    it('should return query for WebSearch', () => {
      expect(getToolSummary('WebSearch', { query: 'test query' })).toBe('test query');
    });

    it('should summarize WebSearch find_in_page actions', () => {
      expect(getToolSummary('WebSearch', {
        actionType: 'find_in_page',
        url: 'https://example.com/docs',
        pattern: 'tools',
      })).toBe('Find "tools" in https://example.com/docs');
    });

    it('should return url for WebFetch', () => {
      expect(getToolSummary('WebFetch', { url: 'https://x.com' })).toBe('https://x.com');
    });

    it('should return filename for LS', () => {
      expect(getToolSummary('LS', { path: '/src/components' })).toBe('components');
    });

    it('should return skill name for Skill', () => {
      expect(getToolSummary('Skill', { skill: 'commit' })).toBe('commit');
    });

    it('should return empty for TodoWrite', () => {
      const todos = [
        { status: 'completed', activeForm: 'Done' },
        { status: 'in_progress', activeForm: 'Working on it' },
      ];
      expect(getToolSummary('TodoWrite', { todos })).toBe('');
      expect(getToolSummary('TodoWrite', {})).toBe('');
    });

    it('should return empty for AskUserQuestion', () => {
      expect(getToolSummary('AskUserQuestion', { questions: [{ question: 'Q1' }] })).toBe('');
      expect(getToolSummary('AskUserQuestion', { questions: [{ question: 'Q1' }, { question: 'Q2' }] })).toBe('');
    });

    it('should return parsed tool names for ToolSearch', () => {
      expect(getToolSummary('ToolSearch', { query: 'select:Read,Glob' })).toBe('Read, Glob');
      expect(getToolSummary('ToolSearch', { query: 'select:Bash' })).toBe('Bash');
    });

    it('should return empty for ToolSearch with missing query', () => {
      expect(getToolSummary('ToolSearch', {})).toBe('');
    });

    it('should return empty for unknown tools', () => {
      expect(getToolSummary('CustomTool', {})).toBe('');
    });
  });

  describe('getToolSummary - Codex native tools', () => {
    it('returns file count for apply_patch with changes array', () => {
      expect(getToolSummary('apply_patch', {
        changes: [{ path: 'src/a.ts', kind: 'update' }, { path: 'src/b.ts', kind: 'add' }],
      })).toBe('2 files');
    });

    it('returns single filename for apply_patch with one change', () => {
      expect(getToolSummary('apply_patch', {
        changes: [{ path: 'src/main.ts', kind: 'update' }],
      })).toBe('main.ts');
    });

    it('extracts files from patch text markers', () => {
      expect(getToolSummary('apply_patch', {
        patch: '*** Update File: src/main.ts\n--- src/main.ts\n+++ src/main.ts\n@@ ...',
      })).toBe('main.ts');
    });

    it('returns "patch" for apply_patch with unrecognized patch text', () => {
      expect(getToolSummary('apply_patch', { patch: 'diff output here' })).toBe('patch');
    });

    it('returns empty for apply_patch with no input', () => {
      expect(getToolSummary('apply_patch', {})).toBe('');
    });

    it('returns session id for write_stdin', () => {
      expect(getToolSummary('write_stdin', { session_id: 'sess_1', chars: 'y\n' })).toBe('#sess_1 y\\n');
    });

    it('returns chars preview for write_stdin without session', () => {
      expect(getToolSummary('write_stdin', { chars: 'y\n' })).toBe('y\\n');
    });

    it('returns empty for write_stdin with no input', () => {
      expect(getToolSummary('write_stdin', {})).toBe('');
    });

    it('returns message preview for spawn_agent', () => {
      expect(getToolSummary('spawn_agent', { message: 'Update imports' })).toBe('Update imports');
    });

    it('truncates long spawn_agent messages', () => {
      const longMsg = 'a'.repeat(60);
      expect(getToolSummary('spawn_agent', { message: longMsg })).toBe('a'.repeat(50) + '...');
    });

    it('returns agent count and timeout for wait', () => {
      expect(getToolSummary('wait', { ids: ['a1'], timeout_ms: 30000 })).toBe('1 agent, 30s');
    });

    it('returns message preview for send_input', () => {
      expect(getToolSummary('send_input', { message: 'Also update exports.' })).toBe('Also update exports.');
    });

    it('returns empty for resume_agent and close_agent', () => {
      expect(getToolSummary('resume_agent', {})).toBe('');
      expect(getToolSummary('close_agent', {})).toBe('');
    });
  });

  describe('getToolLabel - Codex native tools', () => {
    it('labels apply_patch with summary', () => {
      expect(getToolLabel('apply_patch', {
        changes: [{ path: 'src/foo.ts', kind: 'update' }],
      })).toBe('apply_patch: foo.ts');
    });

    it('labels apply_patch without changes', () => {
      expect(getToolLabel('apply_patch', {})).toBe('apply_patch');
    });

    it('labels write_stdin with summary', () => {
      expect(getToolLabel('write_stdin', { session_id: 's1' })).toBe('write_stdin: #s1');
    });

    it('labels write_stdin without input', () => {
      expect(getToolLabel('write_stdin', {})).toBe('write_stdin');
    });

    it('labels spawn_agent with message', () => {
      expect(getToolLabel('spawn_agent', { message: 'Fix bug' })).toBe('spawn_agent: Fix bug');
    });

    it('labels wait with count', () => {
      expect(getToolLabel('wait', { ids: ['a1', 'a2'], timeout_ms: 5000 })).toBe('wait: 2 agents, 5s');
    });

    it('returns raw name for lifecycle tools with no summary', () => {
      expect(getToolLabel('close_agent', {})).toBe('close_agent');
    });
  });

  describe('WebSearch expanded rendering', () => {
    it('renders Codex search actions instead of the placeholder result text', () => {
      const parentEl = createMockEl();
      const toolCall = createToolCall({
        name: 'WebSearch',
        status: 'completed',
        input: {
          actionType: 'search',
          query: 'obsidian plugin API',
          queries: ['obsidian plugin API', 'obsidian docs'],
        },
        result: 'Search complete',
      });

      const toolEl = renderStoredToolCall(parentEl, toolCall);
      (toolEl.querySelector('.codian-tool-header') as HTMLElement).click();
      const lines = Array.from(toolEl.querySelectorAll('.codian-tool-line')).map(line => line.textContent);

      expect(lines).toContain('Query: obsidian plugin API');
      expect(lines).toContain('Alt query: obsidian docs');
      expect(lines).not.toContain('Search complete');
    });

    it('renders Codex open_page actions from tool input even without a rich result body', () => {
      const parentEl = createMockEl();
      const toolCall = createToolCall({
        name: 'WebSearch',
        status: 'completed',
        input: {
          actionType: 'open_page',
          url: 'https://example.com/docs',
        },
        result: 'Search complete',
      });

      const toolEl = renderStoredToolCall(parentEl, toolCall);
      (toolEl.querySelector('.codian-tool-header') as HTMLElement).click();
      const links = toolEl.querySelectorAll('.codian-tool-link');
      const lines = Array.from(toolEl.querySelectorAll('.codian-tool-line')).map(line => line.textContent);

      expect(lines).toContain('Open page');
      expect(links).toHaveLength(1);
      expect(links[0].getAttribute('href')).toBe('https://example.com/docs');
      expect(links[0].querySelector('.codian-tool-link-title')?.textContent).toBe('https://example.com/docs');
    });
  });

  describe('Read result formatting', () => {
    it('preserves literal arrow prefixes when provider marks result as plain text', () => {
      const parentEl = createMockEl();
      const toolCall = createToolCall({
        status: 'completed',
        result: '1→literal arrow',
        resultFormat: 'plain',
      } as any);

      const toolEl = renderStoredToolCall(parentEl, toolCall);
      (toolEl.querySelector('.codian-tool-header') as HTMLElement).click();

      expect(toolEl.querySelector('.codian-tool-line')?.textContent).toBe('1→literal arrow');
    });

    it('continues stripping numbered line prefixes for default Read results', () => {
      const parentEl = createMockEl();
      const toolCall = createToolCall({
        status: 'completed',
        result: '1→numbered line',
      });

      const toolEl = renderStoredToolCall(parentEl, toolCall);
      (toolEl.querySelector('.codian-tool-header') as HTMLElement).click();

      expect(toolEl.querySelector('.codian-tool-line')?.textContent).toBe('numbered line');
    });
  });

  describe('apply_patch expanded rendering', () => {
    it('renders parsed patch diffs from tool input', () => {
      const parentEl = createMockEl();
      const toolCall = createToolCall({
        name: 'apply_patch',
        status: 'completed',
        input: {
          patch: [
            '*** Begin Patch',
            '*** Update File: src/main.ts',
            '@@',
            "-import { Plugin } from 'obsidian';",
            "+import { Plugin, Notice } from 'obsidian';",
            '*** End Patch',
          ].join('\n'),
        },
        result: 'Applied patch',
      });

      const toolEl = renderStoredToolCall(parentEl, toolCall);
      (toolEl.querySelector('.codian-tool-header') as HTMLElement).click();
      const headers = Array.from(toolEl.querySelectorAll('.codian-tool-patch-header')).map(el => el.textContent);
      const statusEl = toolEl.querySelector('.codian-tool-status');
      const diffTexts = Array.from(toolEl.querySelectorAll('.codian-diff-text')).map(el => el.textContent);

      expect(headers).toHaveLength(0);
      expect(statusEl?.hasClass('codian-write-edit-stats')).toBe(true);
      expect(statusEl?.querySelector('.added')?.textContent).toBe('+1');
      expect(statusEl?.querySelector('.removed')?.textContent).toBe('-1');
      expect(statusEl?.getAttribute('aria-label')).toBe('Changes: +1 -1');
      expect(setIcon).not.toHaveBeenCalledWith(expect.anything(), 'check');
      expect(diffTexts).toContain("import { Plugin } from 'obsidian';");
      expect(diffTexts).toContain("import { Plugin, Notice } from 'obsidian';");
    });

    it('renders stored apply_patch collapsed by default', () => {
      const parentEl = createMockEl();
      const toolCall = createToolCall({
        name: 'apply_patch',
        status: 'completed',
        input: {
          patch: [
            '*** Begin Patch',
            '*** Update File: src/main.ts',
            '@@',
            '-old',
            '+new',
            '*** End Patch',
          ].join('\n'),
        },
        result: 'Applied patch',
      });

      const toolEl = renderStoredToolCall(parentEl, toolCall);
      const header = toolEl.querySelector('.codian-tool-header');
      const content = toolEl.querySelector('.codian-tool-content');

      expect(toolEl.hasClass('expanded')).toBe(false);
      expect(content?.hasClass('codian-hidden')).toBe(true);
      expect(header?.getAttribute('aria-expanded')).toBe('false');
    });

    it('renders stored apply_patch expanded when requested', () => {
      const parentEl = createMockEl();
      const toolCall = createToolCall({
        name: 'apply_patch',
        status: 'completed',
        input: {
          patch: [
            '*** Begin Patch',
            '*** Update File: src/main.ts',
            '@@',
            '-old',
            '+new',
            '*** End Patch',
          ].join('\n'),
        },
        result: 'Applied patch',
      });

      const toolEl = renderStoredToolCall(parentEl, toolCall, { initiallyExpanded: true });
      const header = toolEl.querySelector('.codian-tool-header');
      const content = toolEl.querySelector('.codian-tool-content');

      expect(toolEl.hasClass('expanded')).toBe(true);
      expect(content?.hasClass('codian-hidden')).toBe(false);
      expect(header?.getAttribute('aria-expanded')).toBe('true');
    });

    it('renders fileChange patchUpdated diffs from changes input', () => {
      const parentEl = createMockEl();
      const toolCall = createToolCall({
        name: 'apply_patch',
        status: 'completed',
        input: {
          changes: [
            {
              path: 'src/main.ts',
              kind: 'update',
              diff: '@@ -1 +1 @@\n-old value\n+new value',
            },
          ],
        },
        result: 'Applied patch',
      });

      const toolEl = renderStoredToolCall(parentEl, toolCall);
      (toolEl.querySelector('.codian-tool-header') as HTMLElement).click();
      const headers = Array.from(toolEl.querySelectorAll('.codian-tool-patch-header')).map(el => el.textContent);
      const statusEl = toolEl.querySelector('.codian-tool-status');
      const diffTexts = Array.from(toolEl.querySelectorAll('.codian-diff-text')).map(el => el.textContent);

      expect(headers).toHaveLength(0);
      expect(statusEl?.hasClass('codian-write-edit-stats')).toBe(true);
      expect(statusEl?.querySelector('.added')?.textContent).toBe('+1');
      expect(statusEl?.querySelector('.removed')?.textContent).toBe('-1');
      expect(setIcon).not.toHaveBeenCalledWith(expect.anything(), 'check');
      expect(diffTexts).toContain('old value');
      expect(diffTexts).toContain('new value');
    });

    it('aggregates apply_patch header stats across changed files', () => {
      const parentEl = createMockEl();
      const toolCall = createToolCall({
        name: 'apply_patch',
        status: 'completed',
        input: {
          changes: [
            {
              path: 'src/main.ts',
              kind: 'update',
              diff: '@@ -1 +1 @@\n-old value\n+new value',
            },
            {
              path: 'src/extra.ts',
              kind: 'update',
              diff: '@@ -1 +1,2 @@\n-old extra\n+new extra\n+another extra',
            },
          ],
        },
        result: 'Applied patch',
      });

      const toolEl = renderStoredToolCall(parentEl, toolCall);
      const statusEl = toolEl.querySelector('.codian-tool-status');

      expect(statusEl?.querySelector('.added')?.textContent).toBe('+3');
      expect(statusEl?.querySelector('.removed')?.textContent).toBe('-2');
      expect(statusEl?.getAttribute('aria-label')).toBe('Changes: +3 -2');
    });

    it('keeps the error status icon for failed apply_patch calls', () => {
      const parentEl = createMockEl();
      const toolCall = createToolCall({
        name: 'apply_patch',
        status: 'error',
        input: {
          changes: [
            {
              path: 'src/main.ts',
              kind: 'update',
              diff: '@@ -1 +1 @@\n-old value\n+new value',
            },
          ],
        },
        result: 'Error: patch failed',
      });

      const toolEl = renderStoredToolCall(parentEl, toolCall);
      const statusEl = toolEl.querySelector('.codian-tool-status');

      expect(statusEl?.hasClass('status-error')).toBe(true);
      expect(statusEl?.hasClass('codian-write-edit-stats')).toBe(false);
      expect(setIcon).toHaveBeenCalledWith(expect.anything(), 'x');
    });

    it('updates the header stats when apply_patch diffs arrive during streaming', () => {
      const parentEl = createMockEl();
      const toolCall = createToolCall({
        id: 'patch-1',
        name: 'apply_patch',
        status: 'running',
        input: {},
      });
      const toolCallElements = new Map<string, HTMLElement>();

      const toolEl = renderToolCall(parentEl, toolCall, toolCallElements);
      jest.clearAllMocks();

      toolCall.status = 'completed';
      toolCall.result = 'Applied patch';
      toolCall.input = {
        changes: [
          {
            path: 'src/main.ts',
            kind: 'update',
            diff: '@@ -1 +1 @@\n-old value\n+new value',
          },
        ],
      };

      updateToolCallResult('patch-1', toolCall, toolCallElements);

      const statusEl = toolEl.querySelector('.codian-tool-status');
      const diffTexts = Array.from(toolEl.querySelectorAll('.codian-diff-text')).map(el => el.textContent);

      expect(statusEl?.hasClass('codian-write-edit-stats')).toBe(true);
      expect(statusEl?.querySelector('.added')?.textContent).toBe('+1');
      expect(statusEl?.querySelector('.removed')?.textContent).toBe('-1');
      expect(setIcon).not.toHaveBeenCalledWith(expect.anything(), 'check');
      expect(diffTexts).toContain('old value');
      expect(diffTexts).toContain('new value');
    });

    it('falls back to file changes when patch text is unavailable', () => {
      const parentEl = createMockEl();
      const toolCall = createToolCall({
        name: 'apply_patch',
        status: 'completed',
        input: {
          changes: [{ path: 'src/main.ts', kind: 'update' }],
        },
        result: 'Applied patch',
      });

      const toolEl = renderStoredToolCall(parentEl, toolCall);
      (toolEl.querySelector('.codian-tool-header') as HTMLElement).click();
      const lines = Array.from(toolEl.querySelectorAll('.codian-tool-line')).map(el => el.textContent);

      expect(lines).toContain('src/main.ts');
      expect(lines).not.toContain('update: src/main.ts');
    });
  });

  describe('renderTodoWriteResult', () => {
    it('should render todo items', () => {
      const container = createMockEl();
      const input = {
        todos: [
          { status: 'completed', content: 'Task 1', activeForm: 'Task 1' },
          { status: 'pending', content: 'Task 2', activeForm: 'Task 2' },
        ],
      };
      renderTodoWriteResult(container as unknown as HTMLElement, input);
      expect(container.hasClass('codian-todo-panel-content')).toBe(true);
      expect(container.hasClass('codian-todo-list-container')).toBe(true);
    });

    it('should show fallback text when no todos array', () => {
      const container = createMockEl();
      renderTodoWriteResult(container as unknown as HTMLElement, {});
      expect(container._children[0].textContent).toBe('Tasks updated');
    });

    it('should show fallback text for non-array todos', () => {
      const container = createMockEl();
      renderTodoWriteResult(container as unknown as HTMLElement, { todos: 'invalid' });
      expect(container._children[0].textContent).toBe('Tasks updated');
    });
  });

  describe('updateToolCallResult for TodoWrite', () => {
    it('should update todo status and content', () => {
      const parentEl = createMockEl();
      const toolCall = createToolCall({
        id: 'todo-1',
        name: 'TodoWrite',
        input: {
          todos: [
            { status: 'in_progress', content: 'Task 1', activeForm: 'Working' },
          ],
        },
      });
      const toolCallElements = new Map<string, HTMLElement>();

      renderToolCall(parentEl, toolCall, toolCallElements);

      // Update with all completed
      toolCall.input = {
        todos: [
          { status: 'completed', content: 'Task 1', activeForm: 'Done' },
        ],
      };
      updateToolCallResult('todo-1', toolCall, toolCallElements);

      const statusEl = parentEl.querySelector('.codian-tool-status');
      expect(statusEl?.hasClass('status-completed')).toBe(true);
    });

    it('should do nothing for non-existent tool id', () => {
      const toolCallElements = new Map<string, HTMLElement>();
      updateToolCallResult('nonexistent', createToolCall(), toolCallElements);
      expect(toolCallElements.size).toBe(0);
    });
  });

  describe('renderStoredToolCall for TodoWrite', () => {
    it('should render stored TodoWrite with status', () => {
      const parentEl = createMockEl();
      const toolCall = createToolCall({
        name: 'TodoWrite',
        status: 'completed',
        input: {
          todos: [
            { status: 'completed', content: 'Task 1', activeForm: 'Done' },
          ],
        },
      });

      const toolEl = renderStoredToolCall(parentEl, toolCall);
      expect(toolEl).toBeDefined();
    });
  });

  describe('localization', () => {
    afterEach(() => {
      setLocale('en');
    });

    it.each([
      ['Bash', 'Bash: 命令'],
      ['Glob', 'Glob: 文件'],
      ['Grep', 'Grep: 匹配模式'],
      ['Skill', 'Skill: skill'],
      ['ToolSearch', 'ToolSearch: 工具'],
    ])('localizes the %s placeholder through getToolLabel', (name, expected) => {
      setLocale('zh-CN');
      expect(getToolLabel(name, {})).toBe(expected);
    });

    it('localizes plan mode labels in zh-CN', () => {
      setLocale('zh-CN');
      expect(getToolName('EnterPlanMode', {})).toBe('正在进入规划模式');
      expect(getToolName('ExitPlanMode', {})).toBe('规划完成');
    });

    it('localizes TodoWrite task counts in zh-CN', () => {
      setLocale('zh-CN');
      const todos = [{ status: 'completed' }, { status: 'in_progress' }];
      expect(getToolName('TodoWrite', { todos })).toBe('任务 1/2');
      expect(getToolLabel('TodoWrite', { todos })).toBe('任务（1/2）');
    });

    it.each([1, 2])('localizes wait summaries for %s agents without changing input', count => {
      setLocale('zh-CN');
      const ids = Array.from({ length: count }, (_, index) => `agent-${index}`);
      expect(getToolSummary('wait', { ids, timeout_ms: 5000 })).toBe(`${count} 个代理, 5s`);
    });
  });
});
