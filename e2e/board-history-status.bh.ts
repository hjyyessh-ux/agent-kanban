/**
 * Browser test for the Settings → 카드·작업 이력 status panel (390px + desktop).
 *
 * Runs only via `playwright.board-history.config.ts`. Spawns the real daemon on
 * a throwaway HOME / KANBAN_DATA_DIR and a free loopback port (never 24680),
 * with a synthetic consumer token. Requires a built SPA (`bun run build:web`).
 * Screenshots: e2e/results/board-history-status-*.png
 */
import { expect, test, type Locator, type Page } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SHOTS = join(REPO, 'e2e', 'results');
const ROOT = mkdtempSync(join(tmpdir(), 'kanban-bh-ui-'));
const HOME = join(ROOT, 'home');
const DATA = join(ROOT, 'data');
const TOKEN = `dot_ui_${randomUUID().replaceAll('-', '')}`;
let port = 0;
let daemon: ChildProcess | null = null;
let base = '';

function freePort(): Promise<number> {
  return new Promise((done, fail) => {
    const probe = createServer();
    probe.once('error', fail);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const value = typeof address === 'object' && address ? address.port : 0;
      probe.close(() => done(value));
    });
  });
}
const env = () => ({ ...process.env, HOME, KANBAN_DATA_DIR: DATA, KANBAN_PORT: String(port) });

function run(args: string[], stdin?: string): Promise<number> {
  return new Promise((done, fail) => {
    const child = spawn('bun', args, { cwd: REPO, env: env(), stdio: ['pipe', 'ignore', 'ignore'] });
    child.once('error', fail);
    child.once('exit', code => done(code ?? 1));
    child.stdin?.end(stdin ?? '');
  });
}

test.beforeAll(async () => {
  mkdirSync(HOME, { recursive: true });
  mkdirSync(DATA, { recursive: true });
  port = await freePort();
  if (port === 24680) throw new Error('refusing to use the real app port');
  base = `http://127.0.0.1:${port}`;
  daemon = spawn('bun', ['run', 'src/daemon/index.ts'], { cwd: REPO, env: env(), stdio: 'ignore' });
  for (let i = 0; i < 150; i++) {
    try { if ((await fetch(`${base}/api/runtimes`)).ok) return; } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('isolated daemon did not start');
});

test.afterAll(async () => {
  if (daemon && daemon.exitCode === null) {
    const exited = new Promise(r => daemon!.once('exit', r));
    daemon.kill('SIGTERM');
    await exited;
  }
  rmSync(ROOT, { recursive: true, force: true });
});

async function openSettings(page: Page) {
  // Only the isolated daemon is reachable; anything else is aborted.
  await page.route(/^https?:\/\//, route => {
    const { hostname, port: p } = new URL(route.request().url());
    return hostname === '127.0.0.1' && p === String(port) ? route.fallback() : route.abort();
  });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.addInitScript(() => localStorage.setItem('kanban-theme', 'dark'));
  await page.goto(base + '/');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.getByRole('tab', { name: 'Settings', exact: true }).click();
  return page.getByRole('region', { name: '카드·작업 이력 구독' });
}

async function textContrast(locator: Locator) {
  return locator.evaluate(el => {
    // Canvas resolves modern color(srgb …) from dark-theme color-mix(), as
    // well as older rgb/rgba values, to 8-bit sRGB sample channels.
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 1;
    const ctx = canvas.getContext('2d')!;
    const rgb = (value: string) => {
      ctx.clearRect(0, 0, 1, 1);
      ctx.fillStyle = value;
      ctx.fillRect(0, 0, 1, 1);
      return Array.from(ctx.getImageData(0, 0, 1, 1).data);
    };
    const lum = ([r, g, b]: number[]) => [r, g, b].map(c => c / 255)
      .map((c, i) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4) * [0.2126, 0.7152, 0.0722][i])
      .reduce((a, b) => a + b);
    let bg: number[] | undefined;
    for (let it: Element | null = el; it; it = it.parentElement) {
      const col = rgb(getComputedStyle(it).backgroundColor);
      if (col[3] === 255) { bg = col; break; }
      if (col[3] > 0) throw new Error('contrast test requires an opaque or transparent fill');
    }
    if (!bg) throw new Error('cannot measure contrast without a background');
    const values = [lum(rgb(getComputedStyle(el).color)), lum(bg)].sort((a, b) => b - a);
    return (values[0] + 0.05) / (values[1] + 0.05);
  });
}

function watch(page: Page) {
  const seen = { consumerApi: 0, statusWrites: 0 };
  page.on('request', request => {
    const path = new URL(request.url()).pathname;
    if (path.startsWith('/api/board-history/')) seen.consumerApi++;
    if (path === '/api/board-history-status' && request.method() !== 'GET') seen.statusWrites++;
  });
  return seen;
}

test.describe.configure({ mode: 'serial' });

test('desktop: OFF before install, then registered with gap/pending/counts; refresh is read-only', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const seen = watch(page);
  const panel = await openSettings(page);
  await expect(panel.getByText('미등록 · 구독 OFF')).toBeVisible();

  // Synthetic install + one synthetic Work change (Works never dispatch an agent).
  expect(await run(['run', 'src/daemon/board-history-install.ts', 'dot'], TOKEN)).toBe(0);
  const peer = (await (await fetch(`${base}/api/auth/token`)).json() as { token: string }).token;
  const created = await fetch(`${base}/api/works`, {
    method: 'POST', headers: { authorization: `Bearer ${peer}`, 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'synthetic status fixture' }),
  });
  expect(created.status).toBeLessThan(300);

  await panel.getByRole('button', { name: '상태 다시 읽기' }).click();
  await expect(panel.getByText('구독 등록됨')).toBeVisible();
  const warning = panel.getByText('설치 전 미기록 구간 있음');
  await expect(warning).toBeVisible();
  expect(await textContrast(warning)).toBeGreaterThanOrEqual(4.5);
  await expect(panel.getByRole('status')).toHaveText('최신 상태를 확인했습니다.');
  await expect(panel.getByRole('button', { name: '상태 다시 읽기' })).toBeFocused();
  const details = panel.locator('details.settings-board-history-details');
  const toggle = details.locator('summary');
  const windowStart = panel.getByText('기록 창 시작 (설치 7일 전, 고정)');
  await expect(details).not.toHaveAttribute('open', '');
  await expect(windowStart).toBeHidden();
  await expect(panel.getByTestId('board-history-checked-at')).toBeHidden();
  await expect(panel.getByText('아직 확정되지 않은 변경 수')).toBeHidden();
  await panel.screenshot({ path: join(SHOTS, 'history-new-dark-desktop.png'), animations: 'disabled' });
  await toggle.focus();
  await toggle.press('Enter');
  await expect(details).toHaveAttribute('open', '');
  await expect(windowStart).toBeVisible();
  await expect(panel.getByText('미수집 — 서버가 이 시각을 기록하지 않습니다')).toHaveCount(2);
  const unacked = panel.locator('dt', { hasText: '아직 확정되지 않은 변경 수' }).locator('xpath=following-sibling::dd[1]');
  await expect(unacked).toHaveText('1');
  await expect(unacked).toBeVisible();
  const refreshed = page.waitForResponse(res => res.url().endsWith('/api/board-history-status'));
  await panel.getByRole('button', { name: '상태 다시 읽기' }).click();
  expect((await refreshed).ok()).toBe(true);
  await expect(panel.getByRole('button', { name: '상태 다시 읽기' })).toBeEnabled();
  await expect(windowStart).toBeVisible();
  await toggle.focus();
  await toggle.press('Space');
  await expect(windowStart).toBeHidden();

  // A failed refresh keeps the last good state and says so.
  await page.route('**/api/board-history-status', route => route.fulfill({ status: 503, body: '{"error":"x"}' }));
  await panel.getByRole('button', { name: '상태 다시 읽기' }).click();
  await expect(panel.getByRole('alert')).toContainText('일시적으로 상태를 읽지 못했습니다.');
  await expect(panel.getByRole('alert')).toContainText('직전에 성공한 조회');
  expect(await textContrast(panel.getByText(/직전에 성공한 조회/))).toBeGreaterThanOrEqual(4.5);
  await expect(panel.getByText('구독 등록됨')).toBeVisible();
  await expect(windowStart).toBeHidden();
  await panel.screenshot({ path: join(SHOTS, 'history-new-dark-desktop-error.png'), animations: 'disabled' });
  await page.unroute('**/api/board-history-status');
  await panel.getByRole('button', { name: '상태 다시 읽기' }).click();
  await expect(panel.getByRole('alert')).toHaveCount(0);

  expect(seen.consumerApi).toBe(0);
  expect(seen.statusWrites).toBe(0);
});

test('390px: panel fits without horizontal overflow', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const consumer = await fetch(base + '/api/board-history/status', { headers: { authorization: 'Bearer '+TOKEN } });
  if (consumer.status === 401 || consumer.status === 404) {
    expect(await run(['run', 'src/daemon/board-history-install.ts', 'dot'], TOKEN)).toBe(0);
  } else expect(consumer.ok).toBe(true);
  const panel = await openSettings(page);
  await expect(panel.getByText('구독 등록됨')).toBeVisible();
  const overflow = await panel.evaluate(el => el.scrollWidth - el.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
  const pageOverflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(pageOverflow).toBeLessThanOrEqual(1);
  const details = panel.locator('details.settings-board-history-details');
  const toggle = details.locator('summary');
  const checkedAt = panel.getByTestId('board-history-checked-at');
  await expect(checkedAt).toBeHidden();
  const capture = async (filename: string) => {
    await panel.screenshot({ path: join(SHOTS, filename), animations: 'disabled',
      style: '.app-header { visibility: hidden !important; }' });
  };
  await capture('history-new-dark-mobile-collapsed.png');
  await toggle.click();
  await expect(checkedAt).toBeVisible();
  expect(await panel.evaluate(el => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1);
  await capture('history-new-dark-mobile-expanded.png');
  await toggle.click();
  await expect(checkedAt).toBeHidden();
});
