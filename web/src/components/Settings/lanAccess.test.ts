import { describe, expect, mock, test } from 'bun:test';
import { LAN_FULL_ACCESS_CONFIRM_MESSAGE, toggleLanFullAccess } from './lanAccess';

describe('toggleLanFullAccess', () => {
  test('turning on asks first and does nothing when declined', async () => {
    const confirm = mock(() => false);
    const update = mock(async () => {});
    expect(await toggleLanFullAccess({ isOn: false, confirm, update })).toBe('cancelled');
    expect(confirm).toHaveBeenCalledWith(LAN_FULL_ACCESS_CONFIRM_MESSAGE);
    expect(update).not.toHaveBeenCalled();
  });

  test('turning on after confirming writes "true"', async () => {
    const update = mock(async (_value: 'true' | 'false') => {});
    expect(await toggleLanFullAccess({ isOn: false, confirm: () => true, update })).toBe('updated');
    expect(update).toHaveBeenCalledWith('true');
  });

  test('turning off is immediate — no prompt', async () => {
    const confirm = mock(() => false);
    const update = mock(async (_value: 'true' | 'false') => {});
    expect(await toggleLanFullAccess({ isOn: true, confirm, update })).toBe('updated');
    expect(confirm).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledWith('false');
  });

  test('a failed update propagates to the caller', async () => {
    const update = mock(async () => { throw new Error('HTTP 403'); });
    await expect(toggleLanFullAccess({ isOn: true, confirm: () => true, update })).rejects.toThrow('HTTP 403');
  });
});
