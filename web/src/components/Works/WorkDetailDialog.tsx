import { useEffect, useMemo, useState } from 'react';
import type { KanbanCard, Work, WorkSessionLink } from '../../../../src/core/types';
import { DialogSkeleton } from '../Card/DialogSkeleton';
import {
  ROLE_LABELS,
  daysSince,
  formatShortDate,
  projectDirLabel,
  shortSessionId,
} from './worksAssign';
import { endFromDateInputValue, fromDateInputValue, toDateInputValue } from './timelineModel';
import './Works.css';

interface WorkDetailDialogProps {
  work: Work;
  /** Board cards — used to derive each session's title, card counts, and last activity. */
  cards: KanbanCard[];
  onClose: () => void;
  /** PATCH status:'done' only. Server-side bulk archive/wiki side-effects land in card 5. */
  onComplete: (workId: string) => Promise<void>;
  /** PATCH status:'discarded' only. Same status-only contract as onComplete. */
  onDiscard: (workId: string) => Promise<void>;
  /** Open a linked session's conversation (reuses SessionConversationModal via App). */
  onOpenSession: (sessionId: string) => void;
  /**
   * PATCH `startedAt` / `resolvedAt`. The same edit the Timeline performs by
   * dragging a bar's edge — omit to render the dates read-only.
   */
  onUpdateDates?: (
    workId: string,
    patch: { startedAt?: string; resolvedAt?: string | null },
  ) => Promise<void>;
  /** Generate/regenerate the Summary via the works.summary_model LLM. Resolves
   * when the Work has been updated; rejects with an error to display inline. */
  onRegenerateSummary?: (workId: string) => Promise<void>;
  /** "＋ 세션 연결" — wired later (disabled placeholder for now). */
  onAddSession?: (workId: string) => void;
}

const STATUS_LABELS: Record<Work['status'], string> = {
  active: 'ACTIVE',
  done: '완료',
  discarded: '폐기',
};

const DATETIME_FMT = new Intl.DateTimeFormat('ko-KR', {
  timeZone: 'Asia/Seoul',
  month: 'numeric',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});

function formatDateTime(iso: string | undefined): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return DATETIME_FMT.format(date);
}

/** Oldest card's title for a session (its first prompt), falling back to the short id. */
function sessionTitleOf(sessionId: string, cards: KanbanCard[]): string {
  const owned = cards.filter((card) => card.sessionId === sessionId);
  if (owned.length === 0) return shortSessionId(sessionId);
  const oldest = [...owned].sort(
    (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
  )[0];
  return oldest.title?.trim() || oldest.sessionTitle?.trim() || shortSessionId(sessionId);
}

/**
 * Work detail (mockup screen ③, DialogSkeleton). Self-contained given a `work` +
 * the board `cards`, so both WorksView [상세] and the Timeline (card 6/7) can
 * reuse it. Complete/discard call the PATCH-status contract only — the bulk
 * archive + wiki pipeline is layered onto the same endpoint by card 5, so this
 * UI needs no rework when that lands.
 */
export function WorkDetailDialog({
  work,
  cards,
  onClose,
  onComplete,
  onDiscard,
  onOpenSession,
  onUpdateDates,
  onRegenerateSummary,
  onAddSession,
}: WorkDetailDialogProps) {
  const [busy, setBusy] = useState(false);
  const [summaryBusy, setSummaryBusy] = useState(false);
  const [summaryError, setSummaryError] = useState<string | null>(null);

  const links = work.sessionLinks;
  const sessionIds = useMemo(
    () => new Set(links.map((link) => link.sessionId)),
    [links],
  );

  // Cards belonging to this Work's sessions drive the artifact + activity panels.
  const workCards = useMemo(
    () => cards.filter((card) => card.sessionId && sessionIds.has(card.sessionId)),
    [cards, sessionIds],
  );
  const doneCount = workCards.filter((c) => c.status === 'done' || c.status === 'complete').length;
  const inProgressCount = workCards.filter((c) => c.status === 'todo' || c.status === 'in_progress').length;
  const lastActivity = useMemo(() => {
    const times = workCards.map((c) => c.updatedAt).filter(Boolean);
    times.push(work.updatedAt);
    return times.sort().at(-1);
  }, [workCards, work.updatedAt]);

  const ageDays = daysSince(work.startedAt) + 1;
  const cardCountFor = (sessionId: string) =>
    workCards.filter((c) => c.sessionId === sessionId).length;

  const runAction = (action: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    // Errors are already surfaced via the Works error alert; swallow here so a
    // failed PATCH keeps the dialog open (no close) instead of raising unhandled.
    void action()
      .catch(() => {})
      .finally(() => setBusy(false));
  };

  // Date inputs are locally controlled so a half-typed value is not fought by
  // the 10s Works poll; each committed change re-syncs from the server's Work.
  const [startInput, setStartInput] = useState(() => toDateInputValue(work.startedAt));
  const [endInput, setEndInput] = useState(() => toDateInputValue(work.resolvedAt));
  const [dateBusy, setDateBusy] = useState(false);
  const [dateError, setDateError] = useState<string | null>(null);
  useEffect(() => setStartInput(toDateInputValue(work.startedAt)), [work.startedAt]);
  useEffect(() => setEndInput(toDateInputValue(work.resolvedAt)), [work.resolvedAt]);

  const isOpenWork = work.status === 'active';

  const saveDates = (patch: { startedAt?: string; resolvedAt?: string | null }) => {
    if (!onUpdateDates) return;
    setDateError(null);
    setDateBusy(true);
    void onUpdateDates(work.id, patch)
      .catch((e: unknown) => setDateError(e instanceof Error ? e.message : '날짜를 저장하지 못했습니다'))
      .finally(() => setDateBusy(false));
  };

  const commitDate = (field: 'startedAt' | 'resolvedAt', value: string) => {
    if (field === 'startedAt') setStartInput(value);
    else setEndInput(value);
    if (!onUpdateDates || dateBusy) return;
    if (!value) {
      // Emptying an open Work's end drops the planned date, putting its bar back
      // on today. Everywhere else an empty value is a mid-edit state, not a clear.
      if (field === 'resolvedAt' && isOpenWork && work.resolvedAt) saveDates({ resolvedAt: null });
      return;
    }
    // A start keeps its real clock time; an end lands at end-of-day so a
    // same-day span is never an inverted instant (see `endIsoForColumn`).
    const iso = field === 'startedAt'
      ? fromDateInputValue(value, work.startedAt)
      : endFromDateInputValue(value);
    if (!iso) return; // partial input while typing
    const nextStart = field === 'startedAt' ? iso : work.startedAt;
    const nextEnd = field === 'resolvedAt' ? iso : work.resolvedAt;
    if (nextEnd && Date.parse(nextEnd) < Date.parse(nextStart)) {
      setDateError(`${isOpenWork ? '종료 예정일' : '종료일'}은 시작일보다 빠를 수 없습니다.`);
      return;
    }
    saveDates(field === 'startedAt' ? { startedAt: iso } : { resolvedAt: iso });
  };

  const datesDisabled = !onUpdateDates || dateBusy || busy;
  const endLabel = isOpenWork ? '종료 예정' : '종료';
  const dateHint = !isOpenWork
    ? ''
    : work.resolvedAt
      ? '완료 처리하면 이 날짜가 종료일로 기록됩니다.'
      : '비워두면 타임라인 바가 오늘까지 이어집니다.';

  const runSummary = () => {
    if (!onRegenerateSummary || summaryBusy) return;
    setSummaryBusy(true);
    setSummaryError(null);
    void onRegenerateSummary(work.id)
      .catch((e: unknown) => setSummaryError(e instanceof Error ? e.message : '요약 생성에 실패했습니다'))
      .finally(() => setSummaryBusy(false));
  };
  const summaryDisabled = !onRegenerateSummary || summaryBusy || busy;

  return (
    <DialogSkeleton
      title={work.title}
      onClose={onClose}
      width="920px"
      persistSizeKey="work-detail"
      defaultSize={{ width: 920, height: 760 }}
      className="work-detail-dialog"
    >
      <div className="work-detail">
        <div className="work-detail-status">
          <span className={`kv2-badge work-status work-status--${work.status}`}>
            {STATUS_LABELS[work.status]} · {ageDays}일째
          </span>
        </div>

        {/* Summary hero — full-width, right under the title (mockup ③). */}
        <section className="work-summary-hero">
          {work.summary ? (
            <>
              <div className="work-summary-head">
                📝 Summary
                <span className="kv2-badge work-summary-model">{work.summary.model}</span>
              </div>
              <ul className="work-summary-lines">
                {work.summary.lines.map((line, i) => (
                  <li key={i}>{line}</li>
                ))}
              </ul>
              <div className="work-summary-meta">
                <span>{formatDateTime(work.summary.generatedAt)} 생성</span>
                <button
                  type="button"
                  className="kv2-btn kv2-btn--small work-summary-regen"
                  disabled={summaryDisabled}
                  title={onRegenerateSummary ? undefined : '요약 생성은 준비 중입니다'}
                  onClick={runSummary}
                >
                  {summaryBusy ? '생성 중…' : '↻ 다시 생성'}
                </button>
              </div>
            </>
          ) : (
            <div className="work-summary-empty">
              <p className="work-summary-empty-text">
                아직 요약이 없습니다. 연결된 세션 transcript를 종합해 3~5줄 요약을 생성합니다.
              </p>
              <button
                type="button"
                className="kv2-btn kv2-btn--small kv2-btn--primary"
                disabled={summaryDisabled}
                title={onRegenerateSummary ? undefined : '요약 생성은 준비 중입니다'}
                onClick={runSummary}
              >
                {summaryBusy ? '생성 중…' : '📝 요약 생성'}
              </button>
            </div>
          )}
          {summaryError && <p className="work-summary-error">⚠ {summaryError}</p>}
        </section>

        {/* 기간 — the dialog-side twin of the Timeline's bar-edge drag. Both
            write day-level dates and preserve the original time-of-day. */}
        <section className="work-detail-row">
          <div className="work-detail-panel-title">기간</div>
          <div className="work-detail-row-body">
            <label className="work-date-field">
              <span className="work-date-label">시작</span>
              <input
                type="date"
                className="kv2-input work-date-input"
                value={startInput}
                max={endInput || undefined}
                disabled={datesDisabled}
                onChange={(e) => commitDate('startedAt', e.target.value)}
              />
            </label>
            <span className="work-date-arrow" aria-hidden="true">→</span>
            <label className="work-date-field">
              <span className="work-date-label">{endLabel}</span>
              <input
                type="date"
                className="kv2-input work-date-input"
                value={endInput}
                min={startInput || undefined}
                disabled={datesDisabled}
                onChange={(e) => commitDate('resolvedAt', e.target.value)}
              />
            </label>
            {isOpenWork && endInput && (
              <button
                type="button"
                className="kv2-btn kv2-btn--small kv2-btn--ghost"
                disabled={datesDisabled}
                onClick={() => commitDate('resolvedAt', '')}
              >
                예정일 지우기
              </button>
            )}
            <div className="work-detail-facts">
              <span>
                {ageDays}일째
                {isOpenWork
                  ? ' active'
                  : work.resolvedAt
                    ? ` · ${formatShortDate(work.resolvedAt)} ${STATUS_LABELS[work.status]}`
                    : ''}
              </span>
              <span>마지막 활동 {formatDateTime(lastActivity) || '-'}</span>
            </div>
          </div>
          {dateError && <p className="work-date-error">⚠ {dateError}</p>}
          {dateHint && !dateError && <p className="work-date-hint">{dateHint}</p>}
        </section>

        <section className="work-detail-row">
          <div className="work-detail-panel-title">산출물</div>
          <div className="work-detail-row-body">
            <span className="kv2-badge">카드 {workCards.length}</span>
            <span className="kv2-badge">done {doneCount}</span>
            <span className="kv2-badge">in_progress {inProgressCount}</span>
            <span className="work-detail-fact">wiki 문서: 아직 없음</span>
          </div>
        </section>

        <section className="work-detail-sessions">
          <div className="work-detail-panel-title">연결된 세션 {links.length}</div>
          {links.length === 0 ? (
            <p className="works-empty">연결된 세션이 없습니다.</p>
          ) : (
            [...links]
              .sort((a, b) => new Date(a.linkedAt).getTime() - new Date(b.linkedAt).getTime())
              .map((link: WorkSessionLink) => (
                <div className="work-session-item" key={link.sessionId}>
                  {link.role && (
                    <span className={`kv2-badge works-role works-role--${link.role}`}>
                      {ROLE_LABELS[link.role]}
                    </span>
                  )}
                  <div className="work-session-body">
                    <div className="work-session-title">
                      {sessionTitleOf(link.sessionId, cards)}
                    </div>
                    <div className="work-session-meta">
                      {formatShortDate(link.linkedAt)}
                      {link.projectDir ? ` · ${projectDirLabel(link.projectDir)}` : ''}
                      {` · 카드 ${cardCountFor(link.sessionId)}`}
                      {` · `}
                      <span className="works-mono">{shortSessionId(link.sessionId)}</span>
                    </div>
                  </div>
                  <button
                    type="button"
                    className="kv2-btn kv2-btn--small kv2-btn--ghost"
                    onClick={() => onOpenSession(link.sessionId)}
                  >
                    대화
                  </button>
                </div>
              ))
          )}
          <button
            type="button"
            className="kv2-btn kv2-btn--small work-session-add"
            disabled={!onAddSession}
            title={onAddSession ? undefined : '세션 연결은 준비 중입니다'}
            onClick={onAddSession ? () => onAddSession(work.id) : undefined}
          >
            ＋ 세션 연결
          </button>
        </section>

        <div className="work-detail-note">
          ✅ <b>완료</b> 시: 산하 카드를 일괄 done 처리 후 archive → wiki 파이프라인이 연결된 세션 transcript를 종합해 문서를 생성합니다.
        </div>

        <div className="kv2-dialog-footer">
          <div className="kv2-actions-split">
            <button
              type="button"
              className="kv2-btn kv2-btn--danger kv2-action-cancel"
              disabled={busy || work.status === 'discarded'}
              onClick={() => runAction(() => onDiscard(work.id).then(() => { onClose(); }))}
            >
              폐기…
            </button>
            <div className="kv2-actions-primary">
              <button
                type="button"
                className="kv2-btn kv2-btn--outline"
                disabled
                title="Wiki 정리는 준비 중입니다"
              >
                📚 Wiki 정리
              </button>
              <button
                type="button"
                className="kv2-btn kv2-btn--success"
                disabled={busy || work.status !== 'active'}
                onClick={() => runAction(() => onComplete(work.id).then(() => { onClose(); }))}
              >
                ✔ 완료 (일괄 archive)
              </button>
            </div>
          </div>
        </div>
      </div>
    </DialogSkeleton>
  );
}
