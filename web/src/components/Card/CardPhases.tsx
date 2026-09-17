import React, { useRef, useEffect, useLayoutEffect, useState } from 'react';
import { KanbanCard, CardRunProgress } from '../../../../src/core/types';
import { EditingField } from './CardMetaPanel';
import { CardMarkdown } from './CardMarkdown';
import { splitCardResult } from './card-result';
import { splitFeedbackHeader } from '../../../../src/core/mention-search';

interface CardPhasesProps {
  card: KanbanCard;
  progress?: CardRunProgress | null;
  isTodo: boolean;
  canEdit: boolean;
  editingField: EditingField;
  editValue: string;
  setEditValue: (val: string) => void;
  startEditing: (field: EditingField) => void;
  saveEdit: () => void;
  cancelEdit: () => void;
  handleTextareaKeyDown: (e: React.KeyboardEvent) => void;
  onDescriptionPaste?: (e: React.ClipboardEvent<HTMLTextAreaElement>) => void;
  collapsedPhases: Record<string, boolean>;
  togglePhase: (phase: string) => void;
}

interface PhaseCardProps {
  name: string;
  tone: 'prompt' | 'progress' | 'result' | 'meta';
  canEdit?: boolean;
  isEditing?: boolean;
  collapsed: boolean;
  onToggle: () => void;
  onEdit?: () => void;
  onSave?: () => void;
  onCancel?: () => void;
  children: React.ReactNode;
}

interface RunMetaGroupProps {
  label: string;
  chips: string[];
  initialVisibleCount?: number;
  variant?: 'chip' | 'command';
}

const INITIAL_VISIBLE_COMMANDS = 3;
const INITIAL_VISIBLE_STEPS = 3;

// Short badge text per step kind — must stay narrow enough for one line.
const STEP_KIND_LABELS: Record<string, string> = {
  skill: 'SKILL',
  agent: 'AGENT',
  mcp: 'MCP',
  memory: 'MEM',
  command: 'CMD',
  tool: 'TOOL',
};

// Ordered intermediate-step timeline of the card's latest run. Truncation is
// driven by the phase header's single show/hide toggle (`collapsed`): collapsed
// shows only three steps (the most recent three while live, so the current
// activity is visible); expanded shows the summary chips and every step. Steps
// carrying a `body` (edit diff, full command, …) expand inline on click.
const ProgressSteps: React.FC<{
  progress: CardRunProgress;
  live: boolean;
  collapsed: boolean;
}> = ({ progress, live, collapsed }) => {
  const [openBodies, setOpenBodies] = useState<Record<number, boolean>>({});
  const { steps, totalSteps, summary } = progress;

  useEffect(() => {
    setOpenBodies({});
  }, [progress.runId]);

  const visibleSteps = !collapsed
    ? steps
    : live
      ? steps.slice(-INITIAL_VISIBLE_STEPS)
      : steps.slice(0, INITIAL_VISIBLE_STEPS);
  const hiddenCount = steps.length - visibleSteps.length;
  const offset = collapsed && live ? steps.length - visibleSteps.length : 0;

  return (
    <div className="kv2-progress">
      {!collapsed && (
        <div className="kv2-runmeta">
          <RunMetaGroup label="Skills" chips={summary.skills} />
          <RunMetaGroup label="Agents" chips={summary.agents} />
          <RunMetaGroup label="MCP" chips={summary.mcpServers} />
          <RunMetaGroup label="Memory" chips={summary.memory} />
        </div>
      )}
      <ol className="kv2-progress-steps">
        {collapsed && live && hiddenCount > 0 && (
          <li className="kv2-progress-step kv2-progress-step--gap" aria-hidden="true">
            ⋯ {hiddenCount} earlier step{hiddenCount > 1 ? 's' : ''}
          </li>
        )}
        {visibleSteps.map((step, i) => {
          const stepKey = offset + i;
          const bodyOpen = !!openBodies[stepKey];
          const toggleBody = step.body
            ? () => setOpenBodies((prev) => ({ ...prev, [stepKey]: !prev[stepKey] }))
            : undefined;
          return (
            <li
              key={`${stepKey}-${step.kind}-${step.label}`}
              className={`kv2-progress-step kv2-progress-step--${step.kind}${step.body ? ' kv2-progress-step--expandable' : ''}`}
            >
              <div
                className="kv2-progress-step-row"
                onClick={toggleBody}
                role={step.body ? 'button' : undefined}
                aria-expanded={step.body ? bodyOpen : undefined}
              >
                <span className="kv2-progress-kind">{STEP_KIND_LABELS[step.kind] ?? step.kind}</span>
                <span className="kv2-progress-label">{step.label}</span>
                {step.detail && (
                  <span className="kv2-progress-detail" title={step.detail}>
                    {step.detail}
                  </span>
                )}
                {step.body && (
                  <span className="kv2-progress-caret" aria-hidden="true">
                    {bodyOpen ? '▴' : '▾'}
                  </span>
                )}
              </div>
              {step.body && bodyOpen && (
                <pre className="kv2-progress-body">{step.body}</pre>
              )}
            </li>
          );
        })}
      </ol>
      {live && (
        <div className="kv2-progress-footer">
          <span className="kv2-progress-live">● running · {totalSteps} steps so far</span>
        </div>
      )}
    </div>
  );
};

const RunMetaGroup: React.FC<RunMetaGroupProps> = ({
  label,
  chips,
  initialVisibleCount,
  variant = 'chip',
}) => {
  const [expanded, setExpanded] = useState(false);
  const chipsKey = chips.join('\n');

  useEffect(() => {
    setExpanded(false);
  }, [label, chipsKey]);

  if (chips.length === 0) return null;
  const canExpand = initialVisibleCount !== undefined && chips.length > initialVisibleCount;
  const visibleChips = canExpand && !expanded ? chips.slice(0, initialVisibleCount) : chips;
  const hiddenCount = chips.length - visibleChips.length;
  const groupClass = [
    'kv2-runmeta-group',
    variant === 'command' ? 'kv2-runmeta-group--commands' : '',
    expanded ? 'kv2-runmeta-group--expanded' : '',
  ].filter(Boolean).join(' ');

  return (
    <div className={groupClass}>
      <span className="kv2-runmeta-label">{label}</span>
      <div className="kv2-runmeta-chips">
        {visibleChips.map((chip, i) => (
          <span
            key={`${i}-${chip}`}
            className={`kv2-runmeta-chip${variant === 'command' ? ' kv2-runmeta-chip--command' : ''}`}
            title={chip}
          >
            {chip}
          </span>
        ))}
        {canExpand && (
          <button
            type="button"
            className="kv2-runmeta-show"
            onClick={() => setExpanded((next) => !next)}
            aria-expanded={expanded}
          >
            {expanded ? 'Hide' : `Show ${hiddenCount} more`}
          </button>
        )}
      </div>
    </div>
  );
};

// A clamped phase body only signals "there is more" when something is actually
// cut off. The fade used to ride on the collapsed class, so a short prompt faded
// too and the fade stopped meaning anything.
const PhaseBody: React.FC<{
  collapsed: boolean;
  onExpand: () => void;
  children: React.ReactNode;
}> = ({ collapsed, onExpand, children }) => {
  const bodyRef = useRef<HTMLDivElement>(null);
  const [clipped, setClipped] = useState(false);

  useLayoutEffect(() => {
    const element = bodyRef.current;
    if (!element) return;
    if (!collapsed) {
      setClipped(false);
      return;
    }
    const measure = () => setClipped(element.scrollHeight > element.clientHeight + 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [collapsed]);

  const isClipped = collapsed && clipped;
  return (
    <>
      <div
        ref={bodyRef}
        className={`kv2-phase-content kv2-phase-content--markdown ${
          collapsed ? 'kv2-phase-content--collapsed' : 'kv2-phase-content--expanded'
        }${isClipped ? ' kv2-phase-content--clipped' : ''}`}
      >
        {children}
      </div>
      {isClipped && (
        <button type="button" className="kv2-phase-more" onClick={onExpand}>
          Show more ▾
        </button>
      )}
    </>
  );
};

// Secondary text a phase keeps but does not lead with: the interim output before a
// result, the generated header above a feedback prompt.
const PhaseAside: React.FC<{
  text: string;
  showLabel: string;
  hideLabel: string;
  open: boolean;
  onToggle: () => void;
}> = ({ text, showLabel, hideLabel, open, onToggle }) => (
  <div className="kv2-phase-aside">
    <button
      type="button"
      className="kv2-phase-aside-toggle"
      onClick={onToggle}
      aria-expanded={open}
    >
      {open ? hideLabel : showLabel}
    </button>
    {open && <CardMarkdown text={text} />}
  </div>
);

const PhaseCard: React.FC<PhaseCardProps> = ({
  name,
  tone,
  canEdit = false,
  isEditing = false,
  collapsed,
  onToggle,
  onEdit,
  onSave,
  onCancel,
  children,
}) => {
  return (
    <div className="kv2-phase-card-wrapper">
      <div className="kv2-phase-header kv2-phase-header--outer">
        <div>
          <span>{name}</span>
        </div>
        <div className="kv2-phase-header-actions">
          {canEdit && !isEditing && onEdit && (
            <button
              type="button"
              className="kv2-phase-action kv2-phase-action--edit"
              onClick={onEdit}
              title={`Edit ${name.toLowerCase()}`}
            >
              ✎
            </button>
          )}
          {isEditing && onSave && onCancel && (
            <div className="kv2-phase-edit-actions">
              <button type="button" className="kv2-phase-action" onClick={onCancel}>
                Cancel
              </button>
              <button type="button" className="kv2-phase-action kv2-phase-action--save" onClick={onSave}>
                Save
              </button>
            </div>
          )}
          {!isEditing && (
            <button
              type="button"
              className="kv2-phase-action"
              onClick={onToggle}
              aria-expanded={!collapsed}
            >
              {collapsed ? 'show ▾' : 'hide ▴'}
            </button>
          )}
        </div>
      </div>
      <section className={`kv2-phase kv2-phase--${tone}`}>
        {children}
      </section>
    </div>
  );
};

export const CardPhases: React.FC<CardPhasesProps> = ({
  card,
  progress,
  isTodo,
  canEdit,
  editingField,
  editValue,
  setEditValue,
  startEditing,
  saveEdit,
  cancelEdit,
  handleTextareaKeyDown,
  onDescriptionPaste,
  collapsedPhases,
  togglePhase,
}) => {
  const editTextareaRef = useRef<HTMLTextAreaElement>(null);
  const [showEarlierResult, setShowEarlierResult] = useState(false);
  const [showFeedbackHeader, setShowFeedbackHeader] = useState(false);
  const { earlier: earlierResult, final: finalResult } = splitCardResult(card);
  // A feedback card's prompt starts with a generated header block; the body below
  // it is the actual instruction, so that is what the phase leads with.
  const { header: feedbackHeader, body: promptBody } = splitFeedbackHeader(card.description ?? '');

  useEffect(() => {
    if (editingField === 'description') {
      editTextareaRef.current?.focus();
    }
  }, [editingField]);

  useEffect(() => {
    setShowEarlierResult(false);
    setShowFeedbackHeader(false);
  }, [card.id]);

  return (
    <div className="kv2-phase-stack">
      {((isTodo && canEdit) || card.description) && (
        <PhaseCard
          name="Prompt"
          tone="prompt"
          canEdit={isTodo && canEdit}
          isEditing={editingField === 'description'}
          onEdit={() => startEditing('description')}
          onSave={saveEdit}
          onCancel={cancelEdit}
          collapsed={collapsedPhases.prompt}
          onToggle={() => togglePhase('prompt')}
        >
          {editingField === 'description' ? (
            <textarea
              ref={editTextareaRef}
              className="kv2-input kv2-phase-edit-textarea"
              value={editValue}
              onChange={(e) => setEditValue(e.target.value)}
              onKeyDown={handleTextareaKeyDown}
              onPaste={onDescriptionPaste}
              onBlur={saveEdit}
              rows={8}
              placeholder="Enter task description..."
            />
          ) : (
            <PhaseBody
              collapsed={collapsedPhases.prompt}
              onExpand={() => togglePhase('prompt')}
            >
              {feedbackHeader && (
                <PhaseAside
                  text={feedbackHeader}
                  showLabel="Show feedback header ▾"
                  hideLabel="Hide feedback header ▴"
                  open={showFeedbackHeader}
                  onToggle={() => setShowFeedbackHeader((next) => !next)}
                />
              )}
              {card.description ? <CardMarkdown text={promptBody} /> : '(no description)'}
            </PhaseBody>
          )}
        </PhaseCard>
      )}

      {(card.progressSummary || (progress && progress.steps.length > 0)) && (
        <PhaseCard
          name="Progress"
          tone="progress"
          collapsed={collapsedPhases.progress}
          onToggle={() => togglePhase('progress')}
        >
          {/* No CSS height clip here — collapsed mode limits visible steps,
              while the single header show/hide toggle reveals everything. */}
          <div className="kv2-phase-content kv2-phase-content--markdown kv2-phase-content--expanded">
            {card.progressSummary && <CardMarkdown text={card.progressSummary} />}
            {progress && progress.steps.length > 0 && (
              <ProgressSteps
                progress={progress}
                live={card.status === 'in_progress'}
                collapsed={collapsedPhases.progress}
              />
            )}
          </div>
        </PhaseCard>
      )}

      {card.result && (
        <PhaseCard
          name="Result"
          tone="result"
          collapsed={collapsedPhases.result}
          onToggle={() => togglePhase('result')}
        >
          <PhaseBody
            collapsed={collapsedPhases.result}
            onExpand={() => togglePhase('result')}
          >
            {earlierResult && (
              <PhaseAside
                text={earlierResult}
                showLabel="Show earlier output ▾"
                hideLabel="Hide earlier output ▴"
                open={showEarlierResult}
                onToggle={() => setShowEarlierResult((next) => !next)}
              />
            )}
            <CardMarkdown text={finalResult} />
          </PhaseBody>
        </PhaseCard>
      )}

      {(card.git || card.usage) && (() => {
        const branchChips: string[] = [];
        const startBranch = card.git?.start?.branch;
        const endBranch = card.git?.end?.branch;
        if (startBranch && endBranch && startBranch !== endBranch) {
          branchChips.push(`${startBranch} → ${endBranch}`);
        } else if (endBranch || startBranch) {
          branchChips.push((endBranch || startBranch) as string);
        }
        for (const b of card.git?.branches ?? []) {
          const added = b.commitsAdded ?? 0;
          branchChips.push(added > 0 ? `${b.branch} +${added} commit${added > 1 ? 's' : ''}` : b.branch);
        }

        const mcpToolEntries = Object.entries(card.usage?.mcpTools ?? {}).sort(([a], [b]) => a.localeCompare(b));
        const mcpChips = mcpToolEntries.length > 0
          ? mcpToolEntries.map(([name, count]) => `${name} ×${count}`)
          : card.usage?.mcpServers ?? [];
        const commandChips = card.usage?.commands ?? [];
        const skillChips = card.usage?.skillsUsed ?? [];
        const agentChips = card.usage?.subagents ?? [];
        const toolChips = Object.entries(card.usage?.tools ?? {})
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([name, count]) => (count > 1 ? `${name} ×${count}` : name));

        const hasAny =
          branchChips.length > 0 ||
          mcpChips.length > 0 ||
          commandChips.length > 0 ||
          skillChips.length > 0 ||
          agentChips.length > 0 ||
          toolChips.length > 0;
        if (!hasAny) return null;

        return (
          <PhaseCard
            name="Run metadata"
            tone="meta"
            collapsed={collapsedPhases.runmeta}
            onToggle={() => togglePhase('runmeta')}
          >
            <div
              className={`kv2-phase-content ${
                collapsedPhases.runmeta ? 'kv2-phase-content--collapsed' : 'kv2-phase-content--expanded'
              }`}
            >
              <div className="kv2-runmeta">
                <RunMetaGroup label="Branches" chips={branchChips} />
                <RunMetaGroup label="Skills" chips={skillChips} />
                <RunMetaGroup label="Agents" chips={agentChips} />
                <RunMetaGroup label="MCP" chips={mcpChips} />
                <RunMetaGroup label="Tools" chips={toolChips} />
                <RunMetaGroup
                  label="Commands"
                  chips={commandChips}
                  initialVisibleCount={INITIAL_VISIBLE_COMMANDS}
                  variant="command"
                />
              </div>
            </div>
          </PhaseCard>
        );
      })()}

      {card.agentMessages && card.agentMessages.length > 0 && (
        <PhaseCard
          name="Agent messages"
          tone="result"
          collapsed={collapsedPhases.messages}
          onToggle={() => togglePhase('messages')}
        >
          <div
            className={`kv2-phase-content ${
              collapsedPhases.messages ? 'kv2-phase-content--collapsed' : 'kv2-phase-content--expanded'
            }`}
          >
            <ul className="kv2-agent-msgs">
              {card.agentMessages.map((m, i) => (
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
          </div>
        </PhaseCard>
      )}
    </div>
  );
};
