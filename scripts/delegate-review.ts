import type { ExternalDelegationView } from '../src/core/types';

/**
 * Explicit opt-in delegation (Claude parent → Codex child, Codex parent → Claude child);
 * retry transport with the same --request-id.
 */
async function main(): Promise<void> {
  const args = Bun.argv.slice(2);
  const option = (name: string) => {
    const index = args.indexOf(name);
    return index < 0 ? undefined : args[index + 1];
  };
  const base = process.env.KANBAN_API_URL ?? `http://127.0.0.1:${process.env.KANBAN_PORT ?? '24680'}`;
  const endpoint = new URL(base);
  if (endpoint.protocol !== 'http:' || !['127.0.0.1','[::1]','localhost'].includes(endpoint.hostname)
    || endpoint.username || endpoint.password || endpoint.pathname !== '/' || endpoint.search || endpoint.hash) {
    throw new Error('Delegation API must be a local loopback origin');
  }
  const token = process.env.KANBAN_DELEGATION_OPERATOR_TOKEN;
  if (!token || !/^[A-Za-z0-9_-]{43,128}$/.test(token)) throw new Error('Dedicated local operator credential required');
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const request = async (path: string, body?: unknown): Promise<ExternalDelegationView> => {
    const response = await fetch(new URL(path, endpoint), {
      redirect: 'error',
      method: body ? 'POST' : 'GET', headers, body: body ? JSON.stringify(body) : undefined,
    });
    if (!response.ok) throw new Error(`Delegation ${response.status}: ${await response.text()}`);
    return await response.json() as ExternalDelegationView;
  };
  let runId = option('--run-id');
  if (!runId) {
    const requestId = option('--request-id');
    const parentCardId = option('--parent-card');
    const parentRunId = option('--parent-run');
    if (!requestId || !parentCardId || !parentRunId) {
      throw new Error('Explicit --parent-card, --parent-run and --request-id are required (or use --run-id to resume polling)');
    }
    const accepted = await request('/api/delegations', {
      parentCardId, parentRunId, requestId, model: option('--model'), prompt: await Bun.stdin.text(),
    });
    runId = accepted.runId;
    console.error(`Delegation run: ${runId}; child card: ${accepted.cardId}`);
  }
  while (true) {
    const view = await request(`/api/delegations/${encodeURIComponent(runId)}`);
    if (view.status !== 'starting' && view.status !== 'running') {
      if (view.result) console.log(view.result);
      if (view.status !== 'completed') throw new Error(view.error ?? `Delegation ${view.status}`);
      return;
    }
    await Bun.sleep(250);
  }
}

if (import.meta.main) {
  try { await main(); }
  catch (error) { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; }
}
