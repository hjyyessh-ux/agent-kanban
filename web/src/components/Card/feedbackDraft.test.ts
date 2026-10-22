import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { clearDraft, readDraftImages, readDraftText, writeDraftImages, writeDraftText } from './feedbackDraft';

const memory = new Map<string, string>();
const fakeStorage = {
  getItem: (key: string) => memory.get(key) ?? null,
  setItem: (key: string, value: string) => void memory.set(key, value),
  removeItem: (key: string) => void memory.delete(key),
} as Storage;

// Other test files share this process — put back whatever was there before.
const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
Object.defineProperty(globalThis, 'localStorage', { value: fakeStorage, configurable: true });

afterAll(() => {
  if (original) Object.defineProperty(globalThis, 'localStorage', original);
  else Reflect.deleteProperty(globalThis, 'localStorage');
});

afterEach(() => {
  memory.clear();
  clearDraft('session:a');
  clearDraft('session:b');
});

describe('feedbackDraft', () => {
  test('text survives until cleared and is scoped per key', () => {
    writeDraftText('session:a', '긴 피드백 초안');
    expect(readDraftText('session:a')).toBe('긴 피드백 초안');
    expect(readDraftText('session:b')).toBe('');

    clearDraft('session:a');
    expect(readDraftText('session:a')).toBe('');
  });

  test('blank text removes the stored draft instead of keeping whitespace', () => {
    writeDraftText('session:a', 'x');
    writeDraftText('session:a', '   ');
    expect(memory.size).toBe(0);
  });

  test('pasted images are kept in memory and cleared with the draft', () => {
    const file = new File(['png'], 'shot.png', { type: 'image/png' });
    writeDraftImages('session:a', [file]);
    expect(readDraftImages('session:a')).toEqual([file]);

    clearDraft('session:a');
    expect(readDraftImages('session:a')).toEqual([]);
  });
});
