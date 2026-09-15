import React, { useState } from 'react';
import {
  MAX_REFERENCES,
  renderReferenceBlock,
  type MentionKind,
  type MentionToken,
  type ResolvedReference,
} from '../../../../src/core/mention-reference';

/**
 * References 스트립 — 본문에 박힌 토큰의 **렌더**다.
 *
 * 여기에는 참조 state가 없다. 칩은 `tokens`(본문 파싱 결과)에서 나오고 라벨만
 * `references`(서버 해석)에서 채운다. 그래서 해석이 늦어도 칩은 선택 즉시 뜨고,
 * 사용자가 본문에서 토큰을 지우면 칩도 같은 렌더에 사라진다. `×`가 하는 일도
 * 칩을 지우는 게 아니라 **본문에서 토큰을 지우는 것**이다.
 */

const KIND_ICON: Record<MentionKind, string> = {
  session: '🧵',
  work: '🗂',
  doc: '📄',
};

/** 참조가 덜 실려 나가는 상태 — 칩을 앰버로 돌린다. */
function degradeReason(reference: ResolvedReference | undefined): string | null {
  if (!reference) return null;
  if (reference.unresolved === 'not_found') return '대상을 찾을 수 없습니다 — 이 참조는 전달되지 않습니다';
  if (reference.unresolved === 'ambiguous') return 'ID 접두사가 여러 세션에 걸립니다 — 더 긴 접두사를 쓰세요';
  if (reference.transcriptMissing) return 'transcript 없음 — 메타데이터만 전달됩니다';
  if (reference.workSessions?.some((session) => session.transcriptMissing)) {
    return '일부 세션의 transcript가 없습니다 — 그 세션은 메타데이터만 전달됩니다';
  }
  return null;
}

interface MentionChipsProps {
  tokens: MentionToken[];
  references: ResolvedReference[];
  loading: boolean;
  onRemove: (raw: string) => void;
  disabled?: boolean;
}

export const MentionChips: React.FC<MentionChipsProps> = ({
  tokens,
  references,
  loading,
  onRemove,
  disabled,
}) => {
  const [previewOpen, setPreviewOpen] = useState(false);

  if (tokens.length === 0) return null;

  const byRaw = new Map(references.map((reference) => [reference.raw, reference]));
  const overLimit = tokens.length > MAX_REFERENCES;

  return (
    <div className="kv2-ref-strip">
      <div className="kv2-ref-strip-head">
        <span>References</span>
        <span className={`kv2-ref-strip-count${overLimit ? ' is-over-limit' : ''}`}>
          {overLimit ? `${tokens.length} / 최대 ${MAX_REFERENCES}` : tokens.length}
        </span>
        <span className="kv2-ref-strip-spacer" />
        <button
          type="button"
          className="kv2-ref-strip-toggle"
          onClick={() => setPreviewOpen((open) => !open)}
          aria-expanded={previewOpen}
        >
          전송 프롬프트 미리보기 {previewOpen ? '▾' : '▸'}
        </button>
      </div>

      <div className="kv2-ref-chips">
        {tokens.map((token) => {
          const reference = byRaw.get(token.raw);
          const degraded = degradeReason(reference);
          const kindClass = degraded ? 'kv2-ref-kind-unresolved' : `kv2-ref-kind-${token.kind}`;
          const label = reference?.title
            ?? (loading ? '해석 중…' : token.id);
          return (
            <span
              key={token.raw}
              className={`kv2-ref-chip ${kindClass}`}
              title={degraded ?? reference?.title ?? token.raw}
            >
              <span className="kv2-ref-chip-icon" aria-hidden="true">
                {degraded ? '⚠' : KIND_ICON[token.kind]}
              </span>
              <span className="kv2-ref-chip-token">{token.raw.slice(1)}</span>
              <span className="kv2-ref-chip-label">{degraded ?? label}</span>
              <button
                type="button"
                className="kv2-ref-chip-remove"
                onClick={() => onRemove(token.raw)}
                disabled={disabled}
                aria-label={`${token.raw} 참조 제거`}
                title="본문에서 이 토큰을 지웁니다"
              >
                ×
              </button>
            </span>
          );
        })}
      </div>

      {overLimit && (
        <p className="kv2-ref-strip-note">
          참조는 {MAX_REFERENCES}개까지만 전달됩니다. 뒤쪽 {tokens.length - MAX_REFERENCES}개는
          블록에서 잘립니다.
        </p>
      )}

      {previewOpen && (
        // 본문 끝에 실제로 붙을 문자열 그대로. 렌더러는 서버·에이전트가 읽는
        // 것과 같은 core 구현이라 미리보기와 전송분이 어긋날 수 없다.
        <pre className="kv2-ref-preview">
          {renderReferenceBlock(references) || '해석된 참조가 아직 없습니다.'}
        </pre>
      )}
    </div>
  );
};
