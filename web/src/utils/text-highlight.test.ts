import { describe, expect, test } from 'bun:test';
import { findMatchOffsets } from './text-highlight';

describe('findMatchOffsets', () => {
  test('finds every case-insensitive occurrence without overlap', () => {
    expect(findMatchOffsets('Telegram poller, telegram state', 'TELEGRAM')).toEqual([0, 17]);
    expect(findMatchOffsets('aaaa', 'aa')).toEqual([0, 2]);
  });

  test('handles Korean text and empty needles', () => {
    expect(findMatchOffsets('배포 후 배포 확인', '배포')).toEqual([0, 5]);
    expect(findMatchOffsets('anything', '')).toEqual([]);
  });
});
