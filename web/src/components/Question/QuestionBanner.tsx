import React, { useState, useCallback, useEffect, useId, useRef } from 'react';
import type { QuestionRequest, QuestionInfo, QuestionOption } from '../../hooks/useQuestionsApi';
import { hasOtherEscapeLayer, resolveQuestionEscape } from './questionBannerModel';
import './Question.css';

interface Props {
  questions: QuestionRequest[];
  onReply: (id: string, answers: string[][]) => Promise<void>;
  onReject: (id: string) => Promise<void>;
  /** Label of the runtime that owns `sessionId` (see `questionRuntimeLabel`). */
  runtimeLabel?: (sessionId: string) => string;
}

/**
 * Renders a single question within a request.
 * Returns the user's current selections as string[].
 * Calls onSelectionsChange whenever the user toggles an option or changes custom text.
 */
interface QuestionBlockProps {
  info: QuestionInfo;
  questionIndex: number;
  selections: string[];
  onSelectionsChange: (questionIndex: number, newSelections: string[]) => void;
  isSubmitting: boolean;
}

const QuestionBlock: React.FC<QuestionBlockProps> = ({
  info,
  questionIndex,
  selections,
  onSelectionsChange,
  isSubmitting,
}) => {
  // Custom text state (only relevant when info.custom === true)
  const [customText, setCustomText] = useState('');

  // When custom text changes, merge it into selections
  const handleCustomTextChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    setCustomText(val);
    // Custom text replaces any non-option selection at the end
    // Keep option-based selections, append custom text if non-empty
    const optionLabels = new Set((info.options as QuestionOption[]).map((o) => o.label));
    const optionSelections = selections.filter((s) => optionLabels.has(s));
    const merged = val.trim() ? [...optionSelections, val] : optionSelections;
    onSelectionsChange(questionIndex, merged);
  };

  const toggleOption = (label: string) => {
    if (info.multiple) {
      // Multi-select: toggle
      const has = selections.includes(label);
      const next = has ? selections.filter((s) => s !== label) : [...selections, label];
      onSelectionsChange(questionIndex, next);
    } else {
      // Single-select: replace (deselect if already selected)
      const has = selections.includes(label);
      onSelectionsChange(questionIndex, has ? [] : [label]);
    }
  };

  return (
    <div className="question-block">
      {info.header && <p className="question-header-text">{info.header}</p>}
      <p className="question-text">{info.question}</p>

      {info.multiple && (
        <p className="question-multi-hint">Select all that apply</p>
      )}

      <div className="question-options">
        {(info.options as QuestionOption[]).map((opt) => {
          const isSelected = selections.includes(opt.label);
          return (
            <button
              key={opt.label}
              type="button"
              className={`question-option${isSelected ? ' question-option--selected' : ''}`}
              onClick={() => toggleOption(opt.label)}
              disabled={isSubmitting}
            >
              <span className="question-option-label">{opt.label}</span>
              {opt.description && (
                <span className="question-option-desc">{opt.description}</span>
              )}
            </button>
          );
        })}
      </div>

      {info.custom && (
        <div className="question-custom-input">
          <label className="question-custom-label">Custom Answer (optional)</label>
          <input
            className="kv2-input"
            type="text"
            value={customText}
            onChange={handleCustomTextChange}
            placeholder="Type your own answer..."
            disabled={isSubmitting}
          />
        </div>
      )}
    </div>
  );
};

/**
 * QuestionBanner — overlays the UI when an agent session has pending questions.
 * Displays the first pending QuestionRequest. User can answer, reject, or
 * minimize it to a corner pill and come back later.
 *
 * Escape and a backdrop click only ever **minimize**: rejecting discards the
 * agent's question, and an Escape meant for a filter popover used to do exactly
 * that. Rejecting is the explicit `Reject` button only.
 */
export const QuestionBanner: React.FC<Props> = ({ questions, onReply, onReject, runtimeLabel }) => {
  // Display the first pending request
  const request = questions[0];
  const titleId = useId();
  const bannerRef = useRef<HTMLDivElement>(null);
  const pillRef = useRef<HTMLButtonElement>(null);

  // Track selections per QuestionInfo index: Record<questionIndex, string[]>
  const [selections, setSelections] = useState<Record<number, string[]>>({});
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [minimized, setMinimized] = useState(false);

  // Reset selections when the active request changes. A different question
  // opens expanded again — minimizing parked *that* question, not the banner.
  useEffect(() => {
    setSelections({});
    setIsSubmitting(false);
    setMinimized(false);
  }, [request?.id]);

  // An expanded banner is modal (`aria-modal`), so focus moves into it.
  useEffect(() => {
    if (request && !minimized) bannerRef.current?.focus();
  }, [request?.id, minimized]);

  // Escape minimizes — after any other open popover/modal has had its turn.
  useEffect(() => {
    if (!request) return;
    const handleEsc = (e: KeyboardEvent) => {
      const action = resolveQuestionEscape({
        key: e.key,
        defaultPrevented: e.defaultPrevented,
        minimized,
        isSubmitting,
        otherLayerOpen: e.key === 'Escape' && hasOtherEscapeLayer(document, bannerRef.current),
      });
      if (action !== 'minimize') return;
      e.preventDefault();
      setMinimized(true);
    };
    window.addEventListener('keydown', handleEsc);
    return () => window.removeEventListener('keydown', handleEsc);
  }, [request, isSubmitting, minimized]);

  useEffect(() => {
    if (minimized) pillRef.current?.focus();
  }, [minimized]);

  const handleSelectionsChange = useCallback(
    (questionIndex: number, newSelections: string[]) => {
      setSelections((prev) => ({ ...prev, [questionIndex]: newSelections }));
    },
    []
  );

  // Can submit only when every question has at least one selection
  const canSubmit = useCallback(() => {
    if (!request) return false;
    return request.questions.every((_, i) => {
      const s = selections[i] ?? [];
      return s.length > 0;
    });
  }, [request, selections]);

  const handleSubmit = async () => {
    if (!request || !canSubmit() || isSubmitting) return;
    setIsSubmitting(true);
    try {
      // Build answers: one string[] per QuestionInfo
      const answers: string[][] = request.questions.map((_, i) => selections[i] ?? []);
      await onReply(request.id, answers);
    } catch {
      // Error surfaced by useQuestions; re-enable for retry
      setIsSubmitting(false);
    }
  };

  const handleReject = async () => {
    if (!request || isSubmitting) return;
    setIsSubmitting(true);
    try {
      await onReject(request.id);
    } catch {
      setIsSubmitting(false);
    }
  };

  const handleOverlayClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget && !isSubmitting) {
      setMinimized(true);
    }
  };

  if (!request) return null;

  const label = runtimeLabel?.(request.sessionID) ?? null;
  const title = label ? `${label} needs your input` : 'Agent needs your input';

  if (minimized) {
    return (
      <button
        ref={pillRef}
        type="button"
        className="kv2-btn kv2-btn--primary question-reopen-pill"
        onClick={() => setMinimized(false)}
        aria-label={`Reopen question: ${title}`}
      >
        <span aria-hidden="true">❓</span>
        {title}
        {questions.length > 1 && <span className="kv2-badge">{questions.length}</span>}
      </button>
    );
  }

  return (
    <div className="question-overlay" onClick={handleOverlayClick}>
      <div
        ref={bannerRef}
        className={`question-banner${isSubmitting ? ' question-banner--submitting' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="question-banner-header">
          <h2 id={titleId} className="question-banner-title">
            <span className="question-banner-title-icon" aria-hidden="true">❓</span>
            {title}
          </h2>
          <span className="question-banner-meta">
            session {request.sessionID.substring(0, 8)}
          </span>
          <button
            type="button"
            className="kv2-btn kv2-btn--ghost kv2-btn--small question-minimize-btn"
            onClick={() => setMinimized(true)}
            aria-label="Minimize question"
            title="최소화 (Esc) — 구석의 버튼으로 다시 열 수 있습니다"
          >
            —
          </button>
        </div>

        {/* One block per QuestionInfo */}
        {request.questions.map((info, i) => (
          <QuestionBlock
            key={i}
            info={info}
            questionIndex={i}
            selections={selections[i] ?? []}
            onSelectionsChange={handleSelectionsChange}
            isSubmitting={isSubmitting}
          />
        ))}

        {/* Actions */}
        <div className="question-actions kv2-actions-split">
          <button
            type="button"
            className="kv2-btn kv2-btn--subtle-danger question-reject-btn kv2-action-cancel"
            onClick={() => void handleReject()}
            disabled={isSubmitting}
            title="에이전트의 질문을 거절합니다"
          >
            Reject
          </button>
          <button
            type="button"
            className="kv2-btn question-submit-btn"
            onClick={() => void handleSubmit()}
            disabled={isSubmitting || !canSubmit()}
          >
            {isSubmitting ? 'Submitting…' : 'Submit Answer'}
          </button>
        </div>
      </div>
    </div>
  );
};
