import { dirAccentClass } from './worksAffinity';
import { WorkAffinityMarks } from './WorkAffinityMarks';
import { daysSince, type WorkAssignSuggestion } from './worksAssign';

/**
 * The Inbox row's "배정하기 전에 미리 보는 추천" — a header line (`✨ 추천` plus
 * the ＋ 새 Work escape hatch) and then **one full row per suggestion**.
 *
 * Rows, not chips. The first version packed two suggestions onto one line, which
 * meant every Work title was truncated to ~22 characters and only one of the two
 * had room for its directory: `mcp-server cloudflare cac…` next to
 * `mcp-server-springboot ke…` left no way to tell whether those were one
 * checkout or two, which is the exact question triage is asking. A row gives the
 * title the width it needs and puts the directory and the reason on the same
 * line as the title they explain.
 *
 * It sits under the row's metadata rather than in the empty space to its right
 * for the same reason — a Work title is as long as a session title, and the
 * widest Inbox rows have no right-hand space to begin with.
 *
 * Clicking a row does **not** assign. It opens the assign panel with that target
 * already chosen, whose top action bar holds the commit — a suggestion is a
 * cheap guess from words and directories (`suggestWorkAssignments`, no model
 * involved), and a wrong one-click link costs a move dialog to undo.
 */
export function InboxSuggestions({
  suggestions,
  newWorkTitle,
  onPickWork,
  onPickNew,
}: {
  suggestions: WorkAssignSuggestion[];
  /** Title a 새 Work row would seed (`suggestWorkTitle`). */
  newWorkTitle: string;
  onPickWork: (workId: string) => void;
  onPickNew: () => void;
}) {
  return (
    <div className="works-inbox-suggest">
      <div className="works-inbox-suggest-head">
        <span className="works-inbox-suggest-label">
          {suggestions.length > 0 ? '✨ 추천' : '✨ 닮은 Work 없음'}
        </span>
        <button
          type="button"
          className="works-inbox-suggest-new"
          title={`"${newWorkTitle}" 제목으로 새 Work를 만듭니다`}
          onClick={onPickNew}
        >
          ＋ 새 Work
        </button>
      </div>
      {suggestions.length > 0 && (
        <div className="works-inbox-suggest-rows">
          {suggestions.map((suggestion) => (
            <button
              type="button"
              key={suggestion.work.id}
              className={`works-inbox-suggest-row ${dirAccentClass(suggestion.work.projectDir)}`}
              title={`"${suggestion.work.title}"에 연결`}
              onClick={() => onPickWork(suggestion.work.id)}
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
        </div>
      )}
    </div>
  );
}
