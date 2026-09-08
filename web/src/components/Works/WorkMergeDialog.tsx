import { useMemo, useState } from 'react';
import type { KanbanCard, Work } from '../../../../src/core/types';
import { DialogSkeleton } from '../Card/DialogSkeleton';
import { dirAccentClass } from './worksAffinity';
import {
  describeWorkMergeImpact,
  formatTimeAgo,
  mergeTargetsFor,
  projectDirLabel,
} from './worksAssign';
import './Works.css';

interface WorkMergeDialogProps {
  /** The Work being folded away — the merge *source*. */
  work: Work;
  /** Every Work the client knows about; the pickable subset is derived here. */
  works: Work[];
  /** Board cards — the same input the server derives `startedAt` from. */
  cards: KanbanCard[];
  onClose: () => void;
  /** `POST /api/works/:id/merge`. Rejects with the server's message on 4xx/409. */
  onMerge: (intoWorkId: string) => Promise<void>;
}

/**
 * "이 Work를 어디에 합칠까" — the target picker in front of
 * `POST /api/works/:id/merge`.
 *
 * Two Works turning out to be one piece of work is routine (a session got
 * triaged into a new Work before anyone noticed the older one existed), and the
 * only way to reconcile them was to move sessions out of one Work one at a time
 * until it emptied — at which point the server *deletes* it, taking its Summary,
 * notes and Timeline history with it, with no undo.
 *
 * Shaped after `MoveSessionDialog` deliberately: same target list, same
 * "state the consequences above the confirm button" preview, same
 * keep-the-dialog-open-on-rejection error handling. What differs is the unit —
 * the whole Work, not one session — so the preview also names what happens to
 * the source, which here survives as `discarded` / `superseded` rather than
 * being deleted.
 */
export function WorkMergeDialog({
  work,
  works,
  cards,
  onClose,
  onMerge,
}: WorkMergeDialogProps) {
  const [query, setQuery] = useState('');
  const [targetId, setTargetId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // `active` targets only: the store's move gate refuses both ends of an
  // archived or mid-completion Work, so offering one would be a 409 in waiting.
  const targets = useMemo(
    () => mergeTargetsFor(work, works, query),
    [work, works, query],
  );
  const target = targets.find((candidate) => candidate.id === targetId) ?? null;
  const preview = useMemo(
    () => (target ? describeWorkMergeImpact(work, target, cards) : []),
    [work, target, cards],
  );

  const run = () => {
    if (!target || busy) return;
    setBusy(true);
    setError(null);
    void onMerge(target.id)
      .then(() => { onClose(); })
      .catch((e: unknown) => {
        setError(e instanceof Error ? e.message : 'Work를 병합하지 못했습니다');
      })
      .finally(() => setBusy(false));
  };

  // Rendered *inside* the Work detail dialog so the parent's focus trap still
  // contains it; `DialogSkeleton` stops Escape on its own `.kv2-dialog`, so the
  // key closes this dialog only.
  return (
    <DialogSkeleton
      title="Work 병합"
      onClose={onClose}
      width="640px"
      className="work-move-dialog"
    >
      <div className="work-move-body">
        <p className="works-assign-lead">
          "{work.title}"의 세션 {work.sessionLinks.length}개를 다른 Work로 옮기고, 이 Work는 병합됨으로 닫습니다.
        </p>

        <input
          type="search"
          className="kv2-input"
          placeholder="합칠 Work 검색 (제목·디렉토리)"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="합칠 Work 검색"
        />

        {targets.length === 0 ? (
          <p className="work-merge-empty">
            {query.trim()
              ? '검색 결과가 없습니다.'
              : '합칠 수 있는 진행 중 Work가 없습니다.'}
          </p>
        ) : (
          <div className="works-assign-work-list" role="group" aria-label="합칠 Work">
            {targets.map((candidate) => (
              <button
                key={candidate.id}
                type="button"
                className={`works-assign-work-item ${dirAccentClass(candidate.projectDir)}${candidate.id === targetId ? ' is-selected' : ''}`}
                disabled={busy}
                onClick={() => setTargetId(candidate.id)}
              >
                <span className="works-assign-work-bar" />
                <span className="works-assign-work-title">{candidate.title}</span>
                <span className="works-assign-work-ago">
                  {projectDirLabel(candidate.projectDir)} · 세션 {candidate.sessionLinks.length} · {formatTimeAgo(candidate.updatedAt)}
                </span>
              </button>
            ))}
          </div>
        )}

        {preview.length > 0 && (
          <ul className="works-move-preview">
            {preview.map((line) => (
              <li key={line}>ℹ {line}</li>
            ))}
          </ul>
        )}
        {error && <p className="work-move-error">⚠ {error}</p>}
      </div>

      <div className="kv2-dialog-footer">
        <div className="kv2-actions-split">
          <button
            type="button"
            className="kv2-btn kv2-action-cancel"
            disabled={busy}
            onClick={onClose}
          >
            취소
          </button>
          <div className="kv2-actions-primary">
            <button
              type="button"
              className="kv2-btn kv2-btn--primary"
              disabled={busy || target === null}
              title={target ? undefined : '합칠 Work를 먼저 선택하세요'}
              onClick={run}
            >
              {busy ? '병합 중…' : '병합'}
            </button>
          </div>
        </div>
      </div>
    </DialogSkeleton>
  );
}
