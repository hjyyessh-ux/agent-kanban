import { BoardHistoryError, type BoardHistoryService } from '../core/board-history';

export const BOARD_HISTORY_PREFIX = '/api/board-history';
export const MAX_ACK_BODY_BYTES = 1024;
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

const STATUS_BY_CODE: Record<string, number> = {
  board_history_not_installed: 404,
  board_cursor_expired: 410,
  invalid_board_delivery: 409,
  invalid_board_page_size: 400,
  board_journal_capacity_reached: 503,
  board_history_unavailable: 503,
};

function reply(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}
const fail = (code: string, status: number) => reply({ error: code }, status);

function hasOnlyParams(url: URL, allowed: readonly string[]): boolean {
  for (const key of url.searchParams.keys()) if (!allowed.includes(key)) return false;
  return url.searchParams.getAll('limit').length <= 1;
}

/** Reads at most `max` bytes. Rejects by declared length before reading, then by streamed length. */
export async function readCappedBody(req: Pick<Request, 'headers' | 'body'>, max: number): Promise<string | null> {
  const declared = req.headers.get('content-length');
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > max)) return null;
  if (!req.body) return '';
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf-8');
}

export interface BoardHistoryRouteContext {
  service?: BoardHistoryService;
  /** Network peer as seen by the server; unknown is refused (fail closed). */
  clientAddress?: string;
  /** Catches the sidecar up with the JSON files before a read. Best-effort. */
  reconcile?: () => Promise<void>;
}

/**
 * Dedicated consumer API. Runs before the board's local peer-token gate: the
 * peer token is never accepted here, and the consumer token unlocks nothing else.
 * The subscription, project and initial 7-day window are fixed by the server;
 * any extra query parameter or body field is rejected instead of ignored.
 */
export async function handleBoardHistoryRequest(req: Request, url: URL, ctx: BoardHistoryRouteContext): Promise<Response> {
  if (!ctx.clientAddress || !LOOPBACK.has(ctx.clientAddress)) return fail('board_history_local_only', 403);
  const service = ctx.service;
  if (!service || !service.isInstalled()) return fail('board_history_not_installed', 404);
  if (!service.authenticate(req.headers.get('authorization'))) return fail('Unauthorized', 401);

  const path = url.pathname;
  const catchUp = async () => { await ctx.reconcile?.().catch(() => undefined); };
  try {
    if (req.method === 'GET' && path === `${BOARD_HISTORY_PREFIX}/status`) {
      if (!hasOnlyParams(url, [])) return fail('unsupported_parameter', 400);
      await catchUp();
      return reply(service.status());
    }
    if (req.method === 'GET' && path === `${BOARD_HISTORY_PREFIX}/events`) {
      if (!hasOnlyParams(url, ['limit'])) return fail('unsupported_parameter', 400);
      const raw = url.searchParams.get('limit') ?? '100';
      if (!/^\d{1,3}$/.test(raw)) return fail('invalid_board_page_size', 400);
      await catchUp();
      return reply(service.page(Number(raw)));
    }
    if (req.method === 'POST' && path === `${BOARD_HISTORY_PREFIX}/ack`) {
      if (!hasOnlyParams(url, [])) return fail('unsupported_parameter', 400);
      const text = await readCappedBody(req, MAX_ACK_BODY_BYTES);
      if (text === null) return fail('payload_too_large', 413);
      let body: unknown;
      try { body = JSON.parse(text); } catch { return fail('invalid_json', 400); }
      if (!body || typeof body !== 'object' || Array.isArray(body)
        || Object.keys(body).length !== 1 || typeof (body as { deliveryId?: unknown }).deliveryId !== 'string')
        return fail('invalid_board_delivery', 400);
      return reply(service.ack((body as { deliveryId: string }).deliveryId));
    }
  } catch (error) {
    const code = error instanceof BoardHistoryError ? error.code : 'board_history_unavailable';
    return fail(code, STATUS_BY_CODE[code] ?? 503);
  }
  return fail('Not found', 404);
}
