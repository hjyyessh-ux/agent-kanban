import React, { useCallback, useEffect, useState } from "react";
import { appendReferenceBlock, type ResolvedReference } from "../../../../src/core/mention-reference";
import { resolveReferencesForSubmit } from "../../hooks/useMentionReferences";
import { MentionTextarea } from "../Mention/MentionTextarea";

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
}

interface PendingImage {
  file: File;
  url: string;
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
}) => {
  const [feedbackText, setFeedbackText] = useState("");
  const [pendingImages, setPendingImages] = useState<PendingImage[]>([]);
  /** 본문에 박힌 `@` 토큰의 해석 결과. 제출 직전 블록으로 바뀐다. */
  const [resolvedRefs, setResolvedRefs] = useState<ResolvedReference[]>([]);

  // 컴포넌트가 사라질 때 남아 있는 object URL을 정리한다.
  useEffect(() => {
    return () => {
      pendingImages.forEach((image) => URL.revokeObjectURL(image.url));
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handlePaste = useCallback((e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const imageFiles = Array.from(e.clipboardData?.items ?? [])
      .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
      .map((item) => item.getAsFile())
      .filter((file): file is File => file !== null);

    // 이미지가 없으면 기본 동작(텍스트 붙여넣기)에 맡긴다.
    if (imageFiles.length === 0) return;

    e.preventDefault();
    setPendingImages((prev) => [
      ...prev,
      ...imageFiles.map((file) => ({ file, url: URL.createObjectURL(file) })),
    ]);
  }, []);

  const removePendingImage = useCallback((url: string) => {
    setPendingImages((prev) => {
      const target = prev.find((image) => image.url === url);
      if (target) URL.revokeObjectURL(target.url);
      return prev.filter((image) => image.url !== url);
    });
  }, []);

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
      setFeedbackText("");
      pendingImages.forEach((image) => URL.revokeObjectURL(image.url));
      setPendingImages([]);
      onClose();
    } finally {
      setIsSubmittingFeedback(false);
    }
  };

  return (
    <div className="kv2-feedback-panel">
      <div className="kv2-feedback-header">
        <div className="kv2-feedback-title">Feedback</div>
      </div>
      <MentionTextarea
        className="kv2-input kv2-feedback-textarea"
        value={feedbackText}
        onChange={setFeedbackText}
        // 클립보드 스크린샷 첨부는 이 통과에 걸려 있다 — 빼면 조용히 죽는다.
        onPaste={handlePaste}
        placeholder="Describe what needs additional work... (@로 세션·Work·문서를 참조할 수 있고, 스크린샷은 붙여넣기로 첨부합니다)"
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
              <img src={image.url} alt={image.file.name} className="kv2-screenshot-thumb" />
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
    </div>
  );
};
