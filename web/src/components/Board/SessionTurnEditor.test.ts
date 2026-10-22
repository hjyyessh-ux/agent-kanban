import { describe, expect, test } from 'bun:test';
import { splitFeedbackHeader } from '../../../../src/core/mention-search';
import { joinFeedbackPrompt } from './SessionTurnEditor';

describe('joinFeedbackPrompt', () => {
  test('keeps the feedback header and replaces only the body', () => {
    const description = '[Feedback for: 원본]\n[Original Card ID: abc]\n---\n\n이전 요청';
    const { header } = splitFeedbackHeader(description);
    const next = joinFeedbackPrompt(header, '  고친 요청\n');
    expect(next).toBe('[Feedback for: 원본]\n[Original Card ID: abc]\n---\n\n고친 요청');
    expect(splitFeedbackHeader(next)).toEqual({ header, body: '고친 요청' });
  });

  test('a prompt without a header is just the trimmed body', () => {
    expect(joinFeedbackPrompt('', '\n새 요청 ')).toBe('새 요청');
  });
});
