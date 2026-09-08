import { projectDirLabel } from './worksAssign';
import { dirAccentClass } from './worksAffinity';

/**
 * Colour-coded `projectDir` chip. On the session being triaged it is the
 * reference swatch; on a Work row it is what that swatch is compared against.
 * Same colour means the same directory, everywhere in the Works tab.
 *
 * The directory *name* is what carries the colour — there is no separate dot.
 * A 10px dot is too small a sample to tell two palette slots apart, and it put
 * the hue next to the label instead of on it; tinting the label spends a word's
 * worth of area on the signal. `title` keeps the full path reachable, since the
 * chip only shows the last segment.
 */
export function DirChip({
  projectDir,
  className,
}: {
  projectDir: string | undefined;
  className?: string;
}) {
  if (!projectDir) return null;
  return (
    <b
      className={`works-dir-chip ${dirAccentClass(projectDir)}${className ? ` ${className}` : ''}`}
      title={projectDir}
    >
      📁 {projectDirLabel(projectDir)}
    </b>
  );
}

/**
 * Why a Work is being recommended, in the two signals triage actually has:
 * its directory (as a colour + name, so matching is visual rather than a path
 * comparison) and session lineage (🔗 — this Work already holds a session the
 * one being assigned came out of).
 *
 * Shared by the assign-all modal and the inline assign panel so a session that
 * looks related in one never looks unrelated in the other.
 */
export function WorkAffinityMarks({
  projectDir,
  sameDirectory,
  chained,
  extra,
}: {
  projectDir: string | undefined;
  sameDirectory: boolean;
  chained: boolean;
  /** Trailing free-form meta (e.g. "3일째"). */
  extra?: string;
}) {
  return (
    <>
      {chained && <span className="works-chain-mark">🔗 이어진 세션</span>}
      <span className={`works-dir-mark ${dirAccentClass(projectDir)}`} title={projectDir}>
        {projectDir ? projectDirLabel(projectDir) : '디렉토리 없음'}
      </span>
      {sameDirectory && <span className="works-dir-same">같은 디렉토리</span>}
      {extra && <span className="works-affinity-extra">{extra}</span>}
    </>
  );
}
