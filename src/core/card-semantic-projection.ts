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
