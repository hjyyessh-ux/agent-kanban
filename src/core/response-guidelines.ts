import type { SettingsStore } from './settings-store';

/**
 * Common response guidelines — one free-text rule set edited in Settings and
 * delivered to every non-interactive Claude / Codex run (new and resumed).
 *
 * Stored as a plain (unmasked) SettingsStore entry. The dotted key is not a
 * valid environment name, so `buildExecutionEnvironment` never exports it to
 * script runs. An absent or blank value means the feature is OFF.
 *
 * The guideline text is delivery metadata, never part of the user's prompt:
 * `card.description`, `prompt.md` and card titles keep the user's words as-is.
 * This display separation is not a security boundary.
 */
export const RESPONSE_GUIDELINES_SETTING_KEY = 'agent.response_guidelines';
export const RESPONSE_GUIDELINES_MAX_LENGTH = 4000;
export const RESPONSE_GUIDELINES_SUGGESTION =
  '결론 먼저, 혼동되는 용어는 첫 등장에 풀어쓰고, 필요할 때 예시 하나';

const TAG = 'agent-kanban-response-guidelines';

/** Blank (after trim) → '' which callers treat as disabled. */
export function normalizeResponseGuidelines(value: string | undefined | null): string {
  return (value ?? '').replace(/\r\n?/g, '\n').trim();
}

/** Returns an error message, or undefined when the value can be saved. */
export function validateResponseGuidelines(value: string): string | undefined {
  const normalized = normalizeResponseGuidelines(value);
  if (normalized.length > RESPONSE_GUIDELINES_MAX_LENGTH) {
    return `Response guidelines must be at most ${RESPONSE_GUIDELINES_MAX_LENGTH} characters`;
  }
  if (normalized.includes(TAG)) {
    return `Response guidelines must not contain "${TAG}"`;
  }
  return undefined;
}

export async function loadResponseGuidelines(settingsStore: SettingsStore | undefined): Promise<string> {
  if (!settingsStore) return '';
  const entries = await settingsStore.getEntries();
  const raw = normalizeResponseGuidelines(entries.find(e => e.key === RESPONSE_GUIDELINES_SETTING_KEY)?.value);
  // A value that would break the delimiter is treated as disabled rather than
  // delivered half-parsed (the API rejects it; this guards hand-edited files).
  return validateResponseGuidelines(raw) ? '' : raw;
}

function guidelineBlock(text: string, attrs = ''): string {
  return [
    `<${TAG}${attrs}>`,
    'Common response guidelines configured in Agent Kanban Settings. They complement — not replace — your existing user and project instructions.',
    text,
    `</${TAG}>`,
  ].join('\n');
}

/** Claude: value for `--append-system-prompt` (system prompt, rendered fresh per launch). */
export function buildClaudeAppendSystemPrompt(text: string): string {
  return guidelineBlock(text);
}

/**
 * Codex new thread: value for `-c developer_instructions=…`. That key REPLACES
 * any `developer_instructions` from config.toml, so the caller passes the
 * effective existing value as `base` and we append after it.
 */
export function buildCodexDeveloperInstructions(base: string | undefined, text: string): string {
  const existing = (base ?? '').trim();
  return existing ? `${existing}\n\n${guidelineBlock(text)}` : guidelineBlock(text);
}

/**
 * Current Settings text on this request only. No previous-version reset or
 * override instruction; blank means no block is injected.
 */
export function buildCodexGuidelinePrefix(text: string): string {
  return guidelineBlock(text);
}

export function prependGuidelinePrefix(prefix: string, prompt: string): string {
  return `${prefix}\n\n${prompt}`;
}

// Exactly what prependGuidelinePrefix writes: block + one blank line. Nothing
// else is consumed, so leading whitespace of the user's prompt survives.
const LEADING_BLOCK = new RegExp(`^<${TAG}\\b[^>]*>[\\s\\S]*?</${TAG}>\\n\\n`);

/**
 * Remove a leading guideline prefix from a Codex user turn read back from a
 * rollout, so slicing / history / wiki see the user's original words. Only a
 * block at the very start is removed; anything else is left verbatim.
 */
export function stripResponseGuidelinePrefix(text: string): string {
  return LEADING_BLOCK.test(text) ? text.replace(LEADING_BLOCK, '') : text;
}

