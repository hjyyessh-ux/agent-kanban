import { useMemo, useState } from 'react';
import type { Work, WorkInboxSession, WorkSessionRole } from '../../../../src/core/types';
import {
  ROLE_LABELS,
  ROLE_OPTIONS,
  recommendWorksForSession,
  suggestWorkTitle,
  daysSince,
} from './worksAssign';

interface WorkAssignInlineProps {
  session: WorkInboxSession;
  works: Work[];
  onCancel: () => void;
  onCreateWork: (title: string, role?: WorkSessionRole) => Promise<void>;
  onLinkToWork: (workId: string, role?: WorkSessionRole) => Promise<void>;
  onIgnore: () => Promise<void>;
}

type AssignMode = 'new' | 'existing';

/**
 * Inline expansion under an Inbox row: pick "새 Work 만들기" (title pre-seeded
 * from the first prompt) or "기존 Work에 연결" (same-directory active Works
 * recommended first, with a role selector). The pure ranking + title helpers in
 * worksAssign.ts are shared with the assign-all modal (card 3).
 */
export function WorkAssignInline({
  session,
  works,
  onCancel,
  onCreateWork,
  onLinkToWork,
  onIgnore,
}: WorkAssignInlineProps) {
  const recommendations = useMemo(
    () => recommendWorksForSession(session, works),
    [session, works],
  );
  const suggestedTitle = useMemo(() => suggestWorkTitle(session), [session]);

  const [mode, setMode] = useState<AssignMode>(
    recommendations.length > 0 ? 'existing' : 'new',
  );
  const [title, setTitle] = useState(suggestedTitle);
  const [selectedWorkId, setSelectedWorkId] = useState<string>(
    recommendations[0]?.work.id ?? '',
  );
  const [role, setRole] = useState<WorkSessionRole>('dev');
  const [busy, setBusy] = useState(false);

  const selectedWork = recommendations.find((r) => r.work.id === selectedWorkId)?.work;
  const canSubmit =
    mode === 'new' ? title.trim().length > 0 : Boolean(selectedWorkId);

  const runAction = async (action: () => Promise<void>) => {
    setBusy(true);
    try {
      await action();
    } finally {
      setBusy(false);
    }
  };

  const handleSubmit = () => {
    if (!canSubmit || busy) return;
    if (mode === 'new') {
      void runAction(() => onCreateWork(title.trim(), role));
    } else {
      void runAction(() => onLinkToWork(selectedWorkId, role));
    }
  };

  return (
    <div className="works-assign-inline">
      <div className="works-assign-lead">이 세션을 어디에 연결할까요?</div>

      <div className="works-assign-options">
        <button
          type="button"
          className={`works-assign-option${mode === 'new' ? ' is-selected' : ''}`}
          aria-pressed={mode === 'new'}
          onClick={() => setMode('new')}
        >
          <span className="works-assign-opt-title">＋ 새 Work 만들기</span>
          <span className="works-assign-opt-desc">제목 자동 제안: "{suggestedTitle}"</span>
        </button>
        <button
          type="button"
          className={`works-assign-option${mode === 'existing' ? ' is-selected' : ''}`}
          aria-pressed={mode === 'existing'}
          disabled={recommendations.length === 0}
          onClick={() => setMode('existing')}
        >
          <span className="works-assign-opt-title">↳ 기존 Work에 연결</span>
          <span className="works-assign-opt-desc">
            {recommendations.length === 0
              ? '연결 가능한 active Work 없음'
              : '같은 projectDir의 active Work를 우선 추천'}
          </span>
        </button>
      </div>

      {mode === 'new' ? (
        <div className="works-assign-new">
          <label className="kv2-label" htmlFor="works-new-title">새 Work 제목</label>
          <input
            id="works-new-title"
            className="kv2-input"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="Work 제목"
          />
          <div className="works-assign-role">
            <label className="kv2-label" htmlFor="works-new-role">이 세션 역할</label>
            <select
              id="works-new-role"
              className="kv2-select"
              value={role}
              onChange={(event) => setRole(event.target.value as WorkSessionRole)}
            >
              {ROLE_OPTIONS.map((option) => (
                <option key={option} value={option}>{ROLE_LABELS[option]}</option>
              ))}
            </select>
          </div>
        </div>
      ) : (
        <>
          <div className="works-assign-work-list" role="listbox" aria-label="연결할 Work">
            {recommendations.map(({ work, sameDirectory }) => {
              const selected = work.id === selectedWorkId;
              return (
                <button
                  type="button"
                  key={work.id}
                  role="option"
                  aria-selected={selected}
                  className={`works-assign-work-item${selected ? ' is-selected' : ''}`}
                  onClick={() => setSelectedWorkId(work.id)}
                >
                  <span className="works-assign-work-bar" />
                  <span className="works-assign-work-title">{work.title}</span>
                  <span className="works-assign-work-ago">
                    {sameDirectory ? '추천 · 같은 디렉토리 · ' : ''}
                    {daysSince(work.startedAt) + 1}일째
                  </span>
                </button>
              );
            })}
          </div>
          {selectedWork && (
            <div className="works-assign-role">
              <label className="kv2-label" htmlFor="works-link-role">이 세션 역할</label>
              <select
                id="works-link-role"
                className="kv2-select"
                value={role}
                onChange={(event) => setRole(event.target.value as WorkSessionRole)}
              >
                {ROLE_OPTIONS.map((option) => (
                  <option key={option} value={option}>{ROLE_LABELS[option]}</option>
                ))}
              </select>
            </div>
          )}
        </>
      )}

      <div className="works-assign-footer">
        <button
          type="button"
          className="kv2-btn kv2-btn--small kv2-btn--ghost works-assign-footer-left"
          disabled={busy}
          onClick={() => void runAction(onIgnore)}
        >
          이 세션 무시 (Work 없이 보관)
        </button>
        <button
          type="button"
          className="kv2-btn kv2-btn--small kv2-btn--outline"
          disabled={busy}
          onClick={onCancel}
        >
          취소
        </button>
        <button
          type="button"
          className="kv2-btn kv2-btn--small kv2-btn--primary"
          disabled={!canSubmit || busy}
          onClick={handleSubmit}
        >
          {mode === 'new'
            ? `"${title.trim() || suggestedTitle}" 만들기`
            : selectedWork
              ? `"${selectedWork.title}"에 연결`
              : '연결'}
        </button>
      </div>
    </div>
  );
}
