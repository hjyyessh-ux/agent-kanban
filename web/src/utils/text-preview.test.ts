import { describe, expect, test } from 'bun:test';
import { previewLine } from './text-preview';

describe('previewLine', () => {
  test('drops link and emphasis syntax before list markers', () => {
    expect(previewLine('[설정 절차](https://example.com/a)를 정리했습니다')).toBe('설정 절차를 정리했습니다');
    expect(previewLine('**1. 왜 잘리는가**: 원인')).toBe('왜 잘리는가: 원인');
    expect(previewLine('\n---\n## **결과** 요약')).toBe('결과 요약');
  });

  test('strips stacked block prefixes', () => {
    expect(previewLine('### 1. 왜 잘리는가')).toBe('왜 잘리는가');
    expect(previewLine('> - 인용 속 목록')).toBe('인용 속 목록');
  });

  test('skips code fences and keeps underscores inside words', () => {
    expect(previewLine('```text\nghes_migration 완료\n```')).toBe('ghes_migration 완료');
    expect(previewLine('_강조_ 그리고 snake_case')).toBe('강조 그리고 snake_case');
  });
});
