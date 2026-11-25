import { combineCardSearch, type CardSemanticHit, type CardSemanticResult } from '../../../../src/core/card-semantic';

export function CardSemanticNotice({ result }: { result: CardSemanticResult | null }) {
  if (!result || result.status === 'off' || result.status === 'ready') return null;
  const message = {
    preparing: '의미 검색을 준비 중입니다.',
    failed: '의미 검색을 불러오지 못했습니다.',
    timeout: '의미 검색 응답 시간이 지났습니다.',
  }[result.status];
  return <p role="status">{message}</p>;
}

export function CardSemanticResults({ keyword, result, open }: {
  keyword: CardSemanticHit[];
  result: CardSemanticResult;
  open(hit: CardSemanticHit): void;
}) {
  const existing = new Set(keyword.map(hit => hit.id));
  const added = combineCardSearch(keyword, result).filter(hit => !existing.has(hit.id));
  if (!added.length) return null;
  return <section className="kv2-section">
    <h3>추가 카드 검색 결과</h3>
    <ol aria-label="추가 카드 검색 결과">{added.map(hit => (
      <li key={hit.id}>
        <button className="kv2-btn kv2-btn--ghost" type="button" onClick={() => open(hit)}>{hit.title}</button>
      </li>
    ))}</ol>
  </section>;
}
