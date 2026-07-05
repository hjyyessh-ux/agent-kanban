import React, { useRef, useState, useCallback } from "react";
import { Screenshot } from "../../../../src/core/types";
import { getScreenshotUrl, uploadScreenshot, deleteScreenshot } from "../../hooks/useKanbanApi";

interface ScreenshotPanelProps {
  cardId: string;
  screenshots?: Screenshot[];
  onScreenshotUploaded?: (screenshot: Screenshot) => void;
  onScreenshotDeleted?: (screenshotId: string) => void;
}

export const ScreenshotPanel: React.FC<ScreenshotPanelProps> = ({
  cardId,
  screenshots,
  onScreenshotUploaded,
  onScreenshotDeleted,
}) => {
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [uploadProgress, setUploadProgress] = useState<string>("");
  const [lightboxImg, setLightboxImg] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const dropZoneRef = useRef<HTMLDivElement>(null);

  const uploadFiles = useCallback(
    async (files: File[]) => {
      const imageFiles = files.filter((file) => file.type.startsWith("image/"));
      if (imageFiles.length === 0) return;

      setUploading(true);
      setError(null);
      const failedUploads: string[] = [];

      for (let i = 0; i < imageFiles.length; i++) {
        setUploadProgress(`Uploading ${i + 1}/${imageFiles.length}...`);
        try {
          const screenshot = await uploadScreenshot(cardId, imageFiles[i]);
          if (onScreenshotUploaded) onScreenshotUploaded(screenshot);
        } catch {
          failedUploads.push(imageFiles[i]?.name || `image ${i + 1}`);
        }
      }

      setUploadProgress("");
      setUploading(false);

      if (failedUploads.length > 0) {
        setError(
          failedUploads.length === 1
            ? `Failed to upload ${failedUploads[0]}`
            : `Failed to upload ${failedUploads.length} screenshots`
        );
      }
    },
    [cardId, onScreenshotUploaded]
  );

  const handleScreenshotUpload = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      await uploadFiles(Array.from(e.target.files || []));
      if (fileInputRef.current) fileInputRef.current.value = "";
    },
    [uploadFiles]
  );

  const handleScreenshotDelete = useCallback(
    async (screenshotId: string) => {
      setError(null);
      try {
        await deleteScreenshot(cardId, screenshotId);
        if (onScreenshotDeleted) onScreenshotDeleted(screenshotId);
      } catch {
        setError("Failed to delete screenshot");
      }
    },
    [cardId, onScreenshotDeleted]
  );

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
    setIsDragging(false);
  }, []);

  const handleDrop = useCallback(
    async (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setIsDragging(false);

      await uploadFiles(Array.from(e.dataTransfer.files || []));
    },
    [uploadFiles]
  );

  const handleClickDropZone = useCallback(() => {
    if (uploading) return;
    fileInputRef.current?.click();
  }, [uploading]);

  return (
    <>
      <div className="kv2-screenshot-panel">
        <div className="kv2-screenshot-header">
          <span className="kv2-screenshot-label">
            Screenshots {screenshots && screenshots.length > 0 ? `(${screenshots.length})` : ""}
          </span>
        </div>
        {error && <div className="kv2-screenshot-error">{error}</div>}
        {uploadProgress && <div className="kv2-create-upload-progress">{uploadProgress}</div>}
        {screenshots && screenshots.length > 0 && (
          <div className="kv2-screenshot-grid">
            {screenshots.map((ss) => (
              <div key={ss.id} className="kv2-screenshot-item">
                <button
                  type="button"
                  className="kv2-screenshot-thumb-btn"
                  onClick={() => setLightboxImg(getScreenshotUrl(ss.filename))}
                >
                  <img
                    src={getScreenshotUrl(ss.filename)}
                    alt={ss.originalName || ss.filename}
                    className="kv2-screenshot-thumb"
                  />
                </button>
                <div className="kv2-screenshot-meta">
                  <span className="kv2-screenshot-name" title={ss.originalName}>
                    {ss.originalName || ss.filename}
                  </span>
                  <button
                    type="button"
                    className="kv2-screenshot-delete"
                    onClick={() => handleScreenshotDelete(ss.id)}
                    title="Delete screenshot"
                  >
                    ×
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
        <div
          ref={dropZoneRef}
          className={`kv2-screenshot-grid kv2-screenshot-grid--empty kv2-screenshot-grid--upload-target ${isDragging ? 'kv2-screenshot-grid--dragging' : ''}`}
          onClick={handleClickDropZone}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          role="button"
          tabIndex={0}
          title="Click to upload or drag and drop screenshots"
        >
          {isDragging && <span className="kv2-screenshot-drop-hint">이미지를 놓으면 업로드됩니다.</span>}
          {uploading ? "Uploading..." : "Click or drop screenshots"}
        </div>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          multiple
          onChange={handleScreenshotUpload}
          disabled={uploading}
          style={{ display: "none" }}
        />
      </div>

      {lightboxImg && (
        <div className="kv2-screenshot-lightbox" onClick={() => setLightboxImg(null)} aria-hidden="true">
          <img src={lightboxImg} alt="Screenshot preview" className="kv2-screenshot-lightbox-img" />
          <button
            type="button"
            className="kv2-screenshot-lightbox-close"
            onClick={() => setLightboxImg(null)}
          >
            ×
          </button>
        </div>
      )}
    </>
  );
};
