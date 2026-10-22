/**
 * Feedback drafts survive the dialog that holds them.
 *
 * Closing a session/card dialog by accident (backdrop click, Esc, ✕) used to
 * throw away a long feedback in progress. The text is kept in localStorage so
 * it also survives a reload; pasted screenshots are `File`s, which localStorage
 * cannot hold, so they are kept in memory for the life of the page.
 *
 * A draft is cleared only when the feedback is actually submitted (or the user
 * clears it explicitly).
 */

const TEXT_PREFIX = 'kanban-feedback-draft:';

const imageDrafts = new Map<string, File[]>();

function storage(): Storage | null {
  return typeof localStorage === 'undefined' ? null : localStorage;
}

export function readDraftText(key: string): string {
  return storage()?.getItem(TEXT_PREFIX + key) ?? '';
}

export function writeDraftText(key: string, text: string): void {
  const store = storage();
  if (!store) return;
  try {
    if (text.trim()) store.setItem(TEXT_PREFIX + key, text);
    else store.removeItem(TEXT_PREFIX + key);
  } catch {
    // Quota exceeded — the in-memory textarea still holds the text.
  }
}

export function readDraftImages(key: string): File[] {
  return imageDrafts.get(key) ?? [];
}

export function writeDraftImages(key: string, files: File[]): void {
  if (files.length > 0) imageDrafts.set(key, files);
  else imageDrafts.delete(key);
}

export function clearDraft(key: string): void {
  writeDraftText(key, '');
  imageDrafts.delete(key);
}
