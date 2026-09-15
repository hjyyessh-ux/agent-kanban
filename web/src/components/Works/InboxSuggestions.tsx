import { useState } from 'react';
import { dirAccentClass } from './worksAffinity';
import { WorkAffinityMarks } from './WorkAffinityMarks';
import { daysSince, type WorkAssignSuggestion } from './worksAssign';

/**
 * The Inbox row's "배정하기 전에 미리 보는 추천" — a `✨ 추천` label beside one
 * full row per suggestion, with `＋ 새 Work` as the **last** option below them.
 *
 * Rows, not chips. The first version packed two suggestions onto one line, which
 * truncated every Work title to ~22 characters and left room for the directory
 * on only one of them: `mcp-server cloudflare cac…` next to
 * `mcp-server-springboot ke…` gave no way to tell whether those were one
 * checkout or two, which is the exact question triage is asking.
 *
 * **Clicking assigns.** These are the two or three things the row was going to
 * do anyway, and routing them through the panel meant a second click to confirm
 * a target the user had just picked by name. Both actions raise the same undo
 * toast the panel does (`noticeForLinkedSessions` / `noticeForNewWork`), so the
 * click is reversible; the panel stays one press of 배정 away for anything that
 * needs a role other than the default or a different Work.
 *
 * `＋ 새 Work` is deliberately *after* the suggestions. On the label line — where
 * it started — it sat where the first recommendation should be and read as
 * "the top suggestion is to make a new Work", which is the opposite of what the
 * ranking was saying.
 */
export function InboxSuggestions({
  suggestions,
  newWorkTitle,
  onAssignWork,
  onCreateWork,
}: {
  suggestions: WorkAssignSuggestion[];
  /** Title `＋ 새 Work` creates (`suggestWorkTitle`). */
  newWorkTitle: string;
  onAssignWork: (workId: string) => Promise<void>;
  onCreateWork: () => Promise<void>;
}) {
  // One flag for the whole block: every action here removes this row from the
  // Inbox, so a second click during the request can only be a mistake.
  const [busy, setBusy] = useState(false);
  const run = (action: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    // The hook reports failures through the shared Works error alert and
    // rethrows; swallowing keeps a failed assign from becoming an unhandled
    // rejection, and clears the flag so the row can be retried.
    void action().catch(() => {}).finally(() => setBusy(false));
  };

  return (
    <div className="works-inbox-suggest">
      <span className="works-inbox-suggest-label">
        {suggestions.length > 0 ? '✨ 추천' : '✨ 후보 없음'}
      </span>
      <div className="works-inbox-suggest-rows">
        {suggestions.map((suggestion, index) => (
          <button
            type="button"
            key={suggestion.work.id}
            // `is-second` only dims; it never changes what the row means. Two
            // rows of the same directory tint were near-identical, and a rule
            // between them would have said "two equal options" when they are
            // ranked first and second.
            className={`works-inbox-suggest-row ${dirAccentClass(suggestion.work.projectDir)}${index > 0 ? ' is-second' : ''}`}
            title={`"${suggestion.work.title}"에 바로 연결합니다 (역할: 개발)`}
            disabled={busy}
            onClick={() => run(() => onAssignWork(suggestion.work.id))}
          >
            <span className="works-inbox-suggest-bar" aria-hidden="true" />
            <span className="works-inbox-suggest-title">{suggestion.work.title}</span>
            <span className="works-inbox-suggest-why">
              {/* The same marks the assign panel puts on the same Work, in the
                  same order — the directory is always named, so "different
                  project" and "same project, different Work" stop looking
                  alike. */}
              <WorkAffinityMarks
                projectDir={suggestion.work.projectDir}
                sameDirectory={suggestion.sameDirectory}
                chained={suggestion.chained}
                keywords={suggestion.keywords}
                extra={`${daysSince(suggestion.work.startedAt) + 1}일째`}
              />
            </span>
          </button>
        ))}
        <button
          type="button"
          className="works-inbox-suggest-new"
          title={`"${newWorkTitle}" 제목으로 새 Work를 만들고 이 세션을 연결합니다`}
          disabled={busy}
          onClick={() => run(onCreateWork)}
        >
          ＋ 새 Work "{newWorkTitle}"
        </button>
      </div>
    </div>
  );
}
