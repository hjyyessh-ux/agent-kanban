import React, { useMemo, useState } from 'react';
import {
  parseMentionTokens,
  parseReferenceBlock,
  type MentionKind,
} from '../../../../src/core/mention-reference';

/**
 * 저장된 프롬프트의 References 스트립 — 읽기 전용.
 *
 * `MentionChips`가 "지금 본문이 보낼 것"의 렌더라면, 이쪽은 "이미 보낸 것"의
 * 렌더다. 칩은 **저장된 블록**에서 읽는다(네트워크 없음): 에이전트가 실제로
 * 받은 스냅샷이 곧 진실이고, 그 뒤 대상이 바뀌었더라도 이 카드에 실린 내용은
 * 그대로이기 때문이다.
 *
 * 본문에는 토큰이 있는데 블록에 없는 참조(블록 도입 전 편집 등)는 앰버 칩으로
 * "전달되지 않음"을 알린다 — 보이는 토큰과 보낸 블록이 어긋난 상태를 숨기지 않는다.
 */

const KIND_ICON: Record<MentionKind, string> = {
  session: '🧵',
  work: '🗂',
  doc: '📄',
  skill: '🧩',
};

interface SavedChip {
  key: string;
  kind: MentionKind;
  id: string;
  label: string;
  meta?: string;
  warning?: string;
}

function shortId(kind: MentionKind, id: string): string {
  // 칩은 좁다 — 세션/Work id는 8자 접두사로 충분히 식별된다. doc은 경로라 그대로.
  return kind === 'doc' ? id : id.slice(0, 8);
}

export function buildSavedChips(body: string, block: string): SavedChip[] {
  const chips: SavedChip[] = parseReferenceBlock(block).map((entry) => {
    let warning: string | undefined;
    if (entry.unresolved === 'not_found') warning = '저장 당시 대상을 찾지 못해 메타데이터 없이 전달됨';
    else if (entry.unresolved === 'ambiguous') warning = '저장 당시 ID 접두사가 여러 항목에 걸려 전달되지 않음';
    else if (entry.unresolved === 'unavailable') warning = '저장 당시 이 세션에서 쓸 수 없는 스킬이라 호출되지 않음';
    else if (entry.transcriptMissing) warning = 'transcript 없음 — 메타데이터만 전달됨';
    return {
      key: entry.key,
      kind: entry.kind,
      id: entry.id,
      label: entry.title || entry.id,
      meta: entry.meta,
      warning,
    };
  });

  const sent = new Set(chips.map((chip) => chip.key));
  for (const token of parseMentionTokens(body)) {
    const key = `${token.kind}:${token.id}`;
    if (sent.has(key)) continue;
    sent.add(key);
    chips.push({
      key,
      kind: token.kind,
      id: token.id,
      label: token.id,
      warning: '참조 블록에 없음 — 에이전트에게 전달되지 않음',
    });
  }
  return chips;
}

interface SavedReferencesProps {
  /** 사람이 쓴 본문 (블록 제외). */
  body: string;
  /** 저장된 참조 블록 원문 (`splitReferenceBlock().block`). */
  block: string;
}

export const SavedReferences: React.FC<SavedReferencesProps> = ({ body, block }) => {
  const [blockOpen, setBlockOpen] = useState(false);
  const chips = useMemo(() => buildSavedChips(body, block), [body, block]);

  if (chips.length === 0) return null;

  return (
    <div className="kv2-ref-strip kv2-ref-strip--saved" data-highlight-skip>
      <div className="kv2-ref-strip-head">
        <span>References</span>
        <span className="kv2-ref-strip-count">{chips.length}</span>
        <span className="kv2-ref-strip-spacer" />
        {block && (
          <button
            type="button"
            className="kv2-ref-strip-toggle"
            onClick={() => setBlockOpen((open) => !open)}
            aria-expanded={blockOpen}
          >
            {blockOpen ? '전송된 참조 블록 숨기기 ▾' : '전송된 참조 블록 보기 ▸'}
          </button>
        )}
      </div>

      <div className="kv2-ref-chips">
        {chips.map((chip) => (
          <span
            key={chip.key}
            className={`kv2-ref-chip ${chip.warning ? 'kv2-ref-kind-unresolved' : `kv2-ref-kind-${chip.kind}`}`}
            title={chip.warning ?? `${chip.kind}:${chip.id}`}
          >
            <span className="kv2-ref-chip-icon" aria-hidden="true">
              {chip.warning ? '⚠' : KIND_ICON[chip.kind]}
            </span>
            <span className="kv2-ref-chip-token">{`${chip.kind}:${shortId(chip.kind, chip.id)}`}</span>
            <span className="kv2-ref-chip-label">{chip.label}</span>
            {chip.meta && <span className="kv2-ref-chip-meta">{chip.meta}</span>}
          </span>
        ))}
      </div>

      {blockOpen && <pre className="kv2-ref-preview">{block}</pre>}
    </div>
  );
};
