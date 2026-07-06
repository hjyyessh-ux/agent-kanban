import type { VisibilityChange } from '../../hooks/useScopeInventory';

interface DiffLine {
  type: 'context' | 'removed' | 'added';
  content: string;
  lineNum?: number;
}

function computeDiffLines(before: string, after: string): DiffLine[] {
  const bLines = before.split('\n');
  const aLines = after.split('\n');

  // Find first divergent line
  let start = 0;
  while (start < bLines.length && start < aLines.length && bLines[start] === aLines[start]) {
    start++;
  }

  // Find last divergent line (from the end)
  let bEnd = bLines.length - 1;
  let aEnd = aLines.length - 1;
  while (bEnd > start && aEnd > start && bLines[bEnd] === aLines[aEnd]) {
    bEnd--;
    aEnd--;
  }

  const result: DiffLine[] = [];

  // 2 lines of context before
  const ctxStart = Math.max(0, start - 2);
  for (let i = ctxStart; i < start; i++) {
    result.push({ type: 'context', content: bLines[i] });
  }

  // Removed lines
  for (let i = start; i <= bEnd; i++) {
    result.push({ type: 'removed', content: bLines[i] });
  }

  // Added lines
  for (let i = start; i <= aEnd; i++) {
    result.push({ type: 'added', content: aLines[i] });
  }

  // 2 lines of context after
  for (let i = bEnd + 1; i <= Math.min(bLines.length - 1, bEnd + 2); i++) {
    result.push({ type: 'context', content: bLines[i] });
  }

  return result;
}

interface DiffPreviewProps {
  changes: VisibilityChange[];
  applying: boolean;
  error: string | null;
  onApply: () => void;
  onCancel: () => void;
  /**
   * When true the diff shows a change that has ALREADY been written
   * (e.g. MCP copy/move applies server-side and returns before/after),
   * so only a single close button is rendered instead of the misleading
   * Apply/Cancel pair.
   */
  resultMode?: boolean;
}

export function DiffPreview({ changes, applying, error, onApply, onCancel, resultMode = false }: DiffPreviewProps) {
  if (changes.length === 0) return null;

  const hasProjectFile = changes.some((c) => c.isProjectFile);

  return (
    <div className="diff-preview">
      {hasProjectFile && (
        <div className="diff-preview-git-warn" role="alert">
          ⚠ 이 파일은 git에서 관리됩니다 — 변경 전 확인하세요.
        </div>
      )}

      {changes.map((change, i) => {
        const diffLines = computeDiffLines(change.before, change.after);
        const hasChange = diffLines.some((l) => l.type !== 'context');

        return (
          <div key={i} className="diff-preview-file">
            <div className="diff-preview-filepath">{change.filePath}</div>
            {hasChange ? (
              <pre className="diff-preview-code">
                {diffLines.map((line, j) => (
                  <div
                    key={j}
                    className={`diff-line diff-line--${line.type}`}
                  >
                    <span className="diff-line-prefix">
                      {line.type === 'removed' ? '−' : line.type === 'added' ? '+' : ' '}
                    </span>
                    <span className="diff-line-content">{line.content}</span>
                  </div>
                ))}
              </pre>
            ) : (
              <p className="diff-preview-nochange">변경 없음</p>
            )}
          </div>
        );
      })}

      {error && <div className="diff-preview-error">{error}</div>}

      <div className="diff-preview-actions">
        {resultMode ? (
          <>
            <button
              type="button"
              className="kv2-btn kv2-btn--primary kv2-btn--small"
              onClick={onCancel}
            >
              확인
            </button>
            <span className="diff-preview-hint">이미 적용된 변경입니다 — 새 세션에서 반영됩니다.</span>
          </>
        ) : (
          <>
            <button
              type="button"
              className="kv2-btn kv2-btn--danger kv2-btn--small"
              onClick={onApply}
              disabled={applying}
            >
              {applying ? '적용 중...' : 'Apply'}
            </button>
            <button
              type="button"
              className="kv2-btn kv2-btn--ghost kv2-btn--small"
              onClick={onCancel}
              disabled={applying}
            >
              Cancel
            </button>
            <span className="diff-preview-hint">새 세션에서 반영됩니다.</span>
          </>
        )}
      </div>
    </div>
  );
}
