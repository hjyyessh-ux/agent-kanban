import type { Hooks, PluginInput } from '@opencode-ai/plugin';
import type { Part } from '@opencode-ai/sdk';
import type { KanbanStore } from '../../core/store';
import { appendRuntimeDebugLog } from '../debug-log';
import { consumeCommand, isInCommandWindow } from './command-tracker';
import { isDispatched, matchesDispatchedPrompt } from './dispatch-tracker';
import { markSessionActive } from './session-activity-registry';
import { clearSubagentParent, getSubagentParent } from './subagent-parent-registry';
import { normalizeAgentType } from '../../core/agent-type';
import { resolveSessionParentAnchor } from './parent-anchor';
import { WIKI_INTERNAL_MARKER } from '../wiki/wiki-prompts';

function debugLog(msg: string): void {
  appendRuntimeDebugLog('chat.message', { msg });
}

const CLAUDE_PROMPT_DEDUP_WINDOW_MS = 15 * 1000;
const SYSTEM_ONLY_TEXT = /^(?:<\/?(?:system-reminder|analyze-mode|ultrawork-mode|omo-env)>\s*)+$/i;
const COMMAND_GENERATED_PATTERNS = [
  /^<command-instruction>/i,
  /^<user-task>/i,
  /^\[SYSTEM DIRECTIVE: OH-MY-OPENCODE/i,
  /^## Anti-Patterns\b/i,
  /^\*\*Remember: Refactoring without tests is reckless\./i,
  /^## Plan Not Found\b/i,
  /^## Active Work Session Found\b/i,
];

/** Max length for auto-generated card titles */
const MAX_TITLE_LENGTH = 100;

/**
 * Known subagent types that should be linked as subtasks under a parent card.
 * Primary/orchestrator agents (undefined, 'build', 'general', 'Sisyphus', etc.) are NOT subagents.
 * This whitelist approach is safer than a deny-list: if a new subagent type appears,
 * it simply becomes a top-level card until added here — no false parent-linking.
 */
const KNOWN_SUBAGENTS = new Set([
  'explore',
  'librarian',
  'oracle',
  'plan',
  'metis',
  'momus',
  'multimodal-looker',
  'sisyphus-junior',
]);

/**
 * Check if this agent invocation is a subagent (not the primary user-facing agent).
 * Uses a whitelist of known subagent names. Case-insensitive matching to handle
 * variations like 'Sisyphus-Junior' vs 'sisyphus-junior'.
 */
function isSubagent(agent: string | undefined): boolean {
  if (!agent) return false;
  return KNOWN_SUBAGENTS.has(agent.toLowerCase());
}
/**
 * Extract user text from message parts.
 * Only considers text parts — tool calls, files, etc. are ignored.
 */
function extractUserText(parts: Part[]): string {
  return parts
    .filter((p): p is Extract<Part, { type: 'text' }> => p.type === 'text')
    .map((p) => p.text)
    .join('\n')
    .trim();
}

/**
 * Sanitize user text by stripping system prompt markers and instructions.
 *
 * The typical pattern is:
 *   [system-mode-marker]
 *   <system instructions...>
 *   ---
 *   actual user instruction
 *
 * Strategy:
 *  0. Strip bracket-mode instruction blocks (e.g., [search-mode]\n...instructions...)
 *  1. Split on `---` separator, take the last segment (user content)
 *  2. Strip remaining XML-like tags and bracket markers
 *  3. If empty after stripping, fall back to full text with same stripping
 *  4. If still empty, return empty string (caller should skip card creation)
 */
export function sanitizeUserText(raw: string): string {
  // Strip bracket-mode instruction blocks before --- splitting
  let preprocessed = stripBracketModeBlocks(raw);

  // Split on markdown horizontal rule separators (--- on its own line)
  const segments = preprocessed.split(/^---+$/m);
  
  // Take the last segment (most likely the user's actual content)
  let text = segments.length > 1
    ? segments[segments.length - 1]
    : preprocessed;
  
  text = stripSystemMarkers(text);
  
  // If the last segment was empty after stripping, try full text
  if (!text && segments.length > 1) {
    text = stripSystemMarkers(preprocessed);
  }
  
  return text;
}

/**
 * Strip bracket-mode instruction blocks: `[marker]` line + subsequent
 * instructional lines until next `---` separator or EOF.
 * Regex alone is fragile with multiline lookaheads, so use line-based parsing.
 */
export function stripBracketModeBlocks(text: string): string {
  const BRACKET_MARKER = /^\[[-\w\s]+\]\s*$/;
  const HR_SEPARATOR = /^---+$/;

  const lines = text.split('\n');
  const kept: string[] = [];
  let inBlock = false;

  for (const line of lines) {
    if (BRACKET_MARKER.test(line)) {
      inBlock = true;
      continue;
    }
    if (inBlock && HR_SEPARATOR.test(line)) {
      inBlock = false;
      continue;
    }
    if (!inBlock) {
      kept.push(line);
    }
  }

  return kept.join('\n').trim();
}

export function stripSystemMarkers(text: string): string {
  let result = text;
  
  // Remove matched XML-like block tags with content (system instructions)
  // e.g., <ultrawork-mode>...</ultrawork-mode>, <Role>...</Role>
  result = result.replace(/<(Role|Behavior_Instructions|Constraints|Tone_and_Style|Oracle_Usage|Task_Management|CRITICAL_[A-Z_]+|FINAL_[A-Z_]+)>[\s\S]*?<\/\1>/gi, '');
  
  // Remove self-closing or standalone XML-like tags (e.g., <Role>, </Role>)
  result = result.replace(/<\/?[A-Z][A-Za-z_-]*>/g, '');

  result = result.replace(/<\/?(?:system-reminder|analyze-mode|ultrawork-mode|omo-env)>/gi, '');
  
  // Remove HTML comments (e.g., <!-- OMO_INTERNAL_* -->)
  result = result.replace(/<!--[\s\S]*?-->/g, '');
  
  // Remove bracket mode markers on their own line (e.g., [analyze-mode], [CODE RED])
  result = result.replace(/^\[[-\w\s]+\]\s*$/gm, '');
  
  // Collapse multiple blank lines into one
  result = result.replace(/\n{3,}/g, '\n\n');
  
  return result.trim();
}

export function isSystemOnlyText(text: string): boolean {
  return SYSTEM_ONLY_TEXT.test(text.trim());
}

export function isCommandGeneratedPrompt(text: string): boolean {
  const normalized = text.trim();
  if (!normalized) return false;
  return COMMAND_GENERATED_PATTERNS.some(pattern => pattern.test(normalized));
}

/** Truncate text to maxLen, adding ellipsis if needed */
function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen) + '...';
}

/**
 * Creates the `chat.message` hook handler.
 *
 * When a user sends a message, this creates a kanban card with the message
 * text as the description, then immediately moves it to `in_progress`
 * (since the AI is about to work on it).
 *
 * Only processes messages with text parts — tool-only messages are ignored.
 */
export function createChatMessageHook(
  store: KanbanStore,
  input: PluginInput,
): NonNullable<Hooks['chat.message']> {
  return async (hookInput, output) => {
    const { parts } = output;
    const { sessionID, model, agent, messageID } = hookInput;
    debugLog(`HOOK FIRED sid=${sessionID} agent=${String(agent)} model=${model?.modelID ?? 'none'}`);
    markSessionActive(sessionID);

    // Deduplicate by messageId: skip if a card already exists for this exact message.
    // This prevents duplicate cards from retries/replays of the same user message.
    // Uses hookInput.messageID or output.message.id as the unique key.
    const msgId = messageID ?? output.message?.id;
    let allCards: Awaited<ReturnType<typeof store.getCards>> | undefined;
    if (msgId) {
      allCards = await store.getCards();
      const alreadyProcessed = allCards.some(c => c.messageId === msgId);
      if (alreadyProcessed) {
        debugLog(`SKIP dedup msgId=${msgId}`);
        return;
      }
    }

    // Determine agent type early — needed for dispatch-aware session dedup.
    const agentStr = agent ? String(agent) : undefined;
    const normalizedAgentType = normalizeAgentType(agentStr);
    const isSub = isSubagent(normalizedAgentType);

    // Extract and sanitize text from user message parts
    const rawText = extractUserText(parts);
    if (!rawText) {
      debugLog(`SKIP empty rawText`);
      return;
    }

    // Internal wiki worker LLM calls (codex/claude one-shots) carry a sentinel
    // in their prompt. Never turn those into board cards — otherwise they get
    // archived back into the wiki queue, creating a feedback loop.
    if (rawText.includes(WIKI_INTERNAL_MARKER)) {
      debugLog(`SKIP wiki-internal prompt sid=${sessionID}`);
      return;
    }

    const userText = sanitizeUserText(rawText);
    if (!userText) {
      debugLog(`SKIP empty sanitized`);
      return;
    }

    if (isCommandGeneratedPrompt(userText)) {
      debugLog(`SKIP command-generated prompt sid=${sessionID}`);
      return;
    }

    if (isSystemOnlyText(userText)) {
      debugLog(`SKIP system-only sanitized`);
      return;
    }

    if (!allCards) allCards = await store.getCards();

    if (!isSub) {
      const now = Date.now();
      const existingClaudeCard = allCards.find((card) => {
        if (card.parentCardId) return false;
        if (card.sessionId !== sessionID) return false;
        if (card.sourceContext !== 'claude-code') return false;
        if (sanitizeUserText(card.description) !== userText) return false;

        const createdAt = new Date(card.createdAt).getTime();
        return Number.isFinite(createdAt) && now - createdAt < CLAUDE_PROMPT_DEDUP_WINDOW_MS;
      });

      if (existingClaudeCard) {
        debugLog(`SKIP claude-code dedup sid=${sessionID} card=${existingClaudeCard.id}`);
        return;
      }
    }

    const dispatchedCardId = isDispatched(sessionID);
    if (dispatchedCardId) {
      if (!msgId) {
        debugLog(`SKIP dispatch-tracker sid=${sessionID} card=${dispatchedCardId}`);
        return;
      }

      if (matchesDispatchedPrompt(sessionID, rawText) || matchesDispatchedPrompt(sessionID, userText)) {
        debugLog(`SKIP dispatch prompt exact sid=${sessionID} card=${dispatchedCardId}`);
        return;
      }

        const dispatchedCard = allCards.find(c => c.id === dispatchedCardId);
        if (dispatchedCard) {
          const dispatchedPromptSanitized = sanitizeUserText(dispatchedCard.description);
        if (dispatchedPromptSanitized && dispatchedPromptSanitized === userText) {
          debugLog(`SKIP dispatch prompt sanitized sid=${sessionID} card=${dispatchedCardId}`);
          return;
        }
      }
    }

    // Deduplicate dispatched cards: if this session was created by dispatchCard(),
    // a card already exists with no messageId. The dispatch-tracker above handles
    // the fast path; this is a fallback for edge cases (e.g., process restart).
    // Only apply when the current message also has no messageId — that means it's
    // the initial dispatch prompt. Normal user messages (each with a unique messageID)
    // are NOT deduped here — each subsequent message creates its own card.
    if (!isSub && !msgId) {
      const dispatchedForSession = allCards.find(
        c => c.sessionId === sessionID && !c.parentCardId && !c.messageId
      );
      if (dispatchedForSession) {
        debugLog(`SKIP dispatch dedup card=${dispatchedForSession.id} sid=${sessionID}`);
        return;
      }
    }

    if (!isSub && msgId) {
      const existingTelegramFollowUp = allCards.find((card) =>
        card.sessionId === sessionID
        && card.originChannel === 'telegram'
        && card.telegramMessageId
        && sanitizeUserText(card.description) === userText,
      );
      if (existingTelegramFollowUp) {
        debugLog(`SKIP telegram follow-up echo sid=${sessionID} card=${existingTelegramFollowUp.id}`);
        return;
      }
    }

    if (!isSub) {
      const dispatchedPromptCardId = matchesDispatchedPrompt(sessionID, userText);
      if (dispatchedPromptCardId) {
        debugLog(`SKIP dispatch prompt match sid=${sessionID} card=${dispatchedPromptCardId}`);
        return;
      }
    }

    const modelString = model
      ? `${model.providerID}/${model.modelID}`
      : undefined;

    let parentCardId: string | undefined;

    if (isSub) {
      const mappedParent = getSubagentParent(sessionID);
      if (mappedParent) {
        const explicitParent = await store.getCard(mappedParent.parentCardId);
        if (explicitParent) {
          parentCardId = explicitParent.id;
          allCards = await store.getCards();
          debugLog(`SUBAGENT ${agentStr} linked to parent=${parentCardId} (pool=registry)`);
        } else {
          clearSubagentParent(sessionID);
          debugLog(`SUBAGENT ${agentStr} registry stale sid=${sessionID} parent=${mappedParent.parentCardId}`);
        }
      }

      if (!parentCardId) {
      // Find the most recent parent card (not itself a child) to link this subagent card to.
      // Waterfall strategy:
      //   1. Prefer in_progress cards in the same session (strongest signal)
      //   2. Fall back to any non-done card in the same session
      //   3. Fall back to RECENT same-project in_progress cards (cross-session subagent case)
      //      Subagents spawned by dispatched cards run in their OWN sessions,
      //      so same-session matching won't find the parent. We use a 5-minute
      //      recency window to prevent false linking to stale/unrelated cards.
      //   4. Fall back to RECENT same-project non-done cards
        allCards = await store.getCards();
        const notChild = allCards.filter(c => !c.parentCardId);

        const sessionAnchor = resolveSessionParentAnchor(notChild, sessionID);

        // Cross-session fallback:
        // - in_progress cards are always valid parents (actively being worked on),
        //   regardless of when they were created.
        // - For non-in_progress cards, apply a recency window to prevent false linking
        //   to old/unrelated cards from the same project.
        const sameProjectOtherSession = notChild.filter(
          c => c.projectDir === input.directory && c.sessionId !== sessionID
        );
        const sameProjectInProgress = sameProjectOtherSession.filter(c => c.status === 'in_progress');

        const RECENCY_WINDOW_MS = 5 * 60 * 1000;
        const now = Date.now();
        const recentSameProjectActive = sameProjectOtherSession.filter(
          c => c.status !== 'done' && c.status !== 'in_progress'
            && (now - new Date(c.createdAt).getTime()) < RECENCY_WINDOW_MS
        );

        const candidates = sessionAnchor
          ? [sessionAnchor]
          : sameProjectInProgress.length > 0
            ? sameProjectInProgress
            : recentSameProjectActive;
        if (candidates.length > 0) {
          // For cross-session candidates, prefer cards that already have subagent
          // children linked to them (signals an active parent) over newer cards.
          const isCrossSession = !sessionAnchor;
          if (isCrossSession && candidates.length > 1) {
            // Count existing children for each candidate
            const childCounts = new Map<string, number>();
            for (const c of allCards) {
              if (c.parentCardId) {
                childCounts.set(c.parentCardId, (childCounts.get(c.parentCardId) ?? 0) + 1);
              }
            }
            // Prefer candidates with existing children (descending), then oldest first (ascending)
            candidates.sort((a, b) => {
              const aChildren = childCounts.get(a.id) ?? 0;
              const bChildren = childCounts.get(b.id) ?? 0;
              if (bChildren !== aChildren) return bChildren - aChildren;
              return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
            });
          }
          parentCardId = candidates[0].id;
          const pool = sessionAnchor ? 'session+anchor'
            : sameProjectInProgress.length > 0 ? 'project+ip'
            : 'project+active+recent';
          debugLog(`SUBAGENT ${agentStr} linked to parent=${parentCardId} (pool=${pool})`);
        } else {
          debugLog(`SUBAGENT ${agentStr} no parent found sid=${sessionID} dir=${input.directory}`);
        }
      }
    }

    let title: string;

    if (isSub && parentCardId && normalizedAgentType && allCards) {
      // Subagent title: Agent#N format (e.g., Oracle#1, Explore#2)
      // Reuse allCards from parent search to avoid a second store read
      const existingSiblings = allCards.filter(
        c => c.parentCardId === parentCardId && c.agentType?.toLowerCase() === normalizedAgentType
      );
      const agentName = normalizedAgentType.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join('-');
      title = `${agentName}#${existingSiblings.length + 1}`;
    } else {
      title = truncate(userText.split('\n')[0], MAX_TITLE_LENGTH);
    }

    // Create card
    const tracked = consumeCommand(sessionID);

    if (!isSub && !tracked && isInCommandWindow(sessionID)) {
      debugLog(`SKIP command-window dedup sid=${sessionID} msgId=${msgId}`);
      return;
    }

    // Fetch session info for title/createdAt
    let sessionTitle: string | undefined;
    let sessionCreatedAt: string | undefined;
    try {
      const sessionResp = await input.client.session.get({ path: { id: sessionID } });
      if (sessionResp.data) {
        sessionTitle = sessionResp.data.title || undefined;
        if (sessionResp.data.time?.created) {
          sessionCreatedAt = new Date(sessionResp.data.time.created).toISOString();
        }
      }
    } catch {
      // Session info is best-effort — don't block card creation
      debugLog(`WARN session.get failed sid=${sessionID}`);
    }

    const card = await store.createCard({
      title,
      description: userText,
      sessionId: sessionID,
      sessionTitle,
      sessionCreatedAt,
      projectDir: input.directory,
      model: modelString,
      messageId: msgId,
      parentCardId,
      agentType: normalizedAgentType,
      command: tracked?.command,
      sourceContext: tracked ? `${tracked.command} ${tracked.arguments}`.trim() : undefined,
    });
    debugLog(`CREATED card=${card.id} title=${title.slice(0,40)} parent=${parentCardId ?? 'none'} agent=${agentStr ?? 'primary'}`);

    // Immediately move to in_progress — the AI is about to work on it
    await store.updateCard(card.id, { status: 'in_progress' });
  };
}
