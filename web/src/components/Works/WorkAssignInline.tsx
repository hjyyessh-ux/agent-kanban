import { useId, useMemo, useState, type ReactNode } from 'react';
import type { Work, WorkInboxSession, WorkSessionRole } from '../../../../src/core/types';
import {
  ROLE_LABELS,
  ROLE_OPTIONS,
  recommendWorksForSession,
  suggestWorkTitle,
  daysSince,
} from './worksAssign';
import { dirAccentClass } from './worksAffinity';
import { DirChip, WorkAffinityMarks } from './WorkAffinityMarks';

/** What the panel would do if it were submitted right now. */
export interface AssignSelection {
  mode: AssignMode;
  /** Target Work id — only set in `existing` mode. */
  workId: string | null;
  role: WorkSessionRole;
}

/**
 * Move mode: the same panel, aimed at a session that already belongs to a Work.
 * Exactly three things change — a "현재:" line, the current Work dropping out of
 * the recommendations, and an impact preview above the footer.
 */
export interface AssignMoveMode {
  currentWork: Work;
  /** Impact preview above the footer, recomputed for each selection. */
  renderPreview: (selection: AssignSelection) => ReactNode;
}

/**
 * Bulk mode: one target for a whole Inbox selection. Nothing about *where* the
 * sessions go changes — only the copy — so the ranking, the title suggestion and
 * the submit flow stay the single implementation shared with single assignment
 * and the move dialog. The representative session comes from
 * `mergeSessionsForAssign`.
 */
export interface AssignBulkMode {
  /** How many sessions the submit applies to (>= 2 in practice). */
  count: number;
}

interface WorkAssignInlineProps {
  session: WorkInboxSession;
  works: Work[];
  onCancel: () => void;
  onCreateWork: (title: string, role?: WorkSessionRole) => Promise<void>;
  onLinkToWork: (workId: string, role?: WorkSessionRole) => Promise<void>;
  /**
   * Left footer action — Inbox: "이 세션 무시", move: "⤺ Inbox로 되돌리기".
   *
   * `tone` decides the variant, not the position: both live in the footer's
   * left `kv2-actions-danger` zone (the same place the assign-all modal keeps
   * 폐기), but only the Inbox one is destructive. Putting 무시 on the right next
   * to the primary 연결 — which is where it used to sit — made the two Inbox
   * surfaces disagree about where the irreversible action is, and the row's own
   * 폐기 button disagreed with both.
   */
  secondary: { label: string; run: () => Promise<void>; tone?: 'danger' | 'neutral' };
  /** Present only in the move dialog; absent means plain Inbox assignment. */
  move?: AssignMoveMode;
  /** Present only for a multi-session Inbox selection; changes copy only. */
  bulk?: AssignBulkMode;
  /**
   * Works holding a session this one continues (`chainedWorkIds`). They rank
   * first and are marked 🔗. Omit where the lineage is unknown (the move dialog
   * rebuilds its session from links, which carry none) — the ranking then falls
   * back to same-directory-first.
   */
  chained?: ReadonlySet<string>;
  /**
   * `works.assign_prefer_same_dir`. `false` stops same-directory Works from
   * being pulled to the top; the 같은 디렉토리 mark still shows. Defaults to the
   * documented `true` so a panel rendered before the config lands ranks the way
   * the setting's default says it should.
   */
  preferSameDir?: boolean;
  /** Pre-selected role — the link's existing role when moving. */
  initialRole?: WorkSessionRole;
}

type AssignMode = 'new' | 'existing';

/**
 * Submit button copy for all three uses of the panel. Bulk mode says the count
 * outright ("3개 연결") because the panel body only shows the representative
 * session, and the button is the last chance to notice the batch is bigger than
 * the row that started it.
 */
function submitLabel({
  mode,
  title,
  selectedWork,
  move,
  bulk,
}: {
  mode: AssignMode;
  title: string;
  selectedWork: Work | undefined;
  move?: AssignMoveMode;
  bulk?: AssignBulkMode;
}): string {
  if (mode === 'new') {
    if (bulk) return `"${title}" 만들고 ${bulk.count}개 연결`;
    return `"${title}" ${move ? '만들어 옮기기' : '만들기'}`;
  }
  if (!selectedWork) return move ? '이동' : '연결';
  if (bulk) return `"${selectedWork.title}"에 ${bulk.count}개 연결`;
  return `"${selectedWork.title}"${move ? '(으)로 이동' : '에 연결'}`;
}

/**
 * "이 세션을 어디에 붙일까" panel, used two ways: inline under an Inbox row
 * (pick "새 Work 만들기" with the title pre-seeded from the first prompt, or
 * "기존 Work에 연결") and inside MoveSessionDialog for a session that already
 * belongs to a Work. Both paths share the ranking + title helpers in
 * worksAssign.ts and this one submit flow, so an assignment and a move can never
 * disagree about which Works are recommended or what a role selection means.
 */
export function WorkAssignInline({
  session,
  works,
  onCancel,
  onCreateWork,
  onLinkToWork,
  secondary,
  move,
  bulk,
  chained,
  preferSameDir = true,
  initialRole,
}: WorkAssignInlineProps) {
  const recommendations = useMemo(
    () => recommendWorksForSession(session, works, move?.currentWork.id, chained, {
      preferSameDir,
    }),
    [session, works, move?.currentWork.id, chained, preferSameDir],
  );
  const suggestedTitle = useMemo(() => suggestWorkTitle(session), [session]);

  const [mode, setMode] = useState<AssignMode>(
    recommendations.length > 0 ? 'existing' : 'new',
  );
  const [title, setTitle] = useState(suggestedTitle);
  const [selectedWorkId, setSelectedWorkId] = useState<string>(
    recommendations[0]?.work.id ?? '',
  );
  const [role, setRole] = useState<WorkSessionRole>(initialRole ?? 'dev');
  const [busy, setBusy] = useState(false);
  // Generated, not hardcoded: this panel renders in three places at once —
  // under an Inbox row, as the bulk panel, and inside MoveSessionDialog — and
  // the fixed `works-new-title` / `works-new-role` ids collided the moment two
  // of them were open, pointing a <label> at the wrong control.
  const fieldId = useId();
  const titleId = `${fieldId}-title`;
  const roleId = `${fieldId}-role`;

  const selectedWork = recommendations.find((r) => r.work.id === selectedWorkId)?.work;
  // `selectedWork`, not `selectedWorkId`: the recommendation list is rebuilt
  // from a 10s poll, so the Work behind a held id can complete and drop out
  // while this panel is open. Trusting the bare id let 연결 stay enabled and
  // POST a session onto a finished Work (the server now answers 409, and this
  // keeps the button from offering it in the first place).
  const canSubmit = mode === 'new' ? title.trim().length > 0 : Boolean(selectedWork);

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
    } else if (selectedWork) {
      void runAction(() => onLinkToWork(selectedWork.id, role));
    }
  };

  const preview = move?.renderPreview({
    mode,
    workId: mode === 'existing' ? selectedWorkId || null : null,
    role,
  });

  return (
    <div className="works-assign-inline">
      {move ? (
        <>
          <div className="works-assign-current">
            현재:
            <span className="works-assign-current-dot" aria-hidden="true" />
            <b>{move.currentWork.title}</b>
          </div>
          <div className="works-assign-lead">이 세션을 어디로 옮길까요?</div>
        </>
      ) : (
        <div className="works-assign-lead">
          {bulk ? `선택한 세션 ${bulk.count}개를 어디에 연결할까요?` : '이 세션을 어디에 연결할까요?'}
          <DirChip projectDir={session.projectDir} />
        </div>
      )}

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
          <span className="works-assign-opt-title">
            {move ? '↳ 다른 Work에 연결' : '↳ 기존 Work에 연결'}
          </span>
          <span className="works-assign-opt-desc">
            {recommendations.length === 0
              ? '연결할 수 있는 진행 중 Work가 없습니다'
              : preferSameDir
                ? '같은 폴더에서 나온 Work를 먼저 보여줍니다'
                : '최근에 움직인 Work부터 보여줍니다'}
          </span>
        </button>
      </div>

      {mode === 'new' ? (
        <div className="works-assign-new">
          <label className="kv2-label" htmlFor={titleId}>새 Work 제목</label>
          <input
            id={titleId}
            className="kv2-input"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="Work 제목"
          />
          <div className="works-assign-role">
            <label className="kv2-label" htmlFor={roleId}>
              {bulk ? `세션 ${bulk.count}개 역할` : '이 세션 역할'}
            </label>
            <select
              id={roleId}
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
          {/* A group of aria-pressed toggles, not a listbox: its children are
              <button>s (so they are tabbable and Enter/Space activate them
              natively), and a listbox may only contain `option` children — a
              `role="option"` button gets neither behaviour. Same vocabulary as
              the assign-all modal's option list and `works-assign-option`
              above. */}
          <div className="works-assign-work-list" role="group" aria-label="연결할 Work">
            {recommendations.map(({ work, sameDirectory, chained: isChained }) => {
              const selected = work.id === selectedWorkId;
              return (
                <button
                  type="button"
                  key={work.id}
                  aria-pressed={selected}
                  className={`works-assign-work-item ${dirAccentClass(work.projectDir)}${selected ? ' is-selected' : ''}${isChained ? ' is-chained' : ''}`}
                  onClick={() => setSelectedWorkId(work.id)}
                >
                  <span className="works-assign-work-bar" />
                  <span className="works-assign-work-title">{work.title}</span>
                  <span className="works-assign-work-ago">
                    <WorkAffinityMarks
                      projectDir={work.projectDir}
                      sameDirectory={sameDirectory}
                      chained={isChained}
                      extra={`${daysSince(work.startedAt) + 1}일째`}
                    />
                  </span>
                </button>
              );
            })}
          </div>
          {selectedWork && (
            <div className="works-assign-role">
              <label className="kv2-label" htmlFor={roleId}>
                {bulk ? `세션 ${bulk.count}개 역할` : '이 세션 역할'}
              </label>
              <select
                id={roleId}
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

      {preview}

      {/* kv2-actions-split. `secondary` (무시 / Inbox로 되돌리기) takes the left
          edge in the danger zone, exactly where the assign-all modal keeps
          `X 폐기`, with 취소 beside it — the three assign surfaces now agree on
          where the irreversible action lives. Both left buttons share one
          `kv2-actions-danger` group on purpose: a lone button between
          `kv2-action-cancel`'s and `kv2-actions-primary`'s `auto` margins
          floats in mid-footer (see docs/design-system.md). */}
      <div className="works-assign-footer kv2-actions-split">
        <div className="kv2-actions-danger">
          <button
            type="button"
            className={`kv2-btn kv2-btn--small ${
              secondary.tone === 'neutral' ? 'kv2-btn--outline' : 'kv2-btn--subtle-danger'
            }`}
            disabled={busy}
            onClick={() => void runAction(secondary.run)}
          >
            {secondary.label}
          </button>
          <button
            type="button"
            className="kv2-btn kv2-btn--small kv2-btn--ghost"
            disabled={busy}
            onClick={onCancel}
          >
            취소
          </button>
        </div>
        <div className="kv2-actions-primary">
          <button
            type="button"
            className="kv2-btn kv2-btn--small kv2-btn--primary"
            disabled={!canSubmit || busy}
            onClick={handleSubmit}
          >
            {submitLabel({ mode, title: title.trim() || suggestedTitle, selectedWork, move, bulk })}
          </button>
        </div>
      </div>
    </div>
  );
}
