import type { WorkCardActivity } from '../../../../src/core/types';
import { CardMarkdown } from '../Card/CardMarkdown';

const STATUS_LABELS = { todo: '대기', in_progress: '진행 중', complete: '실행 완료', done: '완료' };

/** The Work's own history, including records no longer on the board. */
export function WorkActivityPanel({ activities, resultsOnly, loading, onOpenSession }: {
  activities: WorkCardActivity[];
  resultsOnly: boolean;
  loading?: boolean;
  onOpenSession: (id: string) => void;
}) {
  const shown = resultsOnly ? activities.filter(card => card.result?.trim()) : activities;
  return (
    <section className="kv2-detail-primary-block work-detail-section" aria-label={resultsOnly ? '작업 결과' : '활동 타임라인'}>
      <div className="kv2-panel-heading">
        <span className="kv2-session-title">{resultsOnly ? '작업 결과' : '활동 타임라인'}</span>
        <span className="kv2-badge">{shown.length}</span>
      </div>
      {loading && <p role="status">작업 기록을 불러오는 중…</p>}
      {!loading && shown.length === 0 && <p className="works-empty">{resultsOnly
        ? '아직 저장된 실행 결과가 없습니다. 카드의 실행이 끝나면 이곳에서 확인할 수 있습니다.'
        : '연결된 세션에 카드가 생기면 작업 흐름을 이곳에 표시합니다.'}</p>}
      <ol className="work-activity-list">
        {shown.map(card => (
          <li key={card.id} className="work-activity-item">
            <div className="works-card-meta">
              <time dateTime={card.updatedAt}>{new Date(card.updatedAt).toLocaleString('ko-KR')}</time>
              <span className="kv2-badge">{STATUS_LABELS[card.status]}</span>
              {card.archived && <span>보관됨</span>}
            </div>
            <div className="work-detail-heading">
              <strong>{card.title}</strong>
              {card.sessionId && <button type="button" className="kv2-btn kv2-btn--small kv2-btn--outline"
                onClick={() => onOpenSession(card.sessionId!)}>대화 · 이어서 작업</button>}
            </div>
            {resultsOnly && card.result && <CardMarkdown text={card.result} />}
          </li>
        ))}
      </ol>
    </section>
  );
}
