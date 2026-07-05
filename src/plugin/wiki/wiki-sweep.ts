import type { KanbanStore } from '../../core/store';
import { WIKI_INTERNAL_MARKER } from './wiki-prompts';

/**
 * Soft-delete any active board cards that carry the wiki-internal sentinel.
 *
 * The wiki worker runs codex/claude one-shots whose prompts begin with
 * `WIKI_INTERNAL_MARKER`. `chat-message.ts` now skips card creation for those
 * prompts, but cards minted before that guard existed are still sitting on the
 * board (title + description both contain the marker). This sweep cleans them
 * up so they:
 *   - disappear from the main board (`getCards` filters `isActiveCard`)
 *   - never archive (`archiveCards` filters `isActiveCard`), so they never get
 *     stamped `wiki.status = 'pending'` — no feedback loop back into the wiki
 *     processing queue (`getWikiPendingCards` also filters `isActiveCard`)
 *
 * Idempotent: once swept, no active card matches and it returns 0. Runs on
 * every boot path that owns the store — both the opencode plugin and the
 * standalone daemon — mirroring `seedDefaultSettings`.
 *
 * Returns the number of cards soft-deleted this pass.
 */
export async function sweepWikiInternalCards(store: KanbanStore): Promise<number> {
  const cards = await store.getCards();
  const ids = cards
    .filter(
      (c) =>
        (c.description?.includes(WIKI_INTERNAL_MARKER) ?? false) ||
        (c.title?.includes(WIKI_INTERNAL_MARKER) ?? false),
    )
    .map((c) => c.id);
  if (ids.length === 0) return 0;
  return store.softDeleteCards(ids);
}
