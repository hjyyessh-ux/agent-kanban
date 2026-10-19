export type CapabilityErrorKey = 'skills' | 'scripts' | 'skillRoots';

export interface CapabilityErrorSource {
  key: CapabilityErrorKey;
  error: string | null | undefined;
}

export interface CapabilityAlert {
  key: CapabilityErrorKey;
  title: string;
  message: string;
}

const TITLES: Record<CapabilityErrorKey, string> = {
  skills: 'Skill 목록을 불러오거나 동기화하지 못했습니다',
  scripts: 'Script 목록을 불러오거나 동기화하지 못했습니다',
  skillRoots: 'Skill 디렉토리 목록을 불러오지 못했습니다',
};

/**
 * One alert per failing source, in a stable order. Without these a failed
 * fetch or sync left the hook's list empty and the tab read "no capabilities"
 * — indistinguishable from a machine that genuinely has none.
 *
 *   [{ key: 'skills', error: 'HTTP 500' }, { key: 'scripts', error: null }]
 *     → [{ key: 'skills', title: 'Skill 목록을…', message: 'HTTP 500' }]
 */
export function buildCapabilityAlerts(sources: readonly CapabilityErrorSource[]): CapabilityAlert[] {
  return sources.flatMap(({ key, error }) => {
    const message = error?.trim();
    return message ? [{ key, title: TITLES[key], message }] : [];
  });
}
