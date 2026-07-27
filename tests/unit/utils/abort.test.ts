import { throwIfAborted, toAbortError } from '@/utils/abort';

describe('abort utilities', () => {
  describe('toAbortError', () => {
    it('returns the reason directly if it is an Error instance', () => {
      const originalError = new Error('Custom abort reason');
      const controller = new AbortController();
      controller.abort(originalError);

      const result = toAbortError(controller.signal, 'Fallback message');
      expect(result).toBe(originalError);
    });

    it('wraps string reason in Error with fallback or message and cause', () => {
      const controller = new AbortController();
      controller.abort('caller cancelled');

      const result = toAbortError(controller.signal, 'Fallback message');
      expect(result).toBeInstanceOf(Error);
      expect(result.message).toBe('Fallback message');
      expect(result.cause).toBe('caller cancelled');
    });

    it('extracts name and message from error-like object reasons', () => {
      const controller = new AbortController();
      controller.abort({ name: 'CustomError', message: 'Something aborted' });

      const result = toAbortError(controller.signal, 'Fallback message');
      expect(result).toBeInstanceOf(Error);
      expect(result.name).toBe('CustomError');
      expect(result.message).toBe('Something aborted');
    });
  });

  describe('throwIfAborted', () => {
    it('does nothing when signal is undefined or not aborted', () => {
      expect(() => throwIfAborted(undefined, 'Fallback')).not.toThrow();

      const controller = new AbortController();
      expect(() => throwIfAborted(controller.signal, 'Fallback')).not.toThrow();
    });

    it('throws normalized abort error when signal is aborted', () => {
      const controller = new AbortController();
      controller.abort('aborted');

      expect(() => throwIfAborted(controller.signal, 'Failed')).toThrow();
    });
  });
});
