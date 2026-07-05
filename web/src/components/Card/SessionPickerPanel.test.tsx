import { describe, expect, test } from "bun:test";
import type { SessionInfo } from "../../hooks/useKanbanApi";
import { isSessionResumeCandidate } from "./SessionPickerPanel";

function makeSession(overrides: Partial<SessionInfo>): SessionInfo {
  return {
    sessionId: "session-1",
    cardTitle: "Card title",
    cardId: "card-1",
    cardStatus: "todo",
    updatedAt: "2026-05-31T00:00:00.000Z",
    ...overrides,
  };
}

describe("isSessionResumeCandidate", () => {
  test("allows todo, in-progress, and complete linked cards", () => {
    expect(isSessionResumeCandidate(makeSession({ cardStatus: "todo" }), "current-card")).toBe(true);
    expect(isSessionResumeCandidate(makeSession({ cardStatus: "in_progress" }), "current-card")).toBe(true);
    expect(isSessionResumeCandidate(makeSession({ cardStatus: "complete" }), "current-card")).toBe(true);
    expect(isSessionResumeCandidate(makeSession({ cardStatus: "done" }), "current-card")).toBe(false);
    expect(isSessionResumeCandidate(makeSession({ cardStatus: "untracked" }), "current-card")).toBe(false);
  });

  test("excludes the current card and subagent-only sessions", () => {
    expect(isSessionResumeCandidate(makeSession({ cardId: "current-card" }), "current-card")).toBe(false);
    expect(isSessionResumeCandidate(makeSession({ isSubagentOnly: true }), "current-card")).toBe(false);
  });
});
