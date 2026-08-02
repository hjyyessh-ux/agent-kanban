import { useEffect, useState } from 'react';
import type { KanbanCard } from '../../../../src/core/types';
import { DialogSkeleton } from '../Card/DialogSkeleton';
import { CardMarkdown } from '../Card/CardMarkdown';
import { fetchWikiDoc } from '../../hooks/useWikiApi';

interface WikiCardDialogProps {
  card: KanbanCard;
  /** Absolute vault directory (from worker status) used to build the Obsidian deep link. */
  vaultDir: string;
  busy: boolean;
  onReprocess: (cardId: string) => void;
  onClose: () => void;
}

function formatDate(iso?: string): string {
  return iso ? iso.slice(0, 10) : '—';
}

function formatRun(w?: KanbanCard['wiki']): string {
  if (!w?.route && !w?.model && !w?.effort) return '—';
  const route = w?.route === 'codex' ? 'Codex' : w?.route === 'claude' ? 'Claude' : 'LLM';
  const model = w?.model ?? 'model';
  return `${route} · ${model}${w?.effort ? ` · ${w.effort}` : ''}`;
}

/** Join the absolute vault dir with the vault-relative doc path (no double slash). */
function absoluteDocPath(vaultDir: string, docPath: string): string {
  const base = vaultDir.replace(/\/+$/, '');
  const rel = docPath.replace(/^\/+/, '');
  return `${base}/${rel}`;
}

/** Obsidian deep link that opens the generated note by absolute file path. */
function obsidianUri(vaultDir: string, docPath: string): string {
  return `obsidian://open?path=${encodeURIComponent(absoluteDocPath(vaultDir, docPath))}`;
}

export function WikiCardDialog({ card, vaultDir, busy, onReprocess, onClose }: WikiCardDialogProps) {
  const w = card.wiki;
  const kept = w?.decision === 'kept';
  const docPath = kept ? w?.docPath : undefined;
  const [copied, setCopied] = useState<string | null>(null);
  const [docCollapsed, setDocCollapsed] = useState(false);
  const [doc, setDoc] = useState<{ status: 'loading' | 'loaded' | 'error'; content: string }>({
    status: 'loading',
    content: '',
  });

  // Fetch the actual generated wiki document (not the original card content).
  useEffect(() => {
    if (!docPath) return;
    let cancelled = false;
    setDoc({ status: 'loading', content: '' });
    fetchWikiDoc(docPath)
      .then((content) => { if (!cancelled) setDoc({ status: 'loaded', content }); })
      .catch((err) => {
        if (!cancelled) {
          setDoc({ status: 'error', content: err instanceof Error ? err.message : '문서를 불러오지 못했습니다' });
        }
      });
    return () => { cancelled = true; };
  }, [docPath]);

  const copy = async (value: string, key: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(key);
      window.setTimeout(() => setCopied((c) => (c === key ? null : c)), 1500);
    } catch {
      /* clipboard unavailable — ignore */
    }
  };

  const stateVariant = !w
    ? 'none'
    : w.status === 'failed'
      ? 'failed'
      : w.status === 'pending'
        ? 'pending'
        : w.decision === 'skipped'
          ? 'skipped'
          : 'kept';
  const stateLabel = !w
    ? 'UNPROCESSED'
    : w.status === 'failed'
      ? 'FAILED'
      : w.status === 'pending'
        ? 'PENDING'
        : w.decision === 'skipped'
          ? 'SKIPPED'
          : 'KEPT';

  // Kept cards take the document-type accent/badge; others fall back to state.
  const accentModifier = kept && w?.docType ? `type-${w.docType}` : stateVariant;

  return (
    <DialogSkeleton
      onClose={onClose}
      width="860px"
      className={`kv2-dialog--detail wiki-detail-dialog wiki-detail-dialog--${accentModifier}`}
      persistSizeKey="wiki-card-dialog"
    >
      <div className="kv2-detail-shell">
        {/* Hero status row — the document type takes the lead badge (left). */}
        <div className="kv2-status-row kv2-status-row--hero">
          {kept && w?.docType ? (
            <span className={`kv2-status-badge wiki-type-badge--${w.docType}`}>{w.docType}</span>
          ) : (
            <span className={`kv2-status-badge wiki-state-badge wiki-state-badge--${stateVariant}`}>
              {stateLabel}
            </span>
          )}
          <div className="kv2-status-row-meta">
            <button
              type="button"
              className="kv2-dialog-close"
              onClick={onClose}
              aria-label="Close dialog"
            >
              ×
            </button>
          </div>
        </div>

        {/* Title + meta band */}
        <section className="kv2-detail-overview">
          <div className="kv2-title-row">
            <div className="kv2-title-block">
              <h2 className="kv2-title-text">{w?.docTitle ?? card.title}</h2>
            </div>
          </div>

          <div className="kv2-meta-band">
            <div className="wiki-meta-row">
              <div className="kv2-meta-card">
                <span className="kv2-meta-label">분류</span>
                <span className="kv2-meta-value">{w?.docType ?? '—'}</span>
              </div>
              <div className="kv2-meta-card">
                <span className="kv2-meta-label">상태</span>
                <span className="kv2-meta-value">{stateLabel}</span>
              </div>
              <div className="kv2-meta-card">
                <span className="kv2-meta-label">처리일</span>
                <span className="kv2-meta-value">{formatDate(w?.processedAt)}</span>
              </div>
              <div className="kv2-meta-card">
                <span className="kv2-meta-label">프롬프트</span>
                <span className="kv2-meta-value">
                  {typeof w?.promptVersion === 'number' ? `v${w.promptVersion}` : '—'}
                </span>
              </div>
              <div className="kv2-meta-card">
                <span className="kv2-meta-label">실행</span>
                <span className="kv2-meta-value" title={formatRun(w)}>{formatRun(w)}</span>
              </div>
            </div>
          </div>
        </section>

        {/* Wiki-specific blocks (generated doc / skip / fail / pending) — 48px-aligned */}
        <div className="wiki-detail-blocks">
          {kept && w?.docPath && (
            <div className="kv2-meta-card wiki-doc-card">
              <span className="kv2-meta-label">생성된 문서</span>
              <code className="wiki-meta-path" title={absoluteDocPath(vaultDir, w.docPath)}>
                {w.docPath}
              </code>
              <div className="wiki-detail-btnrow">
                <a
                  className="kv2-btn kv2-btn--primary wiki-doc-btn"
                  href={obsidianUri(vaultDir, w.docPath)}
                  title="Obsidian 앱에서 이 문서를 엽니다"
                >
                  Obsidian에서 열기
                </a>
                <button
                  type="button"
                  className="kv2-btn kv2-btn--outline wiki-doc-btn"
                  onClick={() => { void copy(absoluteDocPath(vaultDir, w.docPath!), 'path'); }}
                >
                  {copied === 'path' ? '복사됨 ✓' : '경로 복사'}
                </button>
              </div>
              {(w.topics?.length ?? 0) > 0 && (
                <div className="wiki-topics wiki-topics--detail">
                  {w.topics!.map((tp) => <span key={tp} className="wiki-topic">#{tp}</span>)}
                </div>
              )}
            </div>
          )}

          {w?.decision === 'skipped' && w.skipReason && (
            <div className="kv2-meta-card wiki-doc-card">
              <span className="kv2-meta-label">건너뛴 이유</span>
              <p className="wiki-meta-text">{w.skipReason}</p>
            </div>
          )}

          {w?.status === 'failed' && w.error && (
            <div className="kv2-meta-card wiki-doc-card wiki-doc-card--error">
              <span className="kv2-meta-label">
                오류
                <button
                  type="button"
                  className="kv2-btn kv2-btn--outline wiki-doc-btn"
                  onClick={() => { void copy(w.error!, 'err'); }}
                >
                  {copied === 'err' ? '복사됨 ✓' : '복사'}
                </button>
              </span>
              <pre className="wiki-meta-error">{w.error}</pre>
            </div>
          )}

          {w?.status === 'pending' && (
            <div className="kv2-meta-card wiki-doc-card">
              <span className="wiki-meta-text wiki-meta-text--muted">처리 대기 중…</span>
            </div>
          )}
        </div>

        {/* Generated document content — reuses the task detail's phase cell styling */}
        {kept && docPath && (
          <div className="kv2-detail-layout">
            <div className="kv2-detail-main">
              <section className="kv2-detail-primary-block">
                <div className="kv2-phase-stack">
                  <div className="kv2-phase-card-wrapper">
                    <div className="kv2-phase-header kv2-phase-header--outer">
                      <div><span>문서 내용</span></div>
                      <div className="kv2-phase-header-actions">
                        <button
                          type="button"
                          className="kv2-phase-action"
                          onClick={() => setDocCollapsed((c) => !c)}
                          aria-expanded={!docCollapsed}
                        >
                          {docCollapsed ? 'show ▾' : 'hide ▴'}
                        </button>
                      </div>
                    </div>
                    <section className="kv2-phase kv2-phase--prompt">
                      <div
                        className={`kv2-phase-content kv2-phase-content--markdown ${
                          docCollapsed ? 'kv2-phase-content--collapsed' : 'kv2-phase-content--expanded'
                        }`}
                      >
                        {doc.status === 'loading' ? (
                          <span className="wiki-meta-text wiki-meta-text--muted">문서를 불러오는 중…</span>
                        ) : doc.status === 'error' ? (
                          <span className="wiki-meta-text wiki-meta-text--muted">{doc.content}</span>
                        ) : (
                          <CardMarkdown text={doc.content} />
                        )}
                      </div>
                    </section>
                  </div>
                </div>
              </section>
            </div>
          </div>
        )}

        {/* Footer actions */}
        <div className="kv2-dialog-actions kv2-dialog-actions--detail">
          <div className="kv2-dialog-actions-rail">
            <button type="button" className="kv2-btn kv2-btn--outline kv2-action-cancel" onClick={onClose}>
              닫기
            </button>
            <div className="kv2-dialog-actions-group kv2-dialog-actions-group--detail-priority">
              <button
                type="button"
                className="kv2-btn kv2-btn--primary kv2-btn--primary-strong"
                onClick={() => onReprocess(card.id)}
                disabled={busy || w?.status === 'pending'}
                title={w?.status === 'pending'
                  ? '이미 처리 대기 중입니다'
                  : '이 카드를 위키 분류 파이프라인에 다시 넣어 문서를 재생성합니다'}
              >
                ↻ 다시 처리
              </button>
            </div>
          </div>
        </div>
      </div>
    </DialogSkeleton>
  );
}
