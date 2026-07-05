import { resolveKanbanDataDir } from '../core/data-dir';

export const KANBAN_PORT = parseInt(process.env.KANBAN_PORT ?? '24680', 10);

export function getKanbanDataDir(): string {
  return resolveKanbanDataDir();
}
