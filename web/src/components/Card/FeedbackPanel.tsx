import React, { useCallback, useEffect, useState } from "react";

interface FeedbackPanelProps {
  cardId: string;
  isSubmittingFeedback: boolean;
  setIsSubmittingFeedback: (val: boolean) => void;
  onCreateFeedback: (cardId: string, feedback: string, shouldDispatch: boolean, screenshots?: File[]) => Promise<void>;
  onClose: () => void;
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
}) => {
  const [feedbackText, setFeedbackText] = useState("");
  const [pendingImages, setPendingImages] = useState<PendingImage[]>([]);

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
      await onCreateFeedback(
        cardId,
        feedbackText.trim(),
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
      <textarea
        className="kv2-input kv2-feedback-textarea"
        value={feedbackText}
        onChange={(e) => setFeedbackText(e.target.value)}
        onPaste={handlePaste}
        placeholder="Describe what needs additional work... (스크린샷은 붙여넣기로 첨부할 수 있습니다)"
        rows={4}
        disabled={isSubmittingFeedback}
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
