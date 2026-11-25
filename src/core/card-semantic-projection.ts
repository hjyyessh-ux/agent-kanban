import type { KanbanCard } from './types';
import { cardEmbeddingInput, type IndexPolicy } from './card-semantic-index';
import { exactReferenceKeys } from './card-semantic';

export type ProjectedSearchCard = KanbanCard & {
  searchProjection: { inputHash: string | null; exactKeys: string[]; archiveKeys: string[] };
};

/** Only fields used by scope predicates, result display and exact matching. */
export function projectSearchCard(card: KanbanCard, policy: IndexPolicy): ProjectedSearchCard {
  const input = cardEmbeddingInput(card, policy);
  const common = input ? exactReferenceKeys([card.title, card.description].join(' ')) : [];
  return {
    id: card.id, title: card.title, description: '', sessionId: card.sessionId, sessionTitle: card.sessionTitle,
    projectDir: card.projectDir, status: String(card.status) === 'opencode_complete' ? 'complete' : card.status,
    createdAt: card.createdAt, updatedAt: card.updatedAt, startedAt: card.startedAt, completedAt: card.completedAt,
    deletedAt: card.deletedAt, parentCardId: card.parentCardId, completedSeenAt: card.completedSeenAt,
    wiki: card.wiki ? { status: card.wiki.status, decision: card.wiki.decision } as KanbanCard['wiki'] : undefined,
    agentRuntime: card.agentRuntime ?? 'opencode',
    searchProjection: {
      inputHash: input ? Bun.CryptoHasher.hash('sha256', input, 'hex') : null,
      exactKeys: input ? [...new Set([...common, ...exactReferenceKeys([card.progressSummary, card.result].join(' '))])] : [],
      archiveKeys: input ? [...new Set([...common, ...exactReferenceKeys([card.projectDir, card.sessionTitle].join(' '))])] : [],
    },
  };
}

export const MAX_PROJECTED_CARDS = 20_000;
export const MAX_PROJECTED_BYTES = 12 * 1024 * 1024;

export function boundedSearchProjection(original: Iterable<KanbanCard>, policy: IndexPolicy,
  maximumCards: number, maximumBytes: number) {
  const cards: ProjectedSearchCard[] = [];
  let bytes = 0;
  for (const card of original) {
    if (card.deletedAt) continue;
    if (cards.length >= maximumCards) return null;
    const projected = projectSearchCard(card, policy);
    bytes += Buffer.byteLength(JSON.stringify(projected));
    if (bytes > maximumBytes) return null;
    cards.push(projected);
  }
  return { cards, bytes };
}
