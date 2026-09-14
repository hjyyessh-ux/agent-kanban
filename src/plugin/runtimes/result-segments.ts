// Card `result` is a lossless task artifact (see AGENTS.md): every assistant
// text block emitted during a run must survive, not just the last one.
//
// Both CLIs report a "final message" that is only the LAST assistant text —
// `claude --output-format stream-json` in its `result` event, `codex exec -o`
// in the last-message file. A turn that answers, then runs more tools, then
// answers again ("text → tool_use → text") therefore loses its first answer if
// the adapter trusts that final message. Adapters accumulate every text block
// into segments and join them here; the CLI's final message is only a fallback
// for runs that produced no assistant text at all.

export function joinResultSegments(segments: readonly string[]): string {
  return segments
    .map(segment => segment.trim())
    .filter(segment => segment.length > 0)
    .join('\n\n');
}
