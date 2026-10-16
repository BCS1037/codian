import {
  assertOpencodeSessionCompatibility,
} from '@/providers/opencode/runtime/OpencodeSessionCompatibility';

describe('OpenCode stored session compatibility', () => {
  it('rejects v1 ACP sessions with preserved-history guidance', () => {
    expect(() => assertOpencodeSessionCompatibility(1)).toThrow(
      'This conversation was created with OpenCode v1 ACP and cannot resume under V2.',
    );
  });

  it('rejects legacy sessions without a recorded native protocol', () => {
    expect(() => assertOpencodeSessionCompatibility(undefined, true)).toThrow(
      'This conversation has no OpenCode V2 session metadata and cannot resume safely.',
    );
  });

  it('allows V2 sessions and conversations without an existing native session', () => {
    expect(() => assertOpencodeSessionCompatibility(2)).not.toThrow();
    expect(() => assertOpencodeSessionCompatibility(undefined, false)).not.toThrow();
  });
});
