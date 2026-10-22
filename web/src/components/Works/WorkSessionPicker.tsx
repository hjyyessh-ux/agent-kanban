import { useState } from 'react';
import type { WorkInboxSession } from '../../../../src/core/types';

/**
 * `＋ 세션 연결` — one line under the session list. It used to be a heading,
 * a helper sentence and "없습니다" even when nothing could be linked; now the
 * line says how many unassigned sessions exist and only opens into the
 * select when there is one to pick.
 */
export function WorkSessionPicker({ sessions, onAdd }: {
  sessions: WorkInboxSession[];
  onAdd: (session: WorkInboxSession) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const session = sessions.find(item => item.sessionId === selected);
  const empty = sessions.length === 0;
  const expanded = open && !empty;
  return <section className={`work-session-picker${expanded ? ' is-open' : ''}`} aria-label="세션 추가">
    <button type="button" className="work-session-picker-toggle" aria-expanded={expanded}
      disabled={empty} onClick={() => setOpen(value => !value)}>
      <span className="work-session-picker-plus" aria-hidden="true">＋</span> 세션 연결{' '}
      <span className="work-session-picker-count">
        · {empty ? '연결할 미배정 세션 없음' : `미배정 ${sessions.length}개`}
      </span>
    </button>
    {expanded && <form
      className="works-active-toolbar" onSubmit={event => {
        event.preventDefault();
        if (!session || busy) return;
        setBusy(true); setError(null);
        void onAdd(session).then(() => { setSelected(''); setOpen(false); })
          .catch((e: unknown) => setError(e instanceof Error ? e.message : '세션 연결에 실패했습니다'))
          .finally(() => setBusy(false));
      }}>
      <select className="kv2-select" aria-label="연결할 세션" value={session ? selected : ''}
        disabled={busy} onChange={event => setSelected(event.target.value)}>
        <option value="">미배정 세션 선택</option>
        {sessions.map(item => <option key={item.sessionId} value={item.sessionId}>
          {item.sessionTitle || item.cardTitle} · {item.agentRuntime}
        </option>)}
      </select>
      <button className="kv2-btn kv2-btn--primary" disabled={!session || busy}>{busy ? '연결 중…' : '이 Work에 연결'}</button>
    </form>}
    {error && <p role="alert" className="work-date-error">{error}</p>}
  </section>;
}
