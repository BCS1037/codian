import {
  addPiPreviousSession,
  buildPersistedPiState,
  getPiState,
} from '@/providers/pi/types';

describe('Pi provider state continuity', () => {
  it('parses and persists previous session segments', () => {
    const state = getPiState({
      previousSessions: [
        { sessionFile: ' /tmp/previous.jsonl ', sessionId: 'previous-session', leafEntryId: 'leaf-1' },
        { sessionId: ' ' },
        { ignored: true },
      ],
    });

    expect(state.previousSessions).toEqual([{
      sessionFile: '/tmp/previous.jsonl',
      sessionId: 'previous-session',
      leafEntryId: 'leaf-1',
    }]);
    expect(buildPersistedPiState(state)).toEqual({
      previousSessions: [{
        sessionFile: '/tmp/previous.jsonl',
        sessionId: 'previous-session',
        leafEntryId: 'leaf-1',
      }],
    });
  });

  it('adds a previous session once without mutating existing state', () => {
    const existing = [{ sessionId: 'previous-session' }];

    expect(addPiPreviousSession(existing, { sessionId: 'previous-session' })).toEqual(existing);
    expect(addPiPreviousSession(existing, { sessionFile: '/tmp/next.jsonl' })).toEqual([
      { sessionId: 'previous-session' },
      { sessionFile: '/tmp/next.jsonl' },
    ]);
    expect(existing).toEqual([{ sessionId: 'previous-session' }]);
  });
});
