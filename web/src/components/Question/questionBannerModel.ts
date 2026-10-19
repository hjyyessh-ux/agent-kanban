import type { KanbanCard } from '../../../../src/core/types';
import { getPrimaryAgentDisplayLabel } from '../../../../src/core/agent-config';
import { getRuntimeCatalog, resolveAgentRuntime } from '../../../../src/core/runtime-config';

/**
 * Layers that own Escape before the question banner does. They close on their
 * own `document`/element listeners, which fire before the banner's `window`
 * listener; their DOM is still mounted when the banner sees the key, so finding
 * one here means "this press was theirs".
 *
 * `role="listbox"` is deliberately absent: Board columns are permanent
 * listboxes, and matching them would leave the banner unable to ever minimize.
 */
export const OTHER_ESCAPE_LAYER_SELECTOR = [
  '[role="dialog"]',
  '[aria-modal="true"]',
  '[role="menu"]',
  '.kv2-filter-popover',
  '.kv2-meta-dropdown-popover',
  '.kv2-command-popover',
  '.kv2-runtime-popover',
  '.kv2-directory-popover',
].join(', ');

export type QuestionEscapeAction = 'minimize' | 'ignore';

export interface QuestionEscapeInput {
  key: string;
  defaultPrevented: boolean;
  minimized: boolean;
  isSubmitting: boolean;
  /** Another popover/modal (outside the banner) is open and gets the key first. */
  otherLayerOpen: boolean;
}

/**
 * What a key press does to the pending question. Escape can only ever
 * minimize — rejecting an agent's question discards its run, so that stays an
 * explicit button. A press another layer already handled (or will handle) is
 * left alone, so closing a filter popover never touches the banner.
 */
export function resolveQuestionEscape(input: QuestionEscapeInput): QuestionEscapeAction {
  if (input.key !== 'Escape') return 'ignore';
  if (input.defaultPrevented || input.minimized || input.isSubmitting) return 'ignore';
  if (input.otherLayerOpen) return 'ignore';
  return 'minimize';
}

/** Whether an Escape-owning layer other than `banner` is currently mounted. */
export function hasOtherEscapeLayer<T>(
  root: { querySelectorAll: (selector: string) => ArrayLike<T> },
  banner: { contains: (node: T) => boolean } | null,
): boolean {
  return Array.from(root.querySelectorAll(OTHER_ESCAPE_LAYER_SELECTOR))
    .some((el) => !banner || !banner.contains(el));
}

/**
 * The runtime that asked, labelled from the runtime/agent catalogs. A session
 * with no card on the board falls back to the default runtime the same way
 * cards do (`resolveAgentRuntime`). An opencode preset adds its agent name.
 *
 *   claude card            → "Claude"
 *   opencode + sisyphus    → "Opencode · Sisyphus"
 *   unknown session        → "Opencode"
 */
export function questionRuntimeLabel(
  sessionId: string,
  cards: readonly Pick<KanbanCard, 'sessionId' | 'agentRuntime' | 'agentType'>[],
): string {
  const card = cards.find((c) => c.sessionId === sessionId);
  const runtime = resolveAgentRuntime({ agentRuntime: card?.agentRuntime });
  const runtimeLabel = getRuntimeCatalog(runtime).label;
  const preset = runtime === 'opencode' ? getPrimaryAgentDisplayLabel(card?.agentType) : undefined;
  return preset ? `${runtimeLabel} · ${preset}` : runtimeLabel;
}
