import React, { useRef, useState } from 'react';
import { DialogSkeleton } from '../Card/DialogSkeleton';
import { BOARD_WORKS_COPY } from '../../constants/copy';

interface BoardNewWorkDialogProps {
  /** `suggestWorkTitle` of the session — the same seed the Inbox's 새 Work uses. */
  initialTitle: string;
  onSubmit: (title: string) => void;
  onClose: () => void;
}

/**
 * Names the Work a board drop / `⋯` creates (`＋ 새 Work`). Submitting closes
 * at once — the mutation and its undo notice run after, like every other
 * board Works action.
 */
export const BoardNewWorkDialog: React.FC<BoardNewWorkDialogProps> = ({ initialTitle, onSubmit, onClose }) => {
  const [title, setTitle] = useState(initialTitle);
  const inputRef = useRef<HTMLInputElement>(null);
  const trimmed = title.trim();

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (!trimmed) return;
    onSubmit(trimmed);
  };

  return (
    <DialogSkeleton title={BOARD_WORKS_COPY.newWorkTitle} onClose={onClose} width="480px" initialFocusRef={inputRef}>
      <form className="kv2-new-work-form" onSubmit={submit}>
        <label className="kv2-new-work-label">
          <span>{BOARD_WORKS_COPY.newWorkLabel}</span>
          <input
            ref={inputRef}
            className="kv2-input"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
          />
        </label>
        <div className="kv2-dialog-footer">
          <div className="kv2-actions-split">
            <div className="kv2-actions-primary">
              <button type="button" className="kv2-btn kv2-btn--outline" onClick={onClose}>
                {BOARD_WORKS_COPY.newWorkCancel}
              </button>
              <button type="submit" className="kv2-btn kv2-btn--primary" disabled={!trimmed}>
                {BOARD_WORKS_COPY.newWorkSubmit}
              </button>
            </div>
          </div>
        </div>
      </form>
    </DialogSkeleton>
  );
};
