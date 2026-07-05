import type { CapScope } from '../../../../src/core/types';

interface ScopeChipProps {
  scope: CapScope;
  alwaysLoad?: boolean;
  managed?: boolean;
}

const SCOPE_LABELS: Record<CapScope, string> = {
  user: 'user',
  project: 'project',
  local: 'local',
  cold: 'cold',
};

export function ScopeChip({ scope, alwaysLoad, managed }: ScopeChipProps) {
  const title = [
    `scope: ${scope}`,
    alwaysLoad ? 'alwaysLoad — 강제 선로딩' : null,
    managed ? 'managed — 이동 불가' : null,
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <span className={`scope-chip scope-chip--${scope}`} title={title}>
      {alwaysLoad && <span className="scope-chip-icon" aria-hidden="true">⚡</span>}
      {managed && <span className="scope-chip-icon" aria-hidden="true">🔒</span>}
      {SCOPE_LABELS[scope]}
    </span>
  );
}
