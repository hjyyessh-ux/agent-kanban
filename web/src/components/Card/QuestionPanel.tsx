import React, { useState } from "react";
import { QuestionRequest, QuestionOption } from "../../hooks/useQuestionsApi";

interface QuestionPanelProps {
  question: QuestionRequest;
  onAnswerQuestion?: (questionId: string, answers: string[][]) => Promise<void>;
  onRejectQuestion?: (questionId: string) => Promise<void>;
  collapsed: boolean;
  togglePhase: () => void;
}

export const QuestionPanel: React.FC<QuestionPanelProps> = ({
  question,
  onAnswerQuestion,
  onRejectQuestion,
  collapsed,
  togglePhase,
}) => {
  const [questionAnswers, setQuestionAnswers] = useState<Record<number, string[]>>({});
  const [questionCustomTexts, setQuestionCustomTexts] = useState<Record<number, string>>({});
  const [isQuestionSubmitting, setIsQuestionSubmitting] = useState(false);

  return (
    <div className="kv2-phase kv2-phase--question">
      <div className="kv2-phase-header kv2-phase-header--question">
        <span>❓ Question</span>
        <button
          type="button"
          className="kv2-phase-action"
          onClick={togglePhase}
          aria-expanded={!collapsed}
        >
          {collapsed ? "▸ show" : "▾ hide"}
        </button>
      </div>
      <div
        className={`kv2-phase-content ${
          collapsed ? "kv2-phase-content--collapsed" : "kv2-phase-content--expanded"
        }`}
      >
        {question.questions.map((info, qIdx) => {
          const selections = questionAnswers[qIdx] ?? [];
          return (
            <div key={info.question} className="kv2-question-block">
              {info.header && <p className="kv2-question-header">{info.header}</p>}
              <p className="kv2-question-text">{info.question}</p>
              {info.multiple && <p className="kv2-question-hint">Select all that apply</p>}
              <div className="kv2-question-options">
                {(info.options as QuestionOption[]).map((opt) => {
                  const isSelected = selections.includes(opt.label);
                  return (
                    <button
                      key={opt.label}
                      type="button"
                      className={`kv2-question-option${
                        isSelected ? " kv2-question-option--selected" : ""
                      }`}
                      onClick={() => {
                        if (info.multiple) {
                          const next = isSelected
                            ? selections.filter((s) => s !== opt.label)
                            : [...selections, opt.label];
                          setQuestionAnswers((prev) => ({
                            ...prev,
                            [qIdx]: next,
                          }));
                        } else {
                          setQuestionAnswers((prev) => ({
                            ...prev,
                            [qIdx]: isSelected ? [] : [opt.label],
                          }));
                        }
                      }}
                      disabled={isQuestionSubmitting}
                    >
                      <span>{opt.label}</span>
                      {opt.description && (
                        <span className="kv2-question-option-desc">{opt.description}</span>
                      )}
                    </button>
                  );
                })}
              </div>
              {info.custom && (
                <div className="kv2-question-custom">
                  <input
                    className="kv2-input"
                    type="text"
                    value={questionCustomTexts[qIdx] ?? ""}
                    onChange={(e) => {
                      const val = e.target.value;
                      setQuestionCustomTexts((prev) => ({
                        ...prev,
                        [qIdx]: val,
                      }));
                      const optionLabels = new Set(
                        (info.options as QuestionOption[]).map((o) => o.label)
                      );
                      const optionSelections = (questionAnswers[qIdx] ?? []).filter((s) =>
                        optionLabels.has(s)
                      );
                      const merged = val.trim() ? [...optionSelections, val] : optionSelections;
                      setQuestionAnswers((prev) => ({
                        ...prev,
                        [qIdx]: merged,
                      }));
                    }}
                    placeholder="Type your own answer..."
                    disabled={isQuestionSubmitting}
                  />
                </div>
              )}
            </div>
          );
        })}
        <div className="kv2-question-actions kv2-actions-split">
          <button
            type="button"
            className="kv2-btn kv2-btn--ghost kv2-action-cancel"
            onClick={async () => {
              if (!onRejectQuestion || isQuestionSubmitting) return;
              setIsQuestionSubmitting(true);
              try {
                await onRejectQuestion(question.id);
              } catch {
                setIsQuestionSubmitting(false);
              }
            }}
            disabled={isQuestionSubmitting}
          >
            Dismiss
          </button>
          <button
            type="button"
            className="kv2-btn kv2-btn--primary kv2-btn--question"
            onClick={async () => {
              if (!onAnswerQuestion || isQuestionSubmitting) return;
              setIsQuestionSubmitting(true);
              try {
                const answers = question.questions.map((_, i) => questionAnswers[i] ?? []);
                await onAnswerQuestion(question.id, answers);
              } catch {
                setIsQuestionSubmitting(false);
              }
            }}
            disabled={
              isQuestionSubmitting ||
              !question.questions.every((_, i) => (questionAnswers[i] ?? []).length > 0)
            }
          >
            {isQuestionSubmitting ? "Submitting…" : "Submit Answer"}
          </button>
        </div>
      </div>
    </div>
  );
};
