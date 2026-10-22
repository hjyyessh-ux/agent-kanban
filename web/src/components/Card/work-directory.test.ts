import { describe, expect, test } from 'bun:test';
import { directoryAfterWorkPick } from './work-directory';

describe('directoryAfterWorkPick', () => {
  test('fills an empty Directory from the Work', () => {
    expect(directoryAfterWorkPick('', null, { projectDir: '/repo/zepetoful' })).toBe('/repo/zepetoful');
    expect(directoryAfterWorkPick('   ', null, { projectDir: '/repo/zepetoful' })).toBe('/repo/zepetoful');
  });

  test('replaces a value the previous pick filled', () => {
    expect(directoryAfterWorkPick('/repo/a', '/repo/a', { projectDir: '/repo/b' })).toBe('/repo/b');
  });

  test('never overwrites a path the user typed', () => {
    expect(directoryAfterWorkPick('/repo/mine', '/repo/a', { projectDir: '/repo/b' })).toBe('/repo/mine');
    expect(directoryAfterWorkPick('/repo/mine', null, { projectDir: '/repo/b' })).toBe('/repo/mine');
  });

  test('a Work without projectDir, or clearing the Work, keeps the Directory', () => {
    expect(directoryAfterWorkPick('/repo/a', '/repo/a', { projectDir: undefined })).toBe('/repo/a');
    expect(directoryAfterWorkPick('/repo/a', '/repo/a', undefined)).toBe('/repo/a');
  });
});
