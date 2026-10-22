import React, { useRef, useState } from 'react';
import type { KanbanCard } from '../../../../src/core/types';
import { deleteScreenshot, getScreenshotUrl, uploadScreenshot } from '../../hooks/useKanbanApi';

/** `[Feedback for: …]` 헤더는 그대로 두고 본문만 바꾼 description. */
export function joinFeedbackPrompt(header: string, body: string): string {
  const trimmed = body.trim();
  return header ? `${header}\n\n${trimmed}` : trimmed;
}

function imageFiles(files: Iterable<File | null>): File[] {
  return [...files].filter((file): file is File => file !== null && file.type.startsWith('image/'));
}

/**
 * 대기 중(todo) turn의 Prompt를 세션 창 안에서 고친다 — `Create Feedback`(실행
 * 안 함)으로 만든 turn을 카드 상세로 나가지 않고 다듬은 뒤 `▶ 지금 실행`.
 *
 * 본문만 편집한다: 피드백 헤더(`[Feedback for: …]` + `---`)는 접혀 있던 그대로
 * 앞에 다시 붙는다. 이미지는 카드 상세와 같은 screenshots API로 바로 올리고
 * 지우며(붙여넣기 · `＋ 이미지` · ×), 저장 버튼과 무관하게 즉시 반영된다.
 */
export const SessionTurnEditor: React.FC<{
  card: KanbanCard;
  header: string;
  body: string;
  onSave: (cardId: string, description: string) => Promise<void>;
  onScreenshotsChanged: () => void;
  onPreviewImage: (url: string) => void;
  onClose: () => void;
}> = ({ card, header, body, onSave, onScreenshotsChanged, onPreviewImage, onClose }) => {
  const [draft, setDraft] = useState(body);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const screenshots = card.screenshots ?? [];

  const upload = async (files: File[]) => {
    if (files.length === 0) return;
    setError(null);
    setUploading(files.length);
    let failed = 0;
    for (const file of files) {
      try {
        await uploadScreenshot(card.id, file);
      } catch {
        failed += 1;
      }
    }
    setUploading(0);
    if (failed > 0) setError(`이미지 ${failed}개를 올리지 못했습니다`);
    onScreenshotsChanged();
  };

  const remove = (screenshotId: string) => {
    setError(null);
    deleteScreenshot(card.id, screenshotId)
      .then(onScreenshotsChanged)
      .catch(() => setError('이미지를 지우지 못했습니다'));
  };

  const save = () => {
    if (!draft.trim() || saving) return;
    const description = joinFeedbackPrompt(header, draft);
    if (description === (card.description ?? '')) {
      onClose();
      return;
    }
    setSaving(true);
    setError(null);
    onSave(card.id, description)
      .then(onClose)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : '저장하지 못했습니다'))
      .finally(() => setSaving(false));
  };

  return (
    <div
      className="session-turn-editor"
      data-highlight-skip
      onDragOver={(event) => event.preventDefault()}
      onDrop={(event) => {
        event.preventDefault();
        void upload(imageFiles(Array.from(event.dataTransfer.files)));
      }}
    >
      <textarea
        className="kv2-textarea session-turn-editor-input"
        aria-label="Prompt 편집"
        value={draft}
        rows={Math.min(14, Math.max(4, draft.split('\n').length + 1))}
        autoFocus
        disabled={saving}
        onChange={(event) => setDraft(event.target.value)}
        onPaste={(event) => {
          const files = imageFiles(Array.from(event.clipboardData?.items ?? [])
            .filter((item) => item.kind === 'file')
            .map((item) => item.getAsFile()));
          if (files.length === 0) return;
          event.preventDefault();
          void upload(files);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            // 편집만 취소한다 — DialogSkeleton이 Escape를 "창 닫기"로 읽지 않게.
            event.stopPropagation();
            onClose();
          } else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            save();
          }
        }}
      />

      <div className="session-turn-editor-shots" aria-label={`첨부 이미지 (${screenshots.length})`}>
        {screenshots.map((shot) => (
          <span key={shot.id} className="session-turn-editor-shot">
            <button
              type="button"
              className="session-conversation-shot"
              onClick={() => onPreviewImage(getScreenshotUrl(shot.filename))}
              title={shot.originalName || shot.filename}
            >
              <img src={getScreenshotUrl(shot.filename)} alt={shot.originalName || shot.filename} />
            </button>
            <button
              type="button"
              className="session-turn-editor-shotRemove"
              aria-label={`${shot.originalName || shot.filename} 삭제`}
              title="이미지 삭제"
              onClick={() => remove(shot.id)}
            >
              ×
            </button>
          </span>
        ))}
        <button
          type="button"
          className="kv2-btn kv2-btn--small kv2-btn--outline session-turn-editor-add"
          disabled={uploading > 0}
          onClick={() => fileRef.current?.click()}
        >
          {uploading > 0 ? `올리는 중… (${uploading})` : '＋ 이미지'}
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          multiple
          hidden
          onChange={(event) => {
            void upload(imageFiles(Array.from(event.target.files ?? [])));
            event.target.value = '';
          }}
        />
      </div>

      <div className="session-turn-editor-actions">
        <span className="session-turn-editor-hint">이미지는 붙여넣기·드래그로도 추가 · ⌘/Ctrl+Enter 저장 · Esc 취소</span>
        {error && <span className="session-conversation-startError" role="alert">⚠ {error}</span>}
        <button type="button" className="kv2-btn kv2-btn--small kv2-btn--ghost" disabled={saving} onClick={onClose}>
          취소
        </button>
        <button
          type="button"
          className="kv2-btn kv2-btn--small kv2-btn--primary"
          disabled={saving || !draft.trim()}
          onClick={save}
        >
          {saving ? '저장 중…' : '저장'}
        </button>
      </div>
    </div>
  );
};
