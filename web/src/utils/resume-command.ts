import type { AgentRuntime } from "../../../src/core/types";

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\"'\"'")}'`;
}

export function buildResumeCommand(
  runtime: AgentRuntime | undefined,
  sessionId: string,
  projectDir?: string,
): string {
  const quotedSessionId = shellQuote(sessionId);
  const resumeCommand = runtime === "codex"
    ? `codex resume ${quotedSessionId}`
    : runtime === "claude"
      ? `claude --resume ${quotedSessionId}`
      : `opencode session ${quotedSessionId}`;

  const cwd = projectDir?.trim();
  if (!cwd) return resumeCommand;

  return `cd ${shellQuote(cwd)} && ${resumeCommand}`;
}
