import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { KanbanCard } from '../../../../src/core/types';
import { DialogSkeleton } from '../Card/DialogSkeleton';
import { FeedbackPanel } from '../Card/FeedbackPanel';
import { CardMarkdown } from '../Card/CardMarkdown';
import { RuntimeBadge } from './BoardCardSections';
import { getDirectoryProjectName } from './directory-display';
import { buildResumeCommand } from '../../utils/resume-command';
import type { CompleteSessionGroup } from './BoardCompleteSessionView';
import { groupCardsByParent, type CardWithChildren } from './board-utils';

interface SessionConversationModalProps {
  group: CompleteSessionGroup;
  status: 'complete' | 'done';
  onClose: () => void;
  onCreateFeedback: (
    cardId: string,
    feedback: string,
    shouldDispatch: boolean,
    screenshots?: File[],
  ) => Promise<void>;
}

function formatTimestamp(iso: string | undefined): string {
  if (!iso) return '-';

  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '-';

  const pad = (value: number) => value.toString().padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function getTimestampMs(value: string | undefined): number {
  if (!value) return 0;
  const time = new Date(value).getTime();
  return Number.isNaN(time) ? 0 : time;
}

function formatDuration(card: KanbanCard): string | null {
  const explicit = card.durationMs;
  const derived =
    card.startedAt && card.completedAt
      ? getTimestampMs(card.completedAt) - getTimestampMs(card.startedAt)
      : 0;
  const ms = explicit && explicit > 0 ? explicit : derived;
  if (!ms || ms <= 0) return null;

  const totalSeconds = Math.round(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

function compareOldestCardFirst(a: KanbanCard, b: KanbanCard): number {
  const createdDiff = getTimestampMs(a.createdAt) - getTimestampMs(b.createdAt);
  if (createdDiff !== 0) return createdDiff;

  const updatedDiff = getTimestampMs(a.updatedAt) - getTimestampMs(b.updatedAt);
  if (updatedDiff !== 0) return updatedDiff;

  return a.id.localeCompare(b.id);
}

// 한 subagent(자식 카드)를 렌더한다: 메인이 내린 지시(description) +
// 그 subagent의 응답(result) + 캡처된 inter-agent 메시지(agentMessages).
const SubagentTurn: React.FC<{ child: KanbanCard }> = ({ child }) => {
  const [collapsed, setCollapsed] = useState(true);
  const speaker = child.agentType?.trim() || 'subagent';
  const instruction = child.description?.trim();
  const response = child.result?.trim();

  return (
    <div className="session-conversation-subagent">
      <button
        type="button"
        className="session-conversation-subagent-header"
        onClick={() => setCollapsed((value) => !value)}
        aria-expanded={!collapsed}
      >
        <span className="session-conversation-subagent-speaker">{speaker}</span>
        <span className="session-conversation-subagent-flow">main → {speaker}</span>
        <span className="session-conversation-subagent-toggle">
          {collapsed ? 'show ▾' : 'hide ▴'}
        </span>
      </button>
      {!collapsed && (
        <div className="session-conversation-subagent-body">
          <div className="session-conversation-subagent-part">
            <span className="session-conversation-partLabel">지시 (main → {speaker})</span>
            {instruction ? <CardMarkdown text={instruction} /> : <p>(no instruction)</p>}
          </div>
          {response && (
            <div className="session-conversation-subagent-part">
              <span className="session-conversation-partLabel">응답 ({speaker})</span>
              <CardMarkdown text={response} />
            </div>
          )}
          {child.agentMessages && child.agentMessages.length > 0 && (
            <ul className="kv2-agent-msgs">
              {child.agentMessages.map((m, i) => (
                <li key={i} className={`kv2-agent-msg kv2-agent-msg--${m.direction}`}>
                  <span className="kv2-agent-msg-dir" aria-hidden="true">
                    {m.direction === 'out' ? '→' : '←'}
                  </span>
                  <span className="kv2-agent-msg-peer">
                    {m.direction === 'out' ? (m.to ?? 'main') : (m.from ?? 'main')}
                  </span>
                  <span className="kv2-agent-msg-body">{m.message}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
};

interface SessionConversationTurnProps {
  card: CardWithChildren;
  turnNumber: number;
  isLatest: boolean;
}

const SessionConversationTurn: React.FC<SessionConversationTurnProps> = ({
  card,
  turnNumber,
  isLatest,
}) => {
  const [promptCollapsed, setPromptCollapsed] = useState(false);
  const [resultCollapsed, setResultCollapsed] = useState(false);
  const duration = formatDuration(card);
  const prompt = card.description?.trim();
  const result = card.result?.trim();
  const subagents = card.childCards
    ? [...card.childCards].sort(compareOldestCardFirst)
    : [];

  return (
    <article
      data-turn={turnNumber}
      className={`kv2-complete-session-turn${isLatest ? ' kv2-complete-session-turn--current' : ''}`}
    >
      <span className="kv2-complete-session-turn-node" aria-hidden="true" />
      <div className="kv2-complete-session-turn-body">
        <div className="kv2-complete-session-turn-header">
          <span className="session-conversation-turnLabel">Turn {turnNumber}</span>
          {isLatest && <span className="session-conversation-turnLatestTag">latest</span>}
          <div className="session-conversation-turnMeta">
            <span>Started {formatTimestamp(card.startedAt ?? card.createdAt)}</span>
            {card.completedAt && <span>Completed {formatTimestamp(card.completedAt)}</span>}
            {duration && <span className="session-conversation-turnDuration">{duration}</span>}
          </div>
        </div>

        {/* CardDetailDialog의 phase 비주얼(.kv2-phase--prompt 파란 / --result 핑크) 직접 재사용 */}
        <div className="kv2-phase-stack session-conversation-phaseStack">
          <div className="kv2-phase-card-wrapper">
            <div className="kv2-phase-header kv2-phase-header--outer">
              <div>
                <span>Prompt</span>
              </div>
              <div className="kv2-phase-header-actions">
                <button
                  type="button"
                  className="kv2-phase-action"
                  onClick={() => setPromptCollapsed((value) => !value)}
                  aria-expanded={!promptCollapsed}
                >
                  {promptCollapsed ? 'show ▾' : 'hide ▴'}
                </button>
              </div>
            </div>
            <section className="kv2-phase kv2-phase--prompt">
              <div
                className={`kv2-phase-content kv2-phase-content--markdown ${
                  promptCollapsed ? 'kv2-phase-content--collapsed' : 'kv2-phase-content--expanded'
                }`}
              >
                {prompt ? <CardMarkdown text={prompt} /> : <p>(no prompt)</p>}
              </div>
            </section>
          </div>

          {result && (
            <div className="kv2-phase-card-wrapper">
              <div className="kv2-phase-header kv2-phase-header--outer">
                <div>
                  <span>Result</span>
                </div>
                <div className="kv2-phase-header-actions">
                  <button
                    type="button"
                    className="kv2-phase-action"
                    onClick={() => setResultCollapsed((value) => !value)}
                    aria-expanded={!resultCollapsed}
                  >
                    {resultCollapsed ? 'show ▾' : 'hide ▴'}
                  </button>
                </div>
              </div>
              <section className="kv2-phase kv2-phase--result">
                <div
                  className={`kv2-phase-content kv2-phase-content--markdown ${
                    resultCollapsed ? 'kv2-phase-content--collapsed' : 'kv2-phase-content--expanded'
                  }`}
                >
                  <CardMarkdown text={result} />
                </div>
              </section>
            </div>
          )}
        </div>

        {subagents.length > 0 && (
          <div className="session-conversation-subagents">
            <div className="session-conversation-subagents-label">
              Subagents ({subagents.length})
            </div>
            {subagents.map((child) => (
              <SubagentTurn key={child.id} child={child} />
            ))}
          </div>
        )}
      </div>
    </article>
  );
};

export const SessionConversationModal: React.FC<SessionConversationModalProps> = ({
  group,
  status,
  onClose,
  onCreateFeedback,
}) => {
  const [isSubmittingFeedback, setIsSubmittingFeedback] = useState(false);
  const [copied, setCopied] = useState(false);
  const [activeTurn, setActiveTurn] = useState(1);
  const scrollRef = useRef<HTMLDivElement>(null);
  const navRef = useRef<HTMLDivElement>(null);

  // group.cards는 최신순(index 0 = 최신)이며 subagent 자식 카드도 섞여 있다.
  // groupCardsByParent로 자식을 부모 턴의 childCards로 접어 넣어 top-level 턴만 남기고
  // (유령 턴 제거), 대화는 과거→최신(위→아래)으로 고정 렌더링한다.
  const orderedTurns = useMemo(
    () => groupCardsByParent(group.cards).sort(compareOldestCardFirst),
    [group.cards],
  );

  const turnCount = orderedTurns.length;

  // 칩 클릭 → 해당 turn으로 스크롤. 헤더는 스크롤 컨테이너 바깥이라 오프셋 보정 불필요.
  const scrollToTurn = useCallback((n: number) => {
    const root = scrollRef.current;
    if (!root) return;
    const el = root.querySelector<HTMLElement>(`[data-turn="${n}"]`);
    if (!el) return;
    setActiveTurn(n);
    el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, []);

  // 스크롤 위치에 따라 현재 turn을 추적(scrollspy) — 화면 중앙 밴드를 지나는 turn을 활성화.
  useEffect(() => {
    const root = scrollRef.current;
    if (!root || turnCount <= 1) return;
    const turnEls = Array.from(root.querySelectorAll<HTMLElement>('[data-turn]'));
    if (turnEls.length === 0) return;

    const visible = new Set<number>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const n = Number((entry.target as HTMLElement).dataset.turn);
          if (entry.isIntersecting) visible.add(n);
          else visible.delete(n);
        }
        if (visible.size > 0) setActiveTurn(Math.min(...visible));
      },
      { root, rootMargin: '-45% 0px -45% 0px', threshold: 0 },
    );
    turnEls.forEach((el) => observer.observe(el));
    return () => observer.disconnect();
  }, [turnCount]);

  // 활성 칩이 항상 strip 안에 보이도록 가로 스크롤(세로는 건드리지 않음).
  useEffect(() => {
    const nav = navRef.current;
    if (!nav) return;
    const chip = nav.querySelector<HTMLElement>(`[data-turn-chip="${activeTurn}"]`);
    chip?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [activeTurn]);

  // 피드백 attach 대상: 세션의 마지막(가장 최신) complete top-level 카드.
  // group.cards가 최신순이므로 첫 매칭이 곧 최신 complete top-level 카드다.
  const feedbackTarget = useMemo(
    () => group.cards.find((card) => card.status === 'complete' && !card.parentCardId),
    [group.cards],
  );

  const resumeCommand = group.sessionId
    ? buildResumeCommand(group.agentRuntime, group.sessionId, group.projectDir)
    : '';

  const handleCopyResume = () => {
    if (!resumeCommand) return;
    void navigator.clipboard.writeText(resumeCommand).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <DialogSkeleton
      onClose={onClose}
      className={`session-conversation-dialog session-conversation-dialog--${status}`}
      persistSizeKey="session-conversation-dialog"
      defaultSize={{ width: 860, height: 880 }}
    >
      <header className="session-conversation-stickyHeader">
        <div className="session-conversation-stickyTopRow">
          <RuntimeBadge runtime={group.agentRuntime} />
          <span className="session-conversation-turnCount">{orderedTurns.length} turns</span>
          {group.sessionId && (
            <button
              type="button"
              className={`session-conversation-resumeChip${copied ? ' is-copied' : ''}`}
              title={`클릭하여 resume 명령 복사: ${resumeCommand}`}
              aria-label={`Session ID ${group.sessionId} · resume 명령 복사`}
              onClick={handleCopyResume}
            >
              {copied ? '✓ 복사됨' : `#${group.sessionId.slice(0, 8)}`}
            </button>
          )}
        </div>
        <h2 className="session-conversation-stickyTitle">{group.title}</h2>
        <div className="session-conversation-stickyMeta">
          {group.projectDir && (
            <span
              className="session-conversation-stickyProject"
              title={group.projectDir}
            >
              Proj: {getDirectoryProjectName(group.projectDir)}
            </span>
          )}
          <span className="session-conversation-stickyRange">
            {formatTimestamp(group.startedAt)} → {formatTimestamp(group.lastUpdatedAt)}
          </span>
        </div>
        {turnCount > 1 && (
          <div
            ref={navRef}
            className="session-conversation-turnNav"
            role="tablist"
            aria-label="Jump to turn"
          >
            <span className="session-conversation-turnNavLabel">Turn</span>
            {orderedTurns.map((card, index) => {
              const n = index + 1;
              const isActive = n === activeTurn;
              return (
                <button
                  key={card.id}
                  type="button"
                  role="tab"
                  data-turn-chip={n}
                  aria-selected={isActive}
                  aria-current={isActive ? 'true' : undefined}
                  className={`session-conversation-turnNavChip${isActive ? ' is-active' : ''}`}
                  title={`Turn ${n}${card.title ? ` — ${card.title}` : ''}`}
                  onClick={() => scrollToTurn(n)}
                >
                  {n}
                </button>
              );
            })}
          </div>
        )}
      </header>

      <div ref={scrollRef} className="session-conversation-scroll">
        <div className="kv2-complete-session-timeline session-conversation-timeline">
          {orderedTurns.map((card, index) => (
            <SessionConversationTurn
              key={card.id}
              card={card}
              turnNumber={index + 1}
              isLatest={index === orderedTurns.length - 1}
            />
          ))}
        </div>
      </div>

      <div className="session-conversation-feedbackDock">
        {feedbackTarget ? (
          <FeedbackPanel
            cardId={feedbackTarget.id}
            isSubmittingFeedback={isSubmittingFeedback}
            setIsSubmittingFeedback={setIsSubmittingFeedback}
            onCreateFeedback={onCreateFeedback}
            onClose={onClose}
          />
        ) : (
          <p className="session-conversation-feedbackDisabled">
            이 세션에는 피드백을 이어 붙일 수 있는 완료된 카드가 없습니다.
          </p>
        )}
      </div>
    </DialogSkeleton>
  );
};
