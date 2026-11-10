import React from 'react';
import { useCopyFeedback } from '../../hooks/useCopyFeedback';
import { formatShortId } from '../../utils/short-id';

export type IdKind = 'card' | 'session' | 'work';

const KIND_LABEL: Record<IdKind, string> = {
  card: 'Card',
  session: 'Session',
  work: 'Work',
};

export const COPIED_LABEL = '✓ 복사됨';

/**
 * Keeps Enter/Space from reaching clickable parents (card, session header).
 * Only those two: a dialog opens with focus on its header `IdChip` (Work
 * detail), and swallowing every key there also swallowed Escape, so the
 * dialog would not close until the user clicked elsewhere first.
 */
export const stopKey = (event: Pick<React.KeyboardEvent, 'key' | 'stopPropagation'>) => {
  if (event.key === 'Enter' || event.key === ' ') event.stopPropagation();
};

interface IdChipProps {
  id: string;
  kind: IdKind;
  /** Show the `CARD`/`SESSION`/`WORK` prefix — for surfaces where several id kinds sit together. */
  showKind?: boolean;
  className?: string;
}

/**
 * The one identifier chip: `#` + 8 chars, click copies the **full raw id**,
 * `✓ 복사됨` for 1.5s. Resume commands are never copied from here — use
 * `ResumeCopyButton` next to it, or `SessionResumeChip` where the session id
 * itself is the resume control (board session groups).
 */
export const IdChip: React.FC<IdChipProps> = ({ id, kind, showKind = false, className }) => {
  const { copied, copy } = useCopyFeedback(id);
  const label = KIND_LABEL[kind];
  return (
    <button
      type="button"
      className={['kv2-id-chip', copied ? 'is-copied' : '', className ?? ''].filter(Boolean).join(' ')}
      title={`${label} ID 복사: ${id}`}
      aria-label={`${label} ID ${id} 복사`}
      onKeyDown={stopKey}
      onClick={(event) => {
        event.stopPropagation();
        copy(id);
      }}
    >
      {showKind && <span className="kv2-id-chip-kind">{label}</span>}
      <span className="kv2-id-chip-value">{copied ? COPIED_LABEL : formatShortId(id)}</span>
      <span className="kv2-id-chip-icon" aria-hidden="true">⧉</span>
    </button>
  );
};

/**
 * Same look as `IdChip` but inert — only for ids rendered *inside* another
 * button (picker/queue/mention rows), where a nested button is invalid HTML.
 */
export const IdText: React.FC<{ id: string; kind: IdKind; showKind?: boolean; className?: string }> = ({
  id,
  kind,
  showKind = false,
  className,
}) => (
  <span className={['kv2-id-chip', 'kv2-id-chip--static', className ?? ''].filter(Boolean).join(' ')} title={id}>
    {showKind && <span className="kv2-id-chip-kind">{KIND_LABEL[kind]}</span>}
    <span className="kv2-id-chip-value">{formatShortId(id)}</span>
  </span>
);

export const RESUME_COPIED_LABEL = '✓ resume 복사됨';

/**
 * A session id chip whose click copies the **resume command**, not the raw id
 * — the board session group's only resume control (the separate `⏎ resume`
 * button was dropped there). Same look as `IdChip` plus a `⏎` mark, so it
 * never reads as a plain id copy; the full command is in the tooltip.
 */
export const SessionResumeChip: React.FC<{ sessionId: string; command: string; className?: string }> = ({
  sessionId,
  command,
  className,
}) => {
  const { copied, copy } = useCopyFeedback(command);
  return (
    <button
      type="button"
      className={['kv2-id-chip', 'kv2-id-chip--resume', copied ? 'is-copied' : '', className ?? ''].filter(Boolean).join(' ')}
      title={`클릭: resume 명령 복사\n${command}`}
      aria-label={`Session ${sessionId} resume 명령 복사`}
      onKeyDown={stopKey}
      onClick={(event) => {
        event.stopPropagation();
        copy(command);
      }}
    >
      <span className="kv2-id-chip-value">{copied ? RESUME_COPIED_LABEL : formatShortId(sessionId)}</span>
      {!copied && <span className="kv2-id-chip-resume" aria-hidden="true">⏎</span>}
    </button>
  );
};

interface ResumeCopyButtonProps {
  command: string;
  className?: string;
}

/** Copies the runtime's resume command (`cd … && claude --resume …`). Sits beside a session `IdChip`. */
export const ResumeCopyButton: React.FC<ResumeCopyButtonProps> = ({ command, className }) => {
  const { copied, copy } = useCopyFeedback(command);
  return (
    <button
      type="button"
      className={['kv2-resume-copy', copied ? 'is-copied' : '', className ?? ''].filter(Boolean).join(' ')}
      title={`resume 명령 복사: ${command}`}
      aria-label="resume 명령 복사"
      onKeyDown={stopKey}
      onClick={(event) => {
        event.stopPropagation();
        copy(command);
      }}
    >
      {copied ? COPIED_LABEL : '⏎ resume'}
    </button>
  );
};
