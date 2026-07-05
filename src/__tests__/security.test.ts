import { describe, test, expect } from 'bun:test';
import { createServer } from '../server/index';
import { createRouteHandler } from '../server/routes';
import { KanbanStore } from '../core/store';
import { SettingsStore } from '../core/settings-store';
import { withTempDir } from './setup';

const TOKEN = 'local-secret-token';

/**
 * Start a server with a configured local auth token + a settings store holding
 * one masked secret. Exercises the production-like auth path.
 */
async function withSecureServer(
  callback: (ctx: { baseUrl: string; settingsStore: SettingsStore; secretId: string }) => Promise<void>,
) {
  await withTempDir(async (dir) => {
    const store = new KanbanStore(dir);
    const settingsStore = new SettingsStore(dir);
    const secret = await settingsStore.createEntry({
      key: 'TELEGRAM_BOT_TOKEN',
      value: 'super-secret-value',
      description: 'bot token',
      masked: true,
    });
    const port = 24800 + Math.floor(Math.random() * 100);
    const { stop, port: actualPort } = createServer(
      store,
      port,
      undefined, // staticDir
      undefined, // dispatchFn
      undefined, // schedulerStore
      undefined, // schedulerEngine
      settingsStore,
      '127.0.0.1',
      undefined, // onNetworkSettingChange
      undefined, // scriptStore
      undefined, // modelsFn
      undefined, // questionMonitor
      undefined, // aggregateSessionsFn
      undefined, // localPeerSessionsFn
      () => TOKEN, // peerTokenFn — doubles as the local auth token
    );
    const baseUrl = `http://localhost:${actualPort}`;
    try {
      await callback({ baseUrl, settingsStore, secretId: secret.id });
    } finally {
      stop();
    }
  });
}

const auth = { Authorization: `Bearer ${TOKEN}` };

describe('Security — local auth token', () => {
  test('mutating route requires the token when one is configured', async () => {
    await withSecureServer(async ({ baseUrl }) => {
      const unauthorized = await fetch(`${baseUrl}/api/cards`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'a', description: 'b' }),
      });
      expect(unauthorized.status).toBe(401);

      const authorized = await fetch(`${baseUrl}/api/cards`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...auth },
        body: JSON.stringify({ title: 'a', description: 'b' }),
      });
      expect(authorized.status).toBe(201);
    });
  });

  test('non-sensitive reads remain open (board loads without token)', async () => {
    await withSecureServer(async ({ baseUrl }) => {
      const res = await fetch(`${baseUrl}/api/board`);
      expect(res.status).toBe(200);
    });
  });

  test('settings read requires the token', async () => {
    await withSecureServer(async ({ baseUrl }) => {
      const res = await fetch(`${baseUrl}/api/settings`);
      expect(res.status).toBe(401);
    });
  });
});

describe('Security — secret redaction', () => {
  test('settings list redacts masked values', async () => {
    await withSecureServer(async ({ baseUrl }) => {
      const res = await fetch(`${baseUrl}/api/settings`, { headers: auth });
      expect(res.status).toBe(200);
      const entries = (await res.json()) as Array<{ key: string; value: string; masked?: boolean }>;
      const secret = entries.find((e) => e.key === 'TELEGRAM_BOT_TOKEN');
      expect(secret).toBeTruthy();
      expect(secret?.value).toBe('');
    });
  });

  test('explicit single-entry GET returns the plaintext value', async () => {
    await withSecureServer(async ({ baseUrl, secretId }) => {
      const res = await fetch(`${baseUrl}/api/settings/${secretId}`, { headers: auth });
      expect(res.status).toBe(200);
      const entry = (await res.json()) as { value: string };
      expect(entry.value).toBe('super-secret-value');
    });
  });
});

describe('Security — token bootstrap', () => {
  test('GET /api/auth/token returns the token to a loopback client', async () => {
    await withSecureServer(async ({ baseUrl }) => {
      const res = await fetch(`${baseUrl}/api/auth/token`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { token: string };
      expect(body.token).toBe(TOKEN);
    });
  });

  test('non-loopback client is refused the token unless lan_full_access is enabled', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const settingsStore = new SettingsStore(dir);
      const { handleRequest } = createRouteHandler(
        store,
        undefined, // dispatchFn
        undefined, // schedulerStore
        undefined, // schedulerEngine
        settingsStore,
        undefined, // onNetworkSettingChange
        undefined, // scriptStore
        undefined, // modelsFn
        undefined, // questionMonitor
        undefined, // aggregateSessionsFn
        undefined, // localPeerSessionsFn
        () => TOKEN,
      );
      const req = () => new Request('http://192.168.0.10:24680/api/auth/token');

      // Default: LAN clients get no token (read-only view).
      const refused = await handleRequest(req(), { clientAddress: '192.168.0.20' });
      expect(refused.status).toBe(403);

      // Opt-in: lan_full_access serves the token to LAN clients too.
      await settingsStore.createEntry({
        key: 'lan_full_access',
        value: 'true',
        description: 'lan full access',
        masked: false,
      });
      const allowed = await handleRequest(req(), { clientAddress: '192.168.0.20' });
      expect(allowed.status).toBe(200);
      const body = (await allowed.json()) as { token: string };
      expect(body.token).toBe(TOKEN);

      // Loopback stays served regardless of the setting.
      const loopback = await handleRequest(req(), { clientAddress: '127.0.0.1' });
      expect(loopback.status).toBe(200);
    });
  });
});
