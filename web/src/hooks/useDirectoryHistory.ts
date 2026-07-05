import { useCallback, useState } from "react";

export const DIR_HISTORY_KEY = "kanban-dir-history";
const DIR_HISTORY_MAX = 10;

function readDirectoryHistory(): string[] {
  try {
    const stored = localStorage.getItem(DIR_HISTORY_KEY);
    if (!stored) return [];
    const parsed = JSON.parse(stored);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
  } catch {
    return [];
  }
}

function writeDirectoryHistory(entries: string[]): void {
  try {
    localStorage.setItem(DIR_HISTORY_KEY, JSON.stringify(entries));
  } catch {
    return;
  }
}

export function useDirectoryHistory() {
  const [dirHistory, setDirHistory] = useState<string[]>(readDirectoryHistory);

  const saveDirToHistory = useCallback((dir: string) => {
    const trimmed = dir.trim();
    if (!trimmed) return;
    setDirHistory((current) => {
      const updated = [trimmed, ...current.filter((entry) => entry !== trimmed)].slice(0, DIR_HISTORY_MAX);
      writeDirectoryHistory(updated);
      return updated;
    });
  }, []);

  const clearDirHistory = useCallback(() => {
    setDirHistory([]);
    try {
      localStorage.removeItem(DIR_HISTORY_KEY);
    } catch {
      return;
    }
  }, []);

  return {
    dirHistory,
    saveDirToHistory,
    clearDirHistory,
  };
}
