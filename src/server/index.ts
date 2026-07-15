import { existsSync } from 'node:fs';
import { join, extname } from 'node:path';
import type { KanbanStore } from '../core/store';
import type { SchedulerStore } from '../core/scheduler-store';
import type { SchedulerEngine } from '../plugin/scheduler-engine';
import type { SettingsStore } from '../core/settings-store';
import type { ScriptStore } from '../core/script-store';
import type { SkillStore } from '../core/skill-store';
import type { SkillRootsStore } from '../core/skill-roots-store';
import type { PlacementTargetsStore } from '../core/placement-targets-store';
import type { RuntimeRunStore } from '../plugin/runtimes/runtime-run-store';
import type { QuestionMonitor } from '../plugin/question-monitor';
import type { WikiWorker } from '../plugin/wiki/wiki-worker';
import {
  createRouteHandler,
  type DispatchFn,
  type ModelsFn,
  type RuntimeCatalogFn,
  type AggregateSessionsFn,
  type LocalPeerSessionsFn,
  type PeerTokenFn,
  type ScopeMcpInventoryFn,
} from './routes';
export type {
  DispatchFn,
  ModelsFn,
  RuntimeCatalogFn,
  AggregateSessionsFn,
  LocalPeerSessionsFn,
  PeerTokenFn,
  ScopeMcpInventoryFn,
} from './routes';

export interface ServerInstance {
  server: ReturnType<typeof Bun.serve>;
  stop: () => void;
  port: number;
}

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

/** Max number of port retry attempts when configured port is in use */
const MAX_PORT_RETRIES = 3;

export function createServer(
  store: KanbanStore,
  port: number = 24680,
  staticDir?: string,
  dispatchFn?: DispatchFn,
  schedulerStore?: SchedulerStore,
  schedulerEngine?: SchedulerEngine,
  settingsStore?: SettingsStore,
  hostname?: string,
  onNetworkSettingChange?: (hostname: string) => void,
  scriptStore?: ScriptStore,
  modelsFn?: ModelsFn,
  questionMonitor?: QuestionMonitor,
  aggregateSessionsFn?: AggregateSessionsFn,
  localPeerSessionsFn?: LocalPeerSessionsFn,
  peerTokenFn?: PeerTokenFn,
  runtimeCatalogFn?: RuntimeCatalogFn,
  wikiWorker?: WikiWorker,
  skillStore?: SkillStore,
  skillRootsStore?: SkillRootsStore,
  placementTargetsStore?: PlacementTargetsStore,
  runtimeRunStore?: RuntimeRunStore,
  scopeMcpInventoryFn?: ScopeMcpInventoryFn,
): ServerInstance {
  const { handleRequest } = createRouteHandler(
    store,
    dispatchFn,
    schedulerStore,
    schedulerEngine,
    settingsStore,
    onNetworkSettingChange,
    scriptStore,
    modelsFn,
    questionMonitor,
    aggregateSessionsFn,
    localPeerSessionsFn,
    peerTokenFn,
    runtimeCatalogFn,
    wikiWorker,
    skillStore,
    skillRootsStore,
    placementTargetsStore,
    runtimeRunStore,
    scopeMcpInventoryFn,
  );

  const fetchHandler = async (req: Request, server: ReturnType<typeof Bun.serve>) => {
    const url = new URL(req.url);
    const path = url.pathname;

    // Resolve the client's network address so route handlers can restrict
    // sensitive bootstrap (token issuance) to loopback clients.
    const clientAddress = server?.requestIP(req)?.address;

    // API routes take priority
    if (path.startsWith('/api/') || (req.method === 'OPTIONS' && path.startsWith('/api'))) {
      return handleRequest(req, { clientAddress });
    }

    // Serve static files if staticDir is configured and exists
    if (staticDir && existsSync(staticDir)) {
      // Try to serve the exact file
      const filePath = path === '/' ? join(staticDir, 'index.html') : join(staticDir, path);
      if (existsSync(filePath)) {
        const file = Bun.file(filePath);
        const ext = extname(filePath);
        const contentType = MIME_TYPES[ext] || 'application/octet-stream';
        // Workaround for Bun bug: Response(Bun.file()) uses sendfile() which races
        // with HTTP header flush over non-loopback interfaces (LAN gets HTTP/0.9).
        // Fix: read into ArrayBuffer first so headers flush before body.
        // See: https://github.com/oven-sh/bun/issues/26406
        const content = await file.arrayBuffer();
        return new Response(content, {
          headers: { 'Content-Type': contentType },
        });
      }

      // SPA fallback: serve index.html for non-file routes
      const indexPath = join(staticDir, 'index.html');
      if (existsSync(indexPath)) {
        // Workaround for Bun bug: see https://github.com/oven-sh/bun/issues/26406
        const spaContent = await Bun.file(indexPath).arrayBuffer();
        return new Response(spaContent, {
          headers: { 'Content-Type': 'text/html' },
        });
      }
    }

    // Fall through to API handler for 404
    return handleRequest(req, { clientAddress });
  };

  // Try configured port, then retry on subsequent ports if in use
  let lastError: unknown;
  for (let attempt = 0; attempt <= MAX_PORT_RETRIES; attempt++) {
    const tryPort = port + attempt;
    try {
      const server = Bun.serve({
        port: tryPort,
        hostname,
        idleTimeout: 120,
        fetch: fetchHandler,
      });

      return {
        server,
        stop: () => server.stop(true),
        port: server.port || tryPort,
      };
    } catch (err) {
      lastError = err;
      // Port in use — try next port
    }
  }

  // All retries exhausted
  throw lastError;
}
