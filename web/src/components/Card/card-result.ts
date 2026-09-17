import type { KanbanCard } from '../../../../src/core/types';

export interface SplitCardResult {
  earlier: string;
  final: string;
}

// `result` is every assistant text block of the run joined in order; `finalResult`
// is the last one. Peeling that suffix off separates the deliverable from the
// interim output that preceded it. A card whose `result` was written by something
// other than the run that set `finalResult` (manual edit, `kanban_update`) no
// longer ends with it — then the whole result is treated as final.
export function splitCardResult(card: Pick<KanbanCard, 'result' | 'finalResult'>): SplitCardResult {
  const result = card.result ?? '';
  const finalResult = card.finalResult?.trim() ?? '';
  if (!finalResult || !result.endsWith(finalResult)) {
    return { earlier: '', final: result };
  }
  return {
    earlier: result.slice(0, result.length - finalResult.length).trim(),
    final: finalResult,
  };
}
