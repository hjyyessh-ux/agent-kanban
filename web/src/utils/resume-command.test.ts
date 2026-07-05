import { describe, expect, test } from "bun:test";
import { buildResumeCommand } from "./resume-command";

describe("buildResumeCommand", () => {
  test("builds codex resume command with cwd", () => {
    expect(buildResumeCommand("codex", "session-1", "/tmp/project")).toBe(
      "cd '/tmp/project' && codex resume 'session-1'",
    );
  });

  test("builds claude resume command with cwd", () => {
    expect(buildResumeCommand("claude", "session-2", "/tmp/project")).toBe(
      "cd '/tmp/project' && claude --resume 'session-2'",
    );
  });

  test("quotes embedded single quotes", () => {
    expect(buildResumeCommand("codex", "session'3", "/tmp/it's-here")).toBe(
      "cd '/tmp/it'\"'\"'s-here' && codex resume 'session'\"'\"'3'",
    );
  });
});
