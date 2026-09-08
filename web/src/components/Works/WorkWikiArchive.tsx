import { useState } from 'react';
import { useWorkWikiConfig } from '../../hooks/useWorkWikiConfig';

/** The durable location of a completed Work, independent of its live cards. */
export function WorkWikiArchive({ docPaths, pending, loading, error, onOpenDoc }: {
  docPaths: string[];
  pending: boolean;
  loading?: boolean;
  error?: string | null;
  onOpenDoc: (path: string) => void;
}) {
  const wiki = useWorkWikiConfig();
  const [copyNotice, setCopyNotice] = useState<string | null>(null);
  const vaultDir = wiki.config?.vaultDir.trim();

  return <section className="kv2-detail-primary-block work-detail-section work-wiki-archive" aria-label="보관된 Work의 Wiki">
    <div className="kv2-panel-heading work-detail-heading">
      <span className="kv2-session-title">Wiki 디렉토리</span>
      <span className="kv2-badge">보관됨</span>
    </div>
    <div className="kv2-meta-card work-meta-card work-meta-card--wiki">
      {vaultDir ? <>
        <code className="works-mono work-wiki-archive-path">{vaultDir}</code>
        <div className="work-wiki-doc-actions">
          <button type="button" className="kv2-btn kv2-btn--small kv2-btn--outline" onClick={async () => {
            try {
              await navigator.clipboard.writeText(vaultDir);
              setCopyNotice('디렉토리 경로를 복사했습니다.');
            } catch {
              setCopyNotice('경로를 복사하지 못했습니다. 위 경로를 직접 선택해 복사해 주세요.');
            }
          }}>디렉토리 경로 복사</button>
        </div>
      </> : <p className="kv2-session-helper">{wiki.loading ? 'Wiki 디렉토리를 확인하는 중…'
        : wiki.error ?? 'Wiki 디렉토리가 설정되지 않았습니다. Wiki 화면에서 저장 위치를 설정하세요.'}</p>}
      {copyNotice && <p role="status" className="kv2-session-helper">{copyNotice}</p>}
    </div>
    {wiki.config && !wiki.config.enabled && <p className="kv2-session-helper">Wiki 자동 정리가 꺼져 있습니다. Wiki 화면에서 켜면 보관한 카드의 문서를 생성합니다.</p>}
    {docPaths.length > 0 && <ul className="work-detail-fact work-detail-wiki">
      {docPaths.map(path => <li key={path}>
        <button type="button" className="kv2-unstyled-button works-mono work-detail-wiki-doc"
          title={`${path} — 클릭해서 문서 보기`} onClick={() => onOpenDoc(path)}>{path}</button>
      </li>)}
    </ul>}
    {error ? <p role="alert">Wiki 문서 목록을 불러오지 못했습니다: {error}</p>
      : loading ? <p className="work-detail-fact" role="status">문서 목록을 확인하는 중…</p>
        : pending ? <p className="work-detail-fact" role="status">Wiki 문서 생성 대기 중</p>
          : docPaths.length === 0 && <p className="work-detail-fact">아직 생성된 Wiki 문서가 없습니다.</p>}
  </section>;
}
