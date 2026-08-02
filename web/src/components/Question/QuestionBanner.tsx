import React, { useState, useCallback, useEffect } from 'react';
import type { QuestionRequest, QuestionInfo, QuestionOption } from '../../hooks/useQuestionsApi';
import './Question.css';

interface Props {
  questions: QuestionRequest[];
  onReply: (id: string, answers: string[][]) => Promise<void>;
  onReject: (id: string) => Promise<void>;
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
 * QuestionBanner — overlays the UI when opencode has pending questions.
 * Displays the first pending QuestionRequest. User can answer or reject.
 * Disappears automatically when all questions are answered/rejected.
 */
export const QuestionBanner: React.FC<Props> = ({ questions, onReply, onReject }) => {
  // Display the first pending request
  const request = questions[0];

  // Track selections per QuestionInfo index: Record<questionIndex, string[]>
  const [selections, setSelections] = useState<Record<number, string[]>>({});
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Reset selections when the active request changes
  useEffect(() => {
    setSelections({});
    setIsSubmitting(false);
  }, [request?.id]);

  // Close on Escape key
  useEffect(() => {
    if (!request) return;
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !isSubmitting) {
        void onReject(request.id);
      }
    };
    window.addEventListener('keydown', handleEsc);
    return () => window.removeEventListener('keydown', handleEsc);
  }, [request, isSubmitting, onReject]);

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
      void handleReject();
    }
  };

  if (!request) return null;

  return (
    <div className="question-overlay" onClick={handleOverlayClick}>
      <div
        className={`question-banner${isSubmitting ? ' question-banner--submitting' : ''}`}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="question-banner-header">
          <span className="question-banner-title">
            <span className="question-banner-title-icon">❓</span>
            opencode needs your input
          </span>
          <span className="question-banner-meta">
            session {request.sessionID.substring(0, 8)}
          </span>
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
            className="kv2-btn question-reject-btn kv2-action-cancel"
            style={{ background: 'var(--color-bg)', color: 'var(--color-text)' }}
            onClick={() => void handleReject()}
            disabled={isSubmitting}
          >
            Dismiss
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
