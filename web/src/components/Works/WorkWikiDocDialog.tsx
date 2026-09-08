import { useEffect, useState } from 'react';
import { DialogSkeleton } from '../Card/DialogSkeleton';
import { CardMarkdown } from '../Card/CardMarkdown';
import { fetchWikiDoc, fetchWikiStatus } from '../../hooks/useWikiApi';
import './Works.css';

interface WorkWikiDocDialogProps {
  /** Vault-relative path, as listed in `WorkDetailResponse.wikiDocPaths`. */
  docPath: string;
  onClose: () => void;
}

/** Join the absolute vault dir with the vault-relative doc path (no double slash). */
function absoluteDocPath(vaultDir: string, docPath: string): string {
  return `${vaultDir.replace(/\/+$/, '')}/${docPath.replace(/^\/+/, '')}`;
}

/** Obsidian deep link that opens the generated note by absolute file path. */
function obsidianUri(vaultDir: string, docPath: string): string {
  return `obsidian://open?path=${encodeURIComponent(absoluteDocPath(vaultDir, docPath))}`;
}

type DocState =
  | { status: 'loading' }
  | { status: 'loaded'; content: string }
  | { status: 'error'; message: string };

/**
 * A Work's wiki document, opened from the archived Work's Wiki directory section.
 *
 * The Wiki tab reaches the same document through `WikiCardDialog`, but that
 * dialog is built around a *card* (its wiki decision, run, topics). A Work
 * lists documents by path with no card in hand — the archive sweep may have
 * produced one document from many cards — so this reads the document alone:
 * `GET /api/wiki/doc` for the content, `GET /api/wiki/status` for the vault
 * directory the Obsidian deep link needs. Nested inside the detail dialog like
 * the other Work sub-dialogs, so it stacks above it.
 */
export function WorkWikiDocDialog({ docPath, onClose }: WorkWikiDocDialogProps) {
  const [doc, setDoc] = useState<DocState>({ status: 'loading' });
  const [vaultDir, setVaultDir] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setDoc({ status: 'loading' });
    fetchWikiDoc(docPath)
      .then((content) => { if (!cancelled) setDoc({ status: 'loaded', content }); })
      .catch((err: unknown) => {
        if (!cancelled) {
          setDoc({ status: 'error', message: err instanceof Error ? err.message : '문서를 불러오지 못했습니다' });
        }
      });
    // The vault dir is only for the Obsidian link; a failure just hides it.
    fetchWikiStatus()
      .then((status) => { if (!cancelled) setVaultDir(status.vaultDir ?? null); })
      .catch(() => { /* no deep link */ });
    return () => { cancelled = true; };
  }, [docPath]);

  const copyPath = async () => {
    try {
      await navigator.clipboard.writeText(vaultDir ? absoluteDocPath(vaultDir, docPath) : docPath);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable — ignore */
    }
  };

  return (
    <DialogSkeleton
      title="Wiki 문서"
      onClose={onClose}
      width="960px"
      className="work-wiki-doc-dialog"
      persistSizeKey="work-wiki-doc"
      defaultSize={{ width: 960, height: 820 }}
    >
      <div className="work-wiki-doc">
        <div className="kv2-meta-card work-wiki-doc-path-card">
          <span className="kv2-meta-label">문서 경로</span>
          <code className="works-mono work-wiki-doc-path" title={vaultDir ? absoluteDocPath(vaultDir, docPath) : docPath}>
            {docPath}
          </code>
          <div className="work-wiki-doc-actions">
            {vaultDir && (
              <a
                className="kv2-btn kv2-btn--primary kv2-btn--small"
                href={obsidianUri(vaultDir, docPath)}
                title="Obsidian 앱에서 이 문서를 엽니다"
              >
                Obsidian에서 열기
              </a>
            )}
            <button type="button" className="kv2-btn kv2-btn--outline kv2-btn--small" onClick={() => { void copyPath(); }}>
              {copied ? '복사됨 ✓' : '경로 복사'}
            </button>
          </div>
        </div>
        <section className="work-wiki-doc-body" aria-label="문서 내용">
          {doc.status === 'loading' ? (
            <p className="work-wiki-doc-muted">문서를 불러오는 중…</p>
          ) : doc.status === 'error' ? (
            <p className="work-wiki-doc-muted">⚠ {doc.message}</p>
          ) : (
            <CardMarkdown text={doc.content} />
          )}
        </section>
      </div>
      <div className="kv2-dialog-footer work-resolve-footer">
        <div className="kv2-actions-split">
          <div className="kv2-actions-primary">
            <button type="button" className="kv2-btn kv2-btn--outline" onClick={onClose}>닫기</button>
          </div>
        </div>
      </div>
    </DialogSkeleton>
  );
}
