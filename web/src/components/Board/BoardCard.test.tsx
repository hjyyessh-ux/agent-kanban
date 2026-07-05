import { afterEach, describe, expect, mock, test } from 'bun:test';
import {
  DELETE_CARD_CONFIRM_MESSAGE,
  confirmBoardCardDelete,
} from './BoardCard';

const originalWindow = globalThis.window;

afterEach(() => {
  Object.defineProperty(globalThis, 'window', {
    value: originalWindow,
    configurable: true,
  });
});

describe('confirmBoardCardDelete', () => {
  test('asks before deleting a board card', () => {
    const confirm = mock((message: string) => {
      expect(message).toBe(DELETE_CARD_CONFIRM_MESSAGE);
      return true;
    });
    Object.defineProperty(globalThis, 'window', {
      value: { confirm },
      configurable: true,
    });

    expect(confirmBoardCardDelete()).toBe(true);
    expect(confirm).toHaveBeenCalledTimes(1);
  });

  test('returns false when the user cancels', () => {
    const confirm = mock(() => false);
    Object.defineProperty(globalThis, 'window', {
      value: { confirm },
      configurable: true,
    });

    expect(confirmBoardCardDelete()).toBe(false);
    expect(confirm).toHaveBeenCalledTimes(1);
  });
});
