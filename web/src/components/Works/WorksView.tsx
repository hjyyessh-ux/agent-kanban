import { useState } from 'react';
import type {
  Work,
  WorkInboxSession,
  WorkSessionRole,
  WorksConfigDto,
  WorksConfigInput,
} from '../../../../src/core/types';
import { ErrorAlert } from '../shared/ErrorAlert';
import type { UiAlert } from '../../hooks/uiAlert';
import { WorkAssignInline } from './WorkAssignInline';
import { WorksConfigPanel } from './WorksConfigPanel';
import {
  STALE_WORK_DAYS,
  OLD_SESSION_DAYS,
  RESOLVED_WINDOW_DAYS,
  daysSince,
  formatShortDate,
  formatTimeAgo,
  projectDirLabel,
  shortSessionId,
  summarizeRoles,
} from './worksAssign';
import './Works.css';

export interface WorksViewProps {
  works: Work[];
  inbox: WorkInboxSession[];
  loading: boolean;
  error: UiAlert | null;
  onCreateWorkFromSession: (
    session: WorkInboxSession,
    title: string,
    role?: WorkSessionRole,
  ) => Promise<Work>;
  onLinkSessionToWork: (
    workId: string,
    session: WorkInboxSession,
    role?: WorkSessionRole,
  ) => Promise<Work>;
  onIgnoreSession: (sessionId: string) => Promise<void>;
  onCompleteWork: (workId: string) => Promise<void>;
  onRefresh: () => Promise<void>;
  onClearError: () => void;
  /** Open the source card's conversation ("대화 보기"). */
  onOpenCard?: (cardId: string) => void;
  /** Open the Work detail dialog (card 3/7 — undefined disables the button). */
  onOpenWork?: (work: Work) => void;
  /** Open the assign-all modal (card 3/7 — undefined disables the button). */
  onAssignAll?: () => void;
  /** Works settings for the ⚙ panel + stale threshold (null hides the gear). */
  config?: WorksConfigDto | null;
  /** Persist a works settings update (from the ⚙ panel). */
  onSaveConfig?: (input: WorksConfigInput) => Promise<void>;
}

function isRecentlyResolved(work: Work): boolean {
  if (work.status === 'active') return false;
  if (!work.resolvedAt) return true; // resolved but undated → keep visible
  return daysSince(work.resolvedAt) <= RESOLVED_WINDOW_DAYS;
}

/** One Inbox row + its inline assignment panel when expanded. */
function InboxRow({
  session,
  works,
  expanded,
  onToggle,
  onCreateWorkFromSession,
  onLinkSessionToWork,
  onIgnoreSession,
  onOpenCard,
}: {
  session: WorkInboxSession;
  works: Work[];
  expanded: boolean;
  onToggle: () => void;
  onCreateWorkFromSession: WorksViewProps['onCreateWorkFromSession'];
  onLinkSessionToWork: WorksViewProps['onLinkSessionToWork'];
  onIgnoreSession: WorksViewProps['onIgnoreSession'];
  onOpenCard?: (cardId: string) => void;
}) {
  const isOld = daysSince(session.updatedAt) >= OLD_SESSION_DAYS;
  const title = session.sessionTitle?.trim() || session.cardTitle;

  return (
    <div className="works-inbox-row-group">
      <div className="works-inbox-row">
        <span className={`works-inbox-dot${isOld ? ' works-inbox-dot--idle' : ''}`} />
        <div className="works-inbox-body">
          <div className="works-inbox-title">{title}</div>
          <div className="works-inbox-meta">
            <span className="kv2-badge works-runtime-chip">{session.agentRuntime}</span>
            {session.projectDir && <span>📁 {projectDirLabel(session.projectDir)}</span>}
            <span className="works-mono">{shortSessionId(session.sessionId)}</span>
            <span>
              카드 {session.relatedCardCount} · {formatTimeAgo(session.updatedAt)}
              {isOld && <b className="works-warn"> ⚠ 오래됨</b>}
            </span>
          </div>
        </div>
        <div className="works-inbox-actions">
          <button
            type="button"
            className={`kv2-btn kv2-btn--small${expanded ? '' : ' kv2-btn--primary'}`}
            aria-expanded={expanded}
            onClick={onToggle}
          >
            {expanded ? '접기 ▲' : '배정'}
          </button>
          {onOpenCard && (
            <button
              type="button"
              className="kv2-btn kv2-btn--small kv2-btn--ghost"
              onClick={() => onOpenCard(session.cardId)}
            >
              대화 보기
            </button>
          )}
          {!expanded && (
            <button
              type="button"
              className="kv2-btn kv2-btn--small kv2-btn--subtle-danger"
              onClick={() => void onIgnoreSession(session.sessionId)}
            >
              폐기
            </button>
          )}
        </div>
      </div>
      {expanded && (
        <WorkAssignInline
          session={session}
          works={works}
          onCancel={onToggle}
          onCreateWork={async (title, role) => {
            await onCreateWorkFromSession(session, title, role);
          }}
          onLinkToWork={async (workId, role) => {
            await onLinkSessionToWork(workId, session, role);
          }}
          onIgnore={async () => {
            await onIgnoreSession(session.sessionId);
          }}
        />
      )}
    </div>
  );
}

/** One Work card in the Active or Resolved list. */
function WorkListCard({
  work,
  onCompleteWork,
  onOpenWork,
  staleDays,
}: {
  work: Work;
  onCompleteWork: WorksViewProps['onCompleteWork'];
  onOpenWork?: (work: Work) => void;
  staleDays: number;
}) {
  const resolved = work.status !== 'active';
  const sessionCount = work.sessionLinks.length;
  const roleSummary = summarizeRoles(work);
  const stale = !resolved && daysSince(work.startedAt) >= staleDays;
  const summaryLines = work.summary?.lines ?? [];

  return (
    <div className={`works-card works-card--${work.status}${resolved ? ' works-card--resolved' : ''}`}>
      <div className="works-card-body">
        <div className="works-card-title">{work.title}</div>
        <div className="works-card-meta">
          {work.projectDir && <span>📁 {projectDirLabel(work.projectDir)}</span>}
          <span>
            세션 {sessionCount}
            {roleSummary && ` (${roleSummary})`}
          </span>
          <span>
            {resolved && work.resolvedAt
              ? `${formatShortDate(work.startedAt)} → ${formatShortDate(work.resolvedAt)} ${work.status === 'discarded' ? '폐기' : '완료'}`
              : `시작 ${formatShortDate(work.startedAt)}`}
          </span>
          {stale && <span className="works-warn">⚠ {daysSince(work.startedAt)}일째 미완료</span>}
        </div>
        {resolved && summaryLines.length > 0 && (
          <div className="works-card-summary">{summaryLines.join(' ')}</div>
        )}
      </div>
      <div className="works-card-side">
        <span className="kv2-badge kv2-badge--session works-session-badge">세션 {sessionCount}</span>
        {!resolved && (
          <button
            type="button"
            className="kv2-btn kv2-btn--small kv2-btn--success"
            onClick={() => void onCompleteWork(work.id)}
          >
            완료
          </button>
        )}
        <button
          type="button"
          className="kv2-btn kv2-btn--small kv2-btn--outline"
          disabled={!onOpenWork}
          onClick={onOpenWork ? () => onOpenWork(work) : undefined}
        >
          상세
        </button>
      </div>
    </div>
  );
}

/**
 * Works tab — screen ① of the mockup. Inbox (unassigned sessions with inline
 * assignment) → Active Works → Resolved (last 7 days). The tab badge, the
 * assign-all modal, and the Work detail dialog are wired from App; the modal and
 * detail buttons stay disabled until card 3/7 supplies handlers.
 */
export function WorksView({
  works,
  inbox,
  loading,
  error,
  onCreateWorkFromSession,
  onLinkSessionToWork,
  onIgnoreSession,
  onCompleteWork,
  onRefresh,
  onClearError,
  onOpenCard,
  onOpenWork,
  onAssignAll,
  config,
  onSaveConfig,
}: WorksViewProps) {
  const [expandedSessionId, setExpandedSessionId] = useState<string | null>(null);
  const [showConfig, setShowConfig] = useState(false);

  const activeWorks = works.filter((work) => work.status === 'active');
  const resolvedWorks = works.filter(isRecentlyResolved);
  const staleDays = config?.staleDays ?? STALE_WORK_DAYS;
  const canConfig = !!config && !!onSaveConfig;

  return (
    <div className="works-view">
      <div className="works-view-header">
        <span className="works-view-title">Works</span>
        {canConfig && (
          <button
            type="button"
            className={`kv2-btn kv2-btn--small kv2-btn--ghost works-config-gear${showConfig ? ' works-config-gear--on' : ''}`}
            aria-label="Works 설정"
            aria-expanded={showConfig}
            onClick={() => setShowConfig((v) => !v)}
          >
            ⚙ 설정
          </button>
        )}
      </div>

      {showConfig && config && onSaveConfig && (
        <WorksConfigPanel config={config} busy={loading} onSave={onSaveConfig} />
      )}

      {error && (
        <ErrorAlert
          className="error-banner"
          title={error.title}
          message={error.message}
          actionLabel={error.actionLabel}
          onAction={() => {
            void onRefresh();
          }}
          onDismiss={onClearError}
        />
      )}

      {loading && works.length === 0 && inbox.length === 0 ? (
        <div className="loading-spinner" role="status" aria-label="Loading works..." />
      ) : (
        <>
          {inbox.length > 0 && (
            <section className="works-section">
              <div className="works-section-heading">
                <span>📥 Inbox — 미배정 세션</span>
                <span className="works-section-hint">모든 세션은 하나의 Work에 소속되어야 합니다</span>
                <span className="works-section-rule" />
              </div>
              <div className="works-inbox">
                <div className="works-inbox-header">
                  <span>미배정 세션 {inbox.length}개</span>
                  <span className="works-inbox-header-sub">· 오래된 것부터</span>
                  <button
                    type="button"
                    className="kv2-btn kv2-btn--small kv2-btn--primary works-inbox-assign-all"
                    disabled={!onAssignAll}
                    onClick={onAssignAll}
                    title={onAssignAll ? undefined : '일괄 배정 모달은 준비 중입니다'}
                  >
                    ⚡ 모두 배정하기
                  </button>
                </div>
                {inbox.map((session) => (
                  <InboxRow
                    key={session.sessionId}
                    session={session}
                    works={works}
                    expanded={expandedSessionId === session.sessionId}
                    onToggle={() =>
                      setExpandedSessionId((current) =>
                        current === session.sessionId ? null : session.sessionId,
                      )
                    }
                    onCreateWorkFromSession={onCreateWorkFromSession}
                    onLinkSessionToWork={onLinkSessionToWork}
                    onIgnoreSession={onIgnoreSession}
                    onOpenCard={onOpenCard}
                  />
                ))}
              </div>
            </section>
          )}

          <section className="works-section">
            <div className="works-section-heading">
              <span>🔵 Active Works</span>
              <span className="works-section-rule" />
            </div>
            {activeWorks.length === 0 ? (
              <p className="works-empty">진행 중인 Work가 없습니다. Inbox에서 세션을 배정해 시작하세요.</p>
            ) : (
              <div className="works-list">
                {activeWorks.map((work) => (
                  <WorkListCard
                    key={work.id}
                    work={work}
                    onCompleteWork={onCompleteWork}
                    onOpenWork={onOpenWork}
                    staleDays={staleDays}
                  />
                ))}
              </div>
            )}
          </section>

          {resolvedWorks.length > 0 && (
            <section className="works-section">
              <div className="works-section-heading">
                <span>✅ Resolved</span>
                <span className="works-section-hint">최근 {RESOLVED_WINDOW_DAYS}일</span>
                <span className="works-section-rule" />
              </div>
              <div className="works-list">
                {resolvedWorks.map((work) => (
                  <WorkListCard
                    key={work.id}
                    work={work}
                    onCompleteWork={onCompleteWork}
                    onOpenWork={onOpenWork}
                    staleDays={staleDays}
                  />
                ))}
              </div>
            </section>
          )}
        </>
      )}
    </div>
  );
}
