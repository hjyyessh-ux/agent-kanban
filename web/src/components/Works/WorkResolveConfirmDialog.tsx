import { useState } from 'react';
import type { Work } from '../../../../src/core/types';
import { DialogSkeleton } from '../Card/DialogSkeleton';
import { useWorkCompletionPreview } from '../../hooks/useWorkCompletionPreview';
import type { WorkResolveOutcome } from '../../hooks/useWorks';
import {
  describeCompletionByStatus,
  describeKeptFavorites,
  describeWorkCompletion,
  describeWorkCompletionBlock,
  describeWorkDiscard,
  describeWorkReopen,
  workCompletionBlock,
} from './worksAssign';
import './Works.css';

/**
 * `reopen` shares this dialog with the two terminal transitions even though it
 * is the only one that *restores* something. The reason is the same: it moves a
 * pile of cards between the board and the archive, and `window.confirm` cannot
 * say how many.
 */
export type WorkResolveMode = 'complete' | 'discard' | 'reopen';

interface WorkResolveConfirmDialogProps {
  work: Work;
  mode: WorkResolveMode;
  /** Dismiss without sending anything. */
  onCancel: () => void;
  /**
   * Perform the transition. Already carries the confirmation, so this is the
   * only path that may send it — see `useWorks.completeWork`. The dialog closes
   * itself on `'done'` and stays open on `'blocked'` so the reason is readable.
   */
  onConfirm: () => Promise<WorkResolveOutcome>;
  /** Reported to the caller so it can decide whether to close *its* dialog too. */
  onResolved: (outcome: WorkResolveOutcome) => void;
  /**
   * `reopen` only — how many of this Work's cards are in the archive, i.e. how
   * many a reopen would put back on the board.
   *
   * Passed in rather than fetched: the Work detail dialog is the only entry
   * point and it already holds `GET /api/works/:id/sessions`, which counts them
   * over the same monthly reads. `null` means that read has not answered (or
   * failed) — the copy says so instead of printing a number nobody computed,
   * and the action stays available because a restore is not destructive.
   */
  archivedCardCount?: number | null;
}

/**
 * The dialog title deliberately does **not** include the Work title: the Work
 * detail dialog is addressed by its title, and `getByRole('dialog', { name })`
 * matches on a substring, so an embedded title would make one locator resolve to
 * two open dialogs. The Work is named in the body instead.
 */
const MODE_COPY: Record<WorkResolveMode, { title: string; action: string }> = {
  complete: { title: '완료 확인', action: '✔ 완료 (일괄 archive)' },
  discard: { title: '폐기 확인', action: '폐기' },
  reopen: { title: '다시 열기 확인', action: '↺ 다시 열기' },
};

/** The confirm button's variant per mode: only completion is a green primary. */
const MODE_VARIANT: Record<WorkResolveMode, string> = {
  complete: 'kv2-btn--success',
  discard: 'kv2-btn--subtle-danger',
  reopen: 'kv2-btn--primary',
};

/**
 * The confirmation gate in front of both terminal Work transitions.
 *
 * Completing a Work is the single most destructive action in the app — it flips
 * every card of every linked session to `done` and archives them into the wiki
 * pipeline, with no undo — and it used to run off one click of a green primary
 * button with no prompt at all (`works.done_confirm` defaulted to `false`, and
 * even when it was on the prompt was a bare `window.confirm` that could not say
 * how many cards were involved).
 *
 * So the dialog states the scope from `GET /api/works/:id/completion-preview`
 * before offering the action, and **refuses outright** while a card still has a
 * live agent run: archiving that card out from under its runtime makes the
 * completion hook fail with `Card not found` and hands the wiki an unfinished
 * transcript. The server re-checks the same condition (`409`), so this is a
 * readable explanation rather than the only guard.
 *
 * `폐기` shares the dialog because it is terminal and un-undoable too, even
 * though it touches no card — the copy differs, the gate does not.
 */
export function WorkResolveConfirmDialog({
  work,
  mode,
  onCancel,
  onConfirm,
  onResolved,
  archivedCardCount,
}: WorkResolveConfirmDialogProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Only completion archives cards, so only completion needs the scope read.
  const { preview, loading, error: previewError, reload } = useWorkCompletionPreview(
    mode === 'complete' ? work.id : null,
  );

  const block = mode === 'complete' ? workCompletionBlock(preview) : null;
  const blockMessage = mode === 'complete' ? describeWorkCompletionBlock(preview) : '';
  const keptFavorites = mode === 'complete' ? describeKeptFavorites(preview) : '';
  const statusBreakdown = preview ? describeCompletionByStatus(preview) : '';
  const copy = MODE_COPY[mode];

  // Completion stays disabled until the preview has answered: the whole point of
  // the dialog is to not commit before the scope is known.
  const confirmDisabled = busy
    || block !== null
    || (mode === 'complete' && (loading || preview === null));

  const run = () => {
    if (confirmDisabled) return;
    setBusy(true);
    setError(null);
    void onConfirm()
      .then((outcome) => {
        if (outcome === 'done') {
          onResolved(outcome);
          onCancel();
          return;
        }
        // 'blocked' — the server refused while the dialog was open. Refresh the
        // scope so the reason ("실행 중 카드 …") replaces the action.
        if (outcome === 'blocked') void reload();
        setError(outcome === 'blocked'
          ? '서버가 이 요청을 거부했습니다. 아래 상태를 확인하세요.'
          : '확인이 전달되지 않았습니다. 다시 시도해 주세요.');
        onResolved(outcome);
      })
      .catch((e: unknown) => {
        setError(e instanceof Error ? e.message : '요청을 처리하지 못했습니다');
      })
      .finally(() => setBusy(false));
  };

  return (
    <DialogSkeleton title={copy.title} onClose={onCancel} width="560px">
      <div className="work-resolve-confirm">
        <p className="work-resolve-target">{work.title}</p>
        {mode === 'complete' ? (
          <>
            <p className="work-resolve-headline">{describeWorkCompletion(preview)}</p>
            {keptFavorites && <p className="work-resolve-fact">{keptFavorites}</p>}
            <div className="work-resolve-facts">
              <span className="kv2-badge kv2-badge--session">세션 {work.sessionLinks.length}</span>
              {preview && <span className="kv2-badge">카드 {preview.cardCount}</span>}
              {statusBreakdown && <span className="work-resolve-fact">{statusBreakdown}</span>}
            </div>
            {loading && <p className="work-resolve-fact">영향 범위를 확인하는 중…</p>}
            {previewError && (
              <p className="work-date-error">
                ⚠ 영향 범위를 불러오지 못했습니다 ({previewError}) — 확인 없이 진행하지 않습니다.
              </p>
            )}
            {block === 'running' && (
              <div className="work-resolve-block">
                <p>⚠ {blockMessage}</p>
                <ul className="work-resolve-running">
                  {preview!.runningCardIds.map((cardId, index) => (
                    <li key={cardId}>{preview!.runningCardTitles[index] ?? cardId}</li>
                  ))}
                </ul>
              </div>
            )}
            {block === 'already-archived' && (
              <p className="work-resolve-block">⚠ {blockMessage}</p>
            )}
            <p className="work-resolve-fact">
              archive된 카드는 wiki 파이프라인으로 넘어가 문서 생성 대기 상태가 됩니다.
            </p>
          </>
        ) : mode === 'discard' ? (
          <p className="work-resolve-headline">{describeWorkDiscard(work)}</p>
        ) : (
          <>
            <p className="work-resolve-headline">
              {describeWorkReopen(archivedCardCount ?? null)}
            </p>
            <div className="work-resolve-facts">
              <span className="kv2-badge kv2-badge--session">세션 {work.sessionLinks.length}</span>
            </div>
            <p className="work-resolve-fact">
              이미 만들어진 wiki 문서는 지워지지 않습니다. 다시 완료하면 같은 문서를 덮어씁니다.
            </p>
          </>
        )}
        {error && <p className="work-date-error">⚠ {error}</p>}
      </div>
      <div className="kv2-dialog-footer">
        <div className="kv2-actions-split">
          <button
            type="button"
            className="kv2-btn kv2-action-cancel"
            disabled={busy}
            onClick={onCancel}
          >
            취소
          </button>
          <div className="kv2-actions-primary">
            <button
              type="button"
              className={`kv2-btn ${MODE_VARIANT[mode]}`}
              disabled={confirmDisabled}
              title={blockMessage || undefined}
              onClick={run}
            >
              {copy.action}
            </button>
          </div>
        </div>
      </div>
    </DialogSkeleton>
  );
}
