import { decodeSessionToolCall, SESSION_TOOL_SPECS } from '@/core/session-tools/sessionToolSpecs';
import {
  SESSION_TOOLS,
  TOOL_CODIAN_LIST_DESTINATIONS,
  TOOL_CODIAN_READ_SESSION,
  TOOL_CODIAN_SEND_MESSAGE,
} from '@/core/tools/toolNames';

describe('session tool specs', () => {
  it('describe the tools with closed JSON Schema inputs and the optional-reply guidance', () => {
    expect(SESSION_TOOL_SPECS.map(spec => spec.name)).toEqual([...SESSION_TOOLS]);
    for (const spec of SESSION_TOOL_SPECS) {
      expect(spec.inputSchema).toMatchObject({ type: 'object', additionalProperties: false });
    }
    const send = SESSION_TOOL_SPECS.find(spec => spec.name === TOOL_CODIAN_SEND_MESSAGE)!;
    // Text is optional only for an interrupt that just stops; decoding enforces that.
    expect(send.inputSchema.required).toBeUndefined();
    expect(Object.keys(send.inputSchema.properties)).toEqual(['sessionId', 'text', 'mode', 'provider', 'model', 'reasoning']);
    for (const mode of ['"queue"', '"steer"', '"interrupt"']) expect(send.inputSchema.properties.mode?.description).toContain(mode);
    expect(send.description).toContain('<session_message');
    expect(send.description).toMatch(/only if a response is needed/);
    // Explicit new-session choices point at the listing instead of embedding a stale option list.
    for (const key of ['model', 'reasoning']) {
      expect(send.inputSchema.properties[key]?.description).toMatch(/switches that session's selection, which persists/);
    }
    for (const key of ['provider', 'model', 'reasoning']) {
      expect(send.inputSchema.properties[key]?.description).toContain(`${TOOL_CODIAN_LIST_DESTINATIONS} with includeProviders: true`);
    }
    const list = SESSION_TOOL_SPECS.find(spec => spec.name === TOOL_CODIAN_LIST_DESTINATIONS)!;
    expect(list.inputSchema.properties).toEqual({
      includeProviders: expect.objectContaining({ type: 'boolean' }),
      limit: expect.objectContaining({ type: 'integer' }),
    });
    expect(list.inputSchema.required).toBeUndefined();
    // The caller can recognize its own row, and a send result names its recipient.
    expect(list.description).toMatch(/self[^.]*calling session/);
    expect(send.description).toContain('{sessionId, title, provider, status}');
    const read = SESSION_TOOL_SPECS.find(spec => spec.name === TOOL_CODIAN_READ_SESSION)!;
    expect(read.inputSchema.required).toEqual(['sessionId']);
    expect(Object.keys(read.inputSchema.properties)).toEqual(['sessionId', 'beforeTurn']);
    // Mentions carry only the id, so the reader must learn where the id comes from and how to page back.
    expect(read.description).toContain('<context_session');
    expect(read.description).toMatch(/fromTurn[^.]*as beforeTurn/);
  });
});

describe('decodeSessionToolCall', () => {
  it.each([
    ['list with no arguments', TOOL_CODIAN_LIST_DESTINATIONS, undefined,
      { tool: TOOL_CODIAN_LIST_DESTINATIONS, args: { includeProviders: false, limit: 50 } }],
    ['list with empty arguments', TOOL_CODIAN_LIST_DESTINATIONS, {},
      { tool: TOOL_CODIAN_LIST_DESTINATIONS, args: { includeProviders: false, limit: 50 } }],
    ['list with providers and a limit', TOOL_CODIAN_LIST_DESTINATIONS, { includeProviders: true, limit: 200 },
      { tool: TOOL_CODIAN_LIST_DESTINATIONS, args: { includeProviders: true, limit: 200 } }],
    ['list treating null optionals as omitted', TOOL_CODIAN_LIST_DESTINATIONS, { includeProviders: null, limit: null },
      { tool: TOOL_CODIAN_LIST_DESTINATIONS, args: { includeProviders: false, limit: 50 } }],
    ['send to a session', TOOL_CODIAN_SEND_MESSAGE, { sessionId: 'conv-1', text: 'Hi' },
      { tool: TOOL_CODIAN_SEND_MESSAGE, args: { sessionId: 'conv-1', text: 'Hi' } }],
    ['send to a new session with provider and model', TOOL_CODIAN_SEND_MESSAGE,
      { text: 'Hi', provider: 'codex', model: 'gpt-5' },
      { tool: TOOL_CODIAN_SEND_MESSAGE, args: { text: 'Hi', provider: 'codex', model: 'gpt-5' } }],
    ['send switching an existing session\'s model and reasoning', TOOL_CODIAN_SEND_MESSAGE,
      { sessionId: 'conv-1', text: 'Hi', model: 'gpt-5', reasoning: 'low' },
      { tool: TOOL_CODIAN_SEND_MESSAGE, args: { sessionId: 'conv-1', text: 'Hi', model: 'gpt-5', reasoning: 'low' } }],
    ['send to a new session with model and reasoning', TOOL_CODIAN_SEND_MESSAGE,
      { text: 'Hi', model: 'gpt-5', reasoning: 'low' },
      { tool: TOOL_CODIAN_SEND_MESSAGE, args: { text: 'Hi', model: 'gpt-5', reasoning: 'low' } }],
    ['send treating null optionals as omitted', TOOL_CODIAN_SEND_MESSAGE,
      { sessionId: null, text: 'Hi', provider: null, model: null, reasoning: null },
      { tool: TOOL_CODIAN_SEND_MESSAGE, args: { text: 'Hi' } }],
    ['read the latest turns', TOOL_CODIAN_READ_SESSION, { sessionId: 'conv-1', beforeTurn: null },
      { tool: TOOL_CODIAN_READ_SESSION, args: { sessionId: 'conv-1' } }],
    ['read earlier turns', TOOL_CODIAN_READ_SESSION, { sessionId: 'conv-1', beforeTurn: 4 },
      { tool: TOOL_CODIAN_READ_SESSION, args: { sessionId: 'conv-1', beforeTurn: 4 } }],
    ['a queue send as the default mode', TOOL_CODIAN_SEND_MESSAGE, { sessionId: 'conv-1', text: 'Hi', mode: 'queue' },
      { tool: TOOL_CODIAN_SEND_MESSAGE, args: { sessionId: 'conv-1', text: 'Hi' } }],
    ['a steer', TOOL_CODIAN_SEND_MESSAGE, { sessionId: 'conv-1', text: 'Also check X', mode: 'steer' },
      { tool: TOOL_CODIAN_SEND_MESSAGE, args: { sessionId: 'conv-1', text: 'Also check X', mode: 'steer' } }],
    ['an interrupt with a message and a switch', TOOL_CODIAN_SEND_MESSAGE,
      { sessionId: 'conv-1', text: 'Do Y instead', mode: 'interrupt', model: 'm', reasoning: 'low' },
      { tool: TOOL_CODIAN_SEND_MESSAGE, args: { sessionId: 'conv-1', text: 'Do Y instead', mode: 'interrupt', model: 'm', reasoning: 'low' } }],
    ['an interrupt that only stops', TOOL_CODIAN_SEND_MESSAGE, { sessionId: 'conv-1', mode: 'interrupt', text: null },
      { tool: TOOL_CODIAN_SEND_MESSAGE, args: { sessionId: 'conv-1', mode: 'interrupt' } }],
  ])('decodes %s', (_label, name, args, call) => {
    expect(decodeSessionToolCall(name, args)).toEqual({ ok: true, call });
  });

  it.each([
    ['an unknown tool', 'send_message', { text: 'Hi' }, /unknown session tool/i],
    ['non-object arguments', TOOL_CODIAN_SEND_MESSAGE, '{"text":"Hi"}', /arguments must be an object/i],
    ['array arguments', TOOL_CODIAN_LIST_DESTINATIONS, [], /arguments must be an object/i],
    ['unexpected list arguments', TOOL_CODIAN_LIST_DESTINATIONS, { sessionId: 'x' }, /unexpected argument "sessionId"/i],
    ['a non-boolean includeProviders', TOOL_CODIAN_LIST_DESTINATIONS, { includeProviders: 'true' }, /"includeProviders" must be a boolean/],
    ['a zero limit', TOOL_CODIAN_LIST_DESTINATIONS, { limit: 0 }, /"limit" must be an integer from 1 to 200/],
    ['an oversized limit', TOOL_CODIAN_LIST_DESTINATIONS, { limit: 201 }, /"limit" must be an integer from 1 to 200/],
    ['a fractional limit', TOOL_CODIAN_LIST_DESTINATIONS, { limit: 2.5 }, /"limit" must be an integer from 1 to 200/],
    ['a string limit', TOOL_CODIAN_LIST_DESTINATIONS, { limit: '10' }, /"limit" must be an integer from 1 to 200/],
    ['unexpected send arguments', TOOL_CODIAN_SEND_MESSAGE, { text: 'Hi', to: 'x' }, /unexpected argument "to"/i],
    ['missing text', TOOL_CODIAN_SEND_MESSAGE, { sessionId: 'conv-1' }, /"text" must be a non-empty string/],
    ['blank text', TOOL_CODIAN_SEND_MESSAGE, { text: '  \n' }, /"text" must be a non-empty string/],
    ['a non-string session id', TOOL_CODIAN_SEND_MESSAGE, { sessionId: 7, text: 'Hi' }, /"sessionId" must be a non-empty string/],
    ['an empty provider', TOOL_CODIAN_SEND_MESSAGE, { text: 'Hi', provider: '' }, /"provider" must be a non-empty string/],
    ['provider for an existing session', TOOL_CODIAN_SEND_MESSAGE, { sessionId: 'conv-1', text: 'Hi', provider: 'codex' },
      /"provider" applies only when "sessionId" is omitted/],
    ['provider with model for an existing session', TOOL_CODIAN_SEND_MESSAGE,
      { sessionId: 'conv-1', text: 'Hi', provider: 'claude', model: 'm' }, /"provider" applies only when "sessionId" is omitted/],
    ['an empty reasoning', TOOL_CODIAN_SEND_MESSAGE, { text: 'Hi', reasoning: ' ' }, /"reasoning" must be a non-empty string/],
    ['a provider without a model', TOOL_CODIAN_SEND_MESSAGE, { text: 'Hi', provider: 'codex' }, /"provider" requires "model"/],
    ['a provider with only reasoning', TOOL_CODIAN_SEND_MESSAGE, { text: 'Hi', provider: 'codex', reasoning: 'high' }, /"provider" requires "model"/],
    ['a read without a session', TOOL_CODIAN_READ_SESSION, {}, /"sessionId" must be a non-empty string/],
    ['a read with a blank session', TOOL_CODIAN_READ_SESSION, { sessionId: ' ' }, /"sessionId" must be a non-empty string/],
    ['a read before turn zero', TOOL_CODIAN_READ_SESSION, { sessionId: 'conv-1', beforeTurn: 0 }, /"beforeTurn" must be a positive integer/],
    ['a fractional beforeTurn', TOOL_CODIAN_READ_SESSION, { sessionId: 'conv-1', beforeTurn: 1.5 }, /"beforeTurn" must be a positive integer/],
    ['unexpected read arguments', TOOL_CODIAN_READ_SESSION, { sessionId: 'conv-1', limit: 3 }, /unexpected argument "limit"/i],
    ['an unknown mode', TOOL_CODIAN_SEND_MESSAGE, { sessionId: 'conv-1', text: 'Hi', mode: 'now' }, /"mode" must be "queue", "steer" or "interrupt"/],
    ['a steer without text', TOOL_CODIAN_SEND_MESSAGE, { sessionId: 'conv-1', mode: 'steer' }, /"text" must be a non-empty string/],
    ['a blank interrupt text', TOOL_CODIAN_SEND_MESSAGE, { sessionId: 'conv-1', mode: 'interrupt', text: ' ' }, /"text" must be a non-empty string/],
    ['a steer to a new session', TOOL_CODIAN_SEND_MESSAGE, { text: 'Hi', mode: 'steer' }, /"steer" and "interrupt" need "sessionId"/],
    ['an interrupt of a new session', TOOL_CODIAN_SEND_MESSAGE, { mode: 'interrupt' }, /"steer" and "interrupt" need "sessionId"/],
    ['a steer with a model switch', TOOL_CODIAN_SEND_MESSAGE, { sessionId: 'conv-1', text: 'Hi', mode: 'steer', model: 'm' },
      /"model" and "reasoning" cannot be used with "steer"/],
    ['a stop-only interrupt with a reasoning switch', TOOL_CODIAN_SEND_MESSAGE, { sessionId: 'conv-1', mode: 'interrupt', reasoning: 'low' },
      /"model" and "reasoning" need "text"/],
  ])('rejects %s', (_label, name, args, error) => {
    const result = decodeSessionToolCall(name, args);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toMatch(error);
  });
});
