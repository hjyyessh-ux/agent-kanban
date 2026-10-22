import React, { useCallback, useEffect, useRef, useState } from "react";
import { appendReferenceBlock, type ResolvedReference } from "../../../../src/core/mention-reference";
import { resolveReferencesForSubmit } from "../../hooks/useMentionReferences";
import { MentionTextarea } from "../Mention/MentionTextarea";
import { ImageLightbox } from "../shared/ImageLightbox";
import { clearDraft, readDraftImages, readDraftText, writeDraftImages, writeDraftText } from "./feedbackDraft";

interface FeedbackPanelProps {
  cardId: string;
  isSubmittingFeedback: boolean;
  setIsSubmittingFeedback: (val: boolean) => void;
  onCreateFeedback: (cardId: string, feedback: string, shouldDispatch: boolean, screenshots?: File[]) => Promise<void>;
  onClose: () => void;
  /** 대상 카드의 프로젝트 — `@` 후보에서 같은 디렉토리가 먼저 온다. */
  projectDir?: string;
  /**
   * 자기 참조로 막을 세션 — 피드백 대상 카드 자신의 세션이다. 자기 transcript를
   * 자기 프롬프트에 넣는 건 항상 무의미하고 재귀적으로 커진다.
   */
  excludeSessionIds?: string[];
  /** 팝오버가 넘지 말아야 할 경계. 두 호출부 모두 다이얼로그 안이다. */
  boundarySelector?: string;
  /**
   * 초안 저장 키. 다이얼로그를 닫아도 작성 중인 내용이 남는다. 세션 모달은
   * 세션 단위로 넘긴다 — 새 turn이 끝나 피드백 대상 카드가 바뀌어도 초안은 그대로다.
   */
  draftKey?: string;
  /** 제목 옆에 붙는 "어디에 이어붙는가" 표시. */
  targetLabel?: React.ReactNode;
}

interface PendingImage {
  file: File;
  url: string;
}

function toPending(files: File[]): PendingImage[] {
  return files.map((file) => ({ file, url: URL.createObjectURL(file) }));
}

function imageFilesOf(files: Iterable<File>): File[] {
  return Array.from(files).filter((file) => file.type.startsWith("image/"));
}

export const FeedbackPanel: React.FC<FeedbackPanelProps> = ({
  cardId,
  isSubmittingFeedback,
  setIsSubmittingFeedback,
  onCreateFeedback,
  onClose,
  projectDir,
  excludeSessionIds,
  boundarySelector = ".kv2-dialog",
  draftKey,
  targetLabel,
}) => {
  const storageKey = draftKey ?? `card:${cardId}`;
  const [feedbackText, setFeedbackText] = useState(() => readDraftText(storageKey));
  const [pendingImages, setPendingImages] = useState<PendingImage[]>(() => toPending(readDraftImages(storageKey)));
  /** 본문에 박힌 `@` 토큰의 해석 결과. 제출 직전 블록으로 바뀐다. */
  const [resolvedRefs, setResolvedRefs] = useState<ResolvedReference[]>([]);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const pendingRef = useRef(pendingImages);
  pendingRef.current = pendingImages;
  const loadedKeyRef = useRef(storageKey);

  // 같은 다이얼로그가 다른 카드로 바뀌면 그 카드의 초안을 불러온다.
  useEffect(() => {
    if (loadedKeyRef.current === storageKey) return;
    loadedKeyRef.current = storageKey;
    pendingRef.current.forEach((image) => URL.revokeObjectURL(image.url));
    setFeedbackText(readDraftText(storageKey));
    setPendingImages(toPending(readDraftImages(storageKey)));
  }, [storageKey]);

  // 컴포넌트가 사라질 때 object URL만 정리한다 — 파일 자체는 초안에 남는다.
  useEffect(() => {
    return () => {
      pendingRef.current.forEach((image) => URL.revokeObjectURL(image.url));
    };
  }, []);

  const updateText = useCallback((text: string) => {
    setFeedbackText(text);
    writeDraftText(loadedKeyRef.current, text);
  }, []);

  const updateImages = useCallback((update: (prev: PendingImage[]) => PendingImage[]) => {
    setPendingImages((prev) => {
      const next = update(prev);
      writeDraftImages(loadedKeyRef.current, next.map((image) => image.file));
      return next;
    });
  }, []);

  const addImages = useCallback((files: File[]) => {
    if (files.length === 0) return;
    updateImages((prev) => [...prev, ...toPending(files)]);
  }, [updateImages]);

  const handlePaste = useCallback((e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const imageFiles = Array.from(e.clipboardData?.items ?? [])
      .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
      .map((item) => item.getAsFile())
      .filter((file): file is File => file !== null);

    // 이미지가 없으면 기본 동작(텍스트 붙여넣기)에 맡긴다.
    if (imageFiles.length === 0) return;

    e.preventDefault();
    addImages(imageFiles);
  }, [addImages]);

  const removePendingImage = useCallback((url: string) => {
    URL.revokeObjectURL(url);
    updateImages((prev) => prev.filter((image) => image.url !== url));
  }, [updateImages]);

  const discardDraft = () => {
    pendingImages.forEach((image) => URL.revokeObjectURL(image.url));
    setFeedbackText("");
    setPendingImages([]);
    clearDraft(storageKey);
  };

  const handleFeedbackSubmit = async (shouldDispatch: boolean) => {
    if (!feedbackText.trim() || isSubmittingFeedback) return;
    setIsSubmittingFeedback(true);
    try {
      // 디바운스된 해석을 기다리지 않는다 — 참조를 고르자마자 보내면 사람이 이긴다.
      const submitRefs = await resolveReferencesForSubmit(feedbackText, resolvedRefs);
      await onCreateFeedback(
        cardId,
        // 참조 블록은 여기서 붙는다. `App.handleCreateFeedback`은 받은 문자열을
        // `[Feedback for: …]` 헤더 뒤 본문 자리에 그대로 넣을 뿐이라 무변경이다.
        appendReferenceBlock(feedbackText.trim(), submitRefs),
        shouldDispatch,
        pendingImages.map((image) => image.file)
      );
      // 제출이 성공했을 때만 초안을 지운다 — 실패하면 그대로 남아 다시 보낼 수 있다.
      discardDraft();
      onClose();
    } finally {
      setIsSubmittingFeedback(false);
    }
  };

  const hasDraft = feedbackText.trim().length > 0 || pendingImages.length > 0;

  return (
    <div
      className={`kv2-feedback-panel${isDragging ? " kv2-feedback-panel--dragging" : ""}`}
      onDragOver={(e) => {
        if (!Array.from(e.dataTransfer.types).includes("Files")) return;
        e.preventDefault();
        setIsDragging(true);
      }}
      onDragLeave={(e) => {
        if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
        setIsDragging(false);
      }}
      onDrop={(e) => {
        const files = imageFilesOf(e.dataTransfer.files ?? []);
        setIsDragging(false);
        if (files.length === 0) return;
        e.preventDefault();
        addImages(files);
      }}
    >
      <div className="kv2-feedback-header">
        <div className="kv2-feedback-title">Feedback</div>
        {targetLabel && <span className="kv2-feedback-target">{targetLabel}</span>}
        {hasDraft && (
          <span className="kv2-feedback-draft">
            임시 저장됨 — 닫아도 유지
            <button type="button" className="kv2-feedback-draft-clear" onClick={discardDraft} disabled={isSubmittingFeedback}>
              비우기
            </button>
          </span>
        )}
      </div>
      <MentionTextarea
        className="kv2-input kv2-feedback-textarea"
        value={feedbackText}
        onChange={updateText}
        // 클립보드 스크린샷 첨부는 이 통과에 걸려 있다 — 빼면 조용히 죽는다.
        onPaste={handlePaste}
        placeholder="Describe what needs additional work... (@로 세션·Work·문서를 참조할 수 있습니다)"
        rows={4}
        disabled={isSubmittingFeedback}
        boundarySelector={boundarySelector}
        projectDir={projectDir}
        excludeSessionIds={excludeSessionIds}
        onReferencesChange={setResolvedRefs}
      />
      {pendingImages.length > 0 && (
        <div className="kv2-screenshot-grid kv2-feedback-screenshots">
          {pendingImages.map((image) => (
            <div key={image.url} className="kv2-screenshot-item">
              <button
                type="button"
                className="kv2-screenshot-thumb-btn"
                onClick={() => setPreviewUrl(image.url)}
                title="크게 보기"
              >
                <img src={image.url} alt={image.file.name} className="kv2-screenshot-thumb" />
              </button>
              <div className="kv2-screenshot-meta">
                <span className="kv2-screenshot-name" title={image.file.name}>
                  {image.file.name || "pasted image"}
                </span>
                <button
                  type="button"
                  className="kv2-screenshot-delete"
                  onClick={() => removePendingImage(image.url)}
                  disabled={isSubmittingFeedback}
                  title="Remove screenshot"
                >
                  ×
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
      <div className="kv2-feedback-actions">
        <button
          type="button"
          className="kv2-btn kv2-btn--ghost kv2-feedback-attach"
          onClick={() => fileInputRef.current?.click()}
          disabled={isSubmittingFeedback}
        >
          📎 스크린샷 {pendingImages.length > 0 ? `${pendingImages.length}` : "첨부"}
        </button>
        <span className="kv2-feedback-attach-hint">붙여넣기(⌘V) · 끌어놓기도 됩니다</span>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          multiple
          hidden
          onChange={(e) => {
            addImages(imageFilesOf(e.target.files ?? []));
            e.target.value = "";
          }}
        />
        <button
          type="button"
          className="kv2-btn kv2-btn--outline"
          onClick={() => handleFeedbackSubmit(false)}
          disabled={isSubmittingFeedback || !feedbackText.trim()}
        >
          CREATE FEEDBACK
        </button>
        <button
          type="button"
          className="kv2-btn kv2-btn--primary"
          onClick={() => handleFeedbackSubmit(true)}
          disabled={isSubmittingFeedback || !feedbackText.trim()}
        >
          CREATE & START
        </button>
      </div>
      {previewUrl && <ImageLightbox src={previewUrl} alt="Pasted screenshot" onClose={() => setPreviewUrl(null)} />}
    </div>
  );
};
