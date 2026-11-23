import type { BoardHistoryService } from '../core/board-history';
import { readBoardHistorySummary } from '../core/board-history-summary';
import type { BoardHistoryStatusSummary } from '../core/types';

/**
 * Owner-only, read-only Card/Works History status for the Settings tab.
 *
 * Separate from the consumer API (`/api/board-history/*`): that API keeps its
 * own consumer-token-only gate, and this route never accepts the consumer
 * token. Every check fails closed:
 * - loopback peer only (unknown peer address refused, so LAN — including
 *   `lan_full_access` devices that hold the local token — is refused);
 * - loopback `Host` only, so a DNS-rebound page cannot reach it by name;
 * - any `Origin` / `Sec-Fetch-Site` must be same-origin loopback;
 * - the existing local admin (peer) token is required and must be configured;
 * - no CORS grant: no `Access-Control-*` header on any response, and
 *   preflight/non-GET methods are refused.
 */
export const BOARD_HISTORY_STATUS_PATH = '/api/board-history-status';

const LOOPBACK_PEERS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]']);

function reply(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      Vary: 'Origin, Authorization',
    },
  });
}
const fail = (code: string, status: number) => reply({ error: code }, status);

function loopbackHostname(hostHeader: string | null): boolean {
  if (!hostHeader) return false;
  try {
    return LOOPBACK_HOSTNAMES.has(new URL(`http://${hostHeader}`).hostname);
  } catch {
    return false;
  }
}

function sameOriginLoopback(req: Request): boolean {
  const site = req.headers.get('sec-fetch-site');
  if (site !== null && site !== 'same-origin' && site !== 'none') return false;
  const origin = req.headers.get('origin');
  if (origin === null) return true;
  try {
    const parsed = new URL(origin);
    return parsed.host === req.headers.get('host') && LOOPBACK_HOSTNAMES.has(parsed.hostname);
  } catch {
    return false;
  }
}

export interface BoardHistoryStatusRouteContext {
  clientAddress?: string;
  /** Existing local admin (peer) token check, computed by the router. */
  adminAuthorized: boolean;
  /** `undefined` when this process does not serve the subscription. */
  service?: BoardHistoryService;
  /** Overridable for synthetic tests. */
  read?: (dataDir: string) => BoardHistoryStatusSummary;
}

export function handleBoardHistoryStatusRequest(req: Request, url: URL, ctx: BoardHistoryStatusRouteContext): Response {
  if (req.method !== 'GET') return fail('method_not_allowed', 405);
  if (!ctx.clientAddress || !LOOPBACK_PEERS.has(ctx.clientAddress)) return fail('local_only', 403);
  if (!loopbackHostname(req.headers.get('host')) || !sameOriginLoopback(req)) return fail('local_only', 403);
  // The consumer credential unlocks only its own API, never this summary.
  if (ctx.service?.authenticate(req.headers.get('authorization'))) return fail('Unauthorized', 401);
  if (!ctx.adminAuthorized) return fail('Unauthorized', 401);
  if ([...url.searchParams.keys()].length > 0) return fail('unsupported_parameter', 400);
  if (!ctx.service) return reply({ state: 'inactive', checkedAt: new Date().toISOString() } satisfies BoardHistoryStatusSummary);
  return reply((ctx.read ?? readBoardHistorySummary)(ctx.service.dataDir));
}
