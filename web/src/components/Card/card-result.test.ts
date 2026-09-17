import { describe, expect, test } from 'bun:test';
import { splitCardResult } from './card-result';

describe('splitCardResult', () => {
  test('peels the final block off the joined result', () => {
    const result = splitCardResult({
      result: 'thinking out loud\n\nfirst answer\n\nfinal answer',
      finalResult: 'final answer',
    });
    expect(result).toEqual({ earlier: 'thinking out loud\n\nfirst answer', final: 'final answer' });
  });

  test('treats a single-block run as final only', () => {
    expect(splitCardResult({ result: 'final answer', finalResult: 'final answer' })).toEqual({
      earlier: '',
      final: 'final answer',
    });
  });

  test('falls back to the whole result when finalResult is missing (legacy card)', () => {
    expect(splitCardResult({ result: 'first\n\nsecond' })).toEqual({
      earlier: '',
      final: 'first\n\nsecond',
    });
  });

  test('falls back to the whole result when finalResult is stale', () => {
    expect(splitCardResult({ result: 'rewritten by hand', finalResult: 'from an older run' })).toEqual({
      earlier: '',
      final: 'rewritten by hand',
    });
  });

  test('handles an empty result', () => {
    expect(splitCardResult({ result: '', finalResult: 'x' })).toEqual({ earlier: '', final: '' });
  });
});
