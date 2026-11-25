import { z } from 'zod';
import type { KanbanStore } from '../core/store';
import { matchesWikiArchiveStatus } from '../core/store';
import type { WorkStore } from '../core/work-store';
import { CARD_SEMANTIC_SEARCH_PATH, CARD_SEMANTIC_SETTINGS_PATH } from '../core/card-semantic';
import { parseSemanticConfig, type CardSemanticSearch } from '../plugin/card-semantic-search';
import { DEFAULT_BOARD_FILTERS, filterBoardCards, filterUnreadOnly } from '../../web/src/components/Board/board-filters';
import { indexWorksBySession, filterCardsByWork, resolveWorkFilter } from '../../web/src/components/Board/board-works';
import { readCappedBody } from './board-history-routes';

const requestSchema = z.object({
  query: z.string().trim().min(1).max(2_048),
  scope: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('board'), filter: z.record(z.string(), z.string().max(1_024)).optional(),
      work: z.string().max(128).optional(), unread: z.boolean().optional(), grouped: z.boolean().optional() }),
    z.object({ kind: z.literal('work'), id: z.string().min(1).max(128) }),
    z.object({ kind: z.literal('archive'), status: z.enum(['all', 'unprocessed', 'kept', 'skipped', 'failed', 'pending']) }),
  ]),
});

async function scopedCards(scope: z.infer<typeof requestSchema>['scope'], store: KanbanStore, works: WorkStore | undefined,
  signal: AbortSignal, service: CardSemanticSearch) {
  return store.readBoardSnapshot(async () => {
    const cards = await service.projectedCards(scope.kind, signal);
    if (!cards) return null;
    if (scope.kind === 'work' || scope.kind === 'archive') {
      const allowed = new Set<string>();
      if (scope.kind === 'work') {
        const work = await works?.getWork(scope.id);
        if (!work) return [];
        for (const { sessionId } of work.sessionLinks) allowed.add(sessionId);
        if (!allowed.size) return [];
      }
      const matches = (card: Awaited<ReturnType<KanbanStore['getCards']>>[number]) =>
        !card.deletedAt && !card.parentCardId && (scope.kind === 'work'
          ? card.sessionId && allowed.has(card.sessionId)
          : matchesWikiArchiveStatus(card, scope.status));
      return cards.filter(matches);
    }
    const filters = { ...DEFAULT_BOARD_FILTERS, ...scope.filter, search: '' };
    let visible = filterBoardCards(cards, filters);
    if (scope.work && works) {
      const workList = (await works.getWorks()).filter(work => work.status === 'active' && !work.archivedAt);
      const filter = resolveWorkFilter(scope.work === 'unassigned' ? 'unassigned' : { workId: scope.work }, workList);
      if (filter === 'all') return [];
      visible = filterCardsByWork(visible, filter, indexWorksBySession(workList));
    }
    return scope.unread ? filterUnreadOnly(visible, { groupBySession: scope.grouped ?? false }) : visible;
  });
}

export async function handleCardSemanticRoute(options: {
  req: Request; path: string; service?: CardSemanticSearch; store: KanbanStore; workStore?: WorkStore;
  json(value: unknown, status?: number): Response; error(message: string, status: number): Response;
}): Promise<Response> {
  const { req, path, service, store, workStore, json, error } = options;
  if (!service) return error('Semantic search unavailable', 503);
  if (path === CARD_SEMANTIC_SETTINGS_PATH && req.method === 'GET') return json(await service.status());
  if (path === `${CARD_SEMANTIC_SETTINGS_PATH}/retry`) {
    if (req.method !== 'POST') return error('Method not allowed', 405);
    await service.retry();
    return json(await service.status());
  }
  if ((path === CARD_SEMANTIC_SEARCH_PATH && req.method !== 'POST') ||
    (path === CARD_SEMANTIC_SETTINGS_PATH && req.method !== 'PUT')) return error('Method not allowed', 405);
  const body = await readCappedBody(req, 65_536);
  if (body === null) return error('Request too large', 413);
  let input: unknown;
  try { input = JSON.parse(body); }
  catch { return error('Invalid JSON', 400); }
  if (path === CARD_SEMANTIC_SETTINGS_PATH) {
    const config = parseSemanticConfig(input);
    if (!config) return error('Provide at least one approved absolute directory to enable card search', 400);
    await service.configure(config);
    return json(await service.status());
  }
  const result = requestSchema.safeParse(input);
  if (!result.success) return error('Invalid card search', 400);
  return json(await service.search(result.data.query, (signal) => scopedCards(result.data.scope, store, workStore, signal, service), req.signal, result.data.scope.kind, true));
}
