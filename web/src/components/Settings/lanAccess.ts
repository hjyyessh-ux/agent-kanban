export const LAN_FULL_ACCESS_CONFIRM_MESSAGE = [
  'LAN 전체 접근을 켜시겠습니까?',
  '',
  '이 포트에 접근할 수 있는 같은 네트워크의 모든 기기가 인증 토큰을 받아',
  '카드 실행, Capabilities·Settings 변경을 포함한 전체 권한을 갖습니다.',
].join('\n');

export interface LanFullAccessToggleDeps {
  /** Current persisted value. */
  isOn: boolean;
  /** Asks the user; `window.confirm` in the app, a stub in tests. */
  confirm: (message: string) => boolean;
  update: (value: 'true' | 'false') => Promise<void>;
}

/**
 * Flip `lan_full_access`. Turning it **on** hands every LAN device a full-power
 * token, so it asks first; turning it off only narrows access and is
 * immediate.
 *
 *   OFF → ON, confirm declined  → 'cancelled' (no request)
 *   ON  → OFF                    → 'updated'  (no prompt)
 */
export async function toggleLanFullAccess(
  { isOn, confirm, update }: LanFullAccessToggleDeps,
): Promise<'updated' | 'cancelled'> {
  if (!isOn && !confirm(LAN_FULL_ACCESS_CONFIRM_MESSAGE)) return 'cancelled';
  await update(isOn ? 'false' : 'true');
  return 'updated';
}
