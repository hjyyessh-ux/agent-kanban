import { useState } from 'react';
import type { WorkInboxSession } from '../../../../src/core/types';

export function WorkSessionPicker({ sessions, onAdd }: {
  sessions: WorkInboxSession[];
  onAdd: (session: WorkInboxSession) => Promise<void>;
}) {
  const [selected, setSelected] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const session = sessions.find(item => item.sessionId === selected);
  return <details className="work-session-picker">
    <summary>＋ 세션 추가</summary>
    <p className="kv2-session-helper">이 목표로 진행한 미배정 세션을 연결하세요. 새 실행을 시작하지 않습니다.</p>
    {sessions.length === 0 ? <p className="works-empty">연결할 미배정 세션이 없습니다.</p> : <form
      className="works-active-toolbar" onSubmit={event => {
        event.preventDefault();
        if (!session || busy) return;
        setBusy(true); setError(null);
        void onAdd(session).then(() => setSelected(''))
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
    {error && <p role="alert">{error}</p>}
  </details>;
}
