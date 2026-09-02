import type {
  RuntimeCatalogEntry,
  RuntimeCatalogModel,
} from '../../../../src/core/runtime-config';
import type { WikiLlmRoute } from '../../../../src/core/types';

export interface WikiModelGroup {
  route: WikiLlmRoute;
  label: string;
  models: readonly RuntimeCatalogModel[];
}

const WIKI_ROUTES: WikiLlmRoute[] = ['codex', 'claude'];

/** Wiki generation supports the complete Codex and Claude runtime catalogs. */
export function buildWikiModelGroups(runtimes: RuntimeCatalogEntry[]): WikiModelGroup[] {
  return WIKI_ROUTES.flatMap((route) => {
    const runtime = runtimes.find((entry) => entry.runtime === route);
    if (!runtime?.models?.length) return [];
    return [{ route, label: runtime.label, models: runtime.models }];
  });
}

export function wikiModelSelectionKey(route: WikiLlmRoute, model: string): string {
  return `${route}:${model}`;
}

export function findWikiModelSelection(
  groups: WikiModelGroup[],
  route: WikiLlmRoute,
  model: string,
): string | null {
  const group = groups.find((entry) => entry.route === route);
  return group?.models.some((entry) => entry.id === model)
    ? wikiModelSelectionKey(route, model)
    : null;
}
