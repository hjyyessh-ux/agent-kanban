import { test, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Deck capture — seeds a realistic Korean demo board and captures PNG
 * screenshots used by the presentation deck (outputs/slides/img).
 *
 * Run: npx playwright test e2e/deck-capture.e2e.ts
 */

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const OUT_DIR = path.resolve(__dirname, '..', 'outputs', 'slides', 'img');
mkdirSync(OUT_DIR, { recursive: true });

const BASE = process.env.E2E_BASE_URL ?? 'http://127.0.0.1:24681';

// Wide viewport so board columns are roomy and card titles fit on one line.
const BOARD_VIEWPORT = { width: 2200, height: 1320 };

interface Card { id: string; title: string; [k: string]: unknown }

async function api(method: string, p: string, body?: unknown): Promise<any> {
  const res = await fetch(`${BASE}${p}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok && res.status !== 404) {
    throw new Error(`${method} ${p} -> ${res.status}: ${await res.text()}`);
  }
  return res.status === 404 ? null : res.json();
}

async function create(data: Record<string, unknown>): Promise<Card> {
  return api('POST', '/api/cards', data);
}
async function patch(id: string, data: Record<string, unknown>): Promise<Card> {
  return api('PATCH', `/api/cards/${id}`, data);
}

const PROJ = '~/workspace/agent-kanban';
const PROJ2 = '~/workspace/example-project';

function iso(minutesAgo: number): string {
  return new Date(Date.now() - minutesAgo * 60_000).toISOString();
}

async function clearBoard(): Promise<void> {
  const cards: Card[] = await api('GET', '/api/cards');
  for (const c of cards) {
    await api('DELETE', `/api/cards/${c.id}`);
  }
}

async function seed(): Promise<void> {
  await clearBoard();

  // ── Done column ────────────────────────────────────────────────────
  await create({
    title: '원자적 저장 + 듀얼 락',
    description: 'temp-file rename 기반 원자적 저장과 듀얼 락 구현',
    status: 'done', agentRuntime: 'opencode', agentType: 'hephaestus',
    model: 'github-copilot/claude-sonnet-4.6', projectDir: PROJ,
    sessionId: 'opencode-done-1', result: '완료: store.ts 듀얼 락 적용, 회귀 테스트 통과',
    responseAt: iso(2400), completedAt: iso(2400),
  });
  await create({
    title: '데이터 디렉토리 마이그레이션',
    description: 'resolveKanbanDataDir() 부팅 시 자동 이전',
    status: 'done', agentRuntime: 'claude', model: 'claude-opus-4-8', projectDir: PROJ,
    sessionId: 'claude-done-1', result: '완료: 레거시 경로 자동 감지 후 이전',
    responseAt: iso(1800), completedAt: iso(1800),
  });

  // ── Complete column (session 모아보기 demo) ───────────────────────
  // Session A (claude) — 2 cards share one session
  const a1 = await create({
    title: 'Resume 패널 셀렉터 정리',
    description: 'SessionPickerPanel의 resume 후보 필터링 로직 정리',
    agentRuntime: 'claude', model: 'claude-opus-4-8', agentType: 'executor', projectDir: PROJ,
  });
  await patch(a1.id, {
    status: 'complete', resolution: 'completed', sessionId: 'claude-sess-A',
    sessionTitle: 'Resume 패널 리팩터링',
    result: 'RESUMABLE_CARD_STATUSES 기준으로 후보를 필터링하도록 정리했습니다.\n- isSubagentOnly 세션 제외\n- 현재 카드 자기 자신 제외\n변경 파일: SessionPickerPanel.tsx',
    responseAt: iso(38), completedAt: iso(38), completedSeenAt: iso(38),
  });
  const a2 = await create({
    title: 'Resume 결과 회귀 테스트',
    description: '이어하기 세션에서 받은 결과를 카드에 머지',
    agentRuntime: 'claude', model: 'claude-opus-4-8', agentType: 'test-engineer', projectDir: PROJ,
  });
  await patch(a2.id, {
    status: 'complete', resolution: 'completed', sessionId: 'claude-sess-A',
    sessionTitle: 'Resume 패널 리팩터링',
    result: '동일 세션에서 이어 작업하여 테스트 4건 추가, 전부 통과했습니다.',
    responseAt: iso(30), completedAt: iso(30),
  });

  // Session B (codex)
  const b1 = await create({
    title: '응답 정렬 순서 수정',
    description: 'complete 카드 정렬이 createdAt이 아니라 responseAt을 따르도록',
    agentRuntime: 'codex', model: 'github-copilot/gpt-5.4', projectDir: PROJ,
    codexOptions: { reasoningEffort: 'high', sandbox: 'workspace-write' },
  });
  await patch(b1.id, {
    status: 'complete', resolution: 'completed', sessionId: 'thread-sess-B',
    sessionTitle: '정렬 버그 수정',
    result: 'board-utils.ts의 sortCardsForColumn을 responseAt 우선으로 변경했습니다.',
    responseAt: iso(20), completedAt: iso(20),
  });

  // Session C (opencode) — different workspace
  const c1 = await create({
    title: '보드 헤더 레이아웃 분리',
    description: '보드 컨트롤을 전용 sub-header 행으로 이동',
    agentRuntime: 'opencode', agentType: 'hephaestus',
    model: 'github-copilot/claude-sonnet-4.6', projectDir: PROJ2,
  });
  await patch(c1.id, {
    status: 'complete', resolution: 'completed', sessionId: 'opencode-sess-C',
    sessionTitle: '보드 헤더 레이아웃',
    result: 'BoardColumnHeader에서 컨트롤을 분리해 가독성을 높였습니다.',
    responseAt: iso(12), completedAt: iso(12),
  });

  // ── In Progress column ────────────────────────────────────────────
  const p1 = await create({
    title: 'session.idle 중복 완료 가드',
    description: 'idle 이벤트로 인한 카드 이중 완료를 방지하는 가드 추가',
    agentRuntime: 'claude', model: 'claude-opus-4-8', agentType: 'debugger', projectDir: PROJ,
  });
  await patch(p1.id, {
    status: 'in_progress', sessionId: 'claude-run-1',
    progressSummary: 'event-handler.ts 분석 중 — session-activity-registry로 idempotent 처리 설계',
  });
  const p2 = await create({
    title: 'Codex sandbox 옵션 연동',
    description: 'codexOptions.sandbox를 dispatch 프롬프트에 반영',
    agentRuntime: 'codex', model: 'github-copilot/gpt-5.4', projectDir: PROJ,
    codexOptions: { reasoningEffort: 'medium', sandbox: 'read-only' },
  });
  await patch(p2.id, {
    status: 'in_progress', sessionId: 'thread-run-2',
    progressSummary: 'codex-cli-adapter.ts에서 sandbox 플래그 매핑 적용 중',
  });

  // ── To Do column ──────────────────────────────────────────────────
  await create({
    title: 'Telegram 폴러 재연결',
    description: '폴링 중 네트워크 단절 시 백오프 재연결 추가',
    agentRuntime: 'claude', model: 'claude-opus-4-8', agentType: 'executor', projectDir: PROJ,
    claudeOptions: { permissionMode: 'acceptEdits' },
  });
  // Queue demo: this card runs AFTER p1, continuing in the same session
  const t2 = await create({
    title: '스케줄러 cron 파싱 수정',
    description: 'croner 파싱 실패 시 사용자 친화적 에러 메시지',
    agentRuntime: 'claude', model: 'claude-opus-4-8', agentType: 'debugger', projectDir: PROJ,
  });
  await patch(t2.id, {
    queuedAfterCardId: p1.id,
    queuePosition: 1,
    queueSessionMode: 'continue_queued_after_session',
  });
  await create({
    title: '보드 필터 UX 개선',
    description: '즐겨찾기 카드를 상단에 고정하는 필터 옵션',
    agentRuntime: 'opencode', agentType: 'hephaestus',
    model: 'github-copilot/claude-sonnet-4.6', projectDir: PROJ, favorite: true,
  });
  // A clean todo card used to showcase Queue/Resume panels
  await create({
    title: '릴리즈 노트 초안 작성',
    description: '최근 머지된 PR을 모아 릴리즈 노트 초안을 만든다',
    agentRuntime: 'claude', model: 'claude-opus-4-8', agentType: 'writer', projectDir: PROJ,
  });

  // ── Scheduler entry ───────────────────────────────────────────────
  await api('POST', '/api/schedulers', {
    name: '매일 아침 PR 리뷰 다이제스트',
    description: '열려있는 PR을 모아 요약 카드를 생성',
    cron: '0 9 * * 1-5',
    cronDescription: '평일 오전 9시',
    timezone: 'Asia/Seoul',
    action: { type: 'shell', command: 'bun scripts/pr-digest.ts' },
  }).catch(() => {});
  await api('POST', '/api/schedulers', {
    name: '주간 백로그 정리 리마인더',
    description: 'Done 카드 아카이브 후보 알림',
    cron: '0 18 * * 5',
    cronDescription: '매주 금요일 오후 6시',
    timezone: 'Asia/Seoul',
    action: { type: 'shell', command: 'bun scripts/archive-reminder.ts' },
  }).catch(() => {});

  // ── Script entries ────────────────────────────────────────────────
  await api('POST', '/api/scripts', {
    name: 'pr-digest',
    description: '열린 PR 목록을 모아 카드로 등록하는 스크립트',
    language: 'typescript',
    content: 'import { listOpenPRs } from "./gh";\n\nconst prs = await listOpenPRs();\nfor (const pr of prs) {\n  await createCard({ title: `Review: ${pr.title}` });\n}\n',
  }).catch(() => {});
  await api('POST', '/api/scripts', {
    name: 'archive-reminder',
    description: '오래된 Done 카드를 찾아 아카이브 후보로 표시',
    language: 'bash',
    content: '#!/usr/bin/env bash\ncurl -s localhost:24680/api/cards | jq ".[] | select(.status==\\"done\\")"\n',
  }).catch(() => {});
}

async function settle(page: import('@playwright/test').Page, ms = 700) {
  await page.waitForTimeout(ms);
}

test.describe.configure({ mode: 'serial' });

test.use({ viewport: { width: 1680, height: 1020 }, deviceScaleFactor: 2 });

test('seed demo data', async () => {
  await seed();
});

test('capture: board full view', async ({ page }) => {
  await page.setViewportSize(BOARD_VIEWPORT);
  await page.goto('/');
  await expect(page.locator('.kv2-board')).toBeVisible();
  await expect(page.locator('.kv2-card').first()).toBeVisible();
  await settle(page);
  await page.screenshot({ path: path.join(OUT_DIR, '01-board-full.png'), fullPage: false });
});

test('capture: session 모아보기', async ({ page }) => {
  await page.setViewportSize(BOARD_VIEWPORT);
  await page.goto('/');
  await expect(page.locator('.kv2-board')).toBeVisible();
  await page.locator('.app-board-session-toggle').click();
  await settle(page);
  await page.screenshot({ path: path.join(OUT_DIR, '02-session-group.png'), fullPage: false });
  await page.locator('.app-board-session-toggle').click();
});

test('capture: workspace switcher', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.kv2-board')).toBeVisible();
  const switcher = page.locator('.app-project-controls');
  await expect(switcher).toBeVisible();
  await settle(page, 400);
  await switcher.screenshot({ path: path.join(OUT_DIR, '03-workspace-switcher.png') });
});

test('capture: complete card detail (prompt + result)', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.kv2-board')).toBeVisible();
  const card = page.locator('.kv2-card', { hasText: '셀렉터 정리' }).first();
  await card.click();
  await expect(page.locator('.kv2-dialog')).toBeVisible();
  await settle(page);
  await page.locator('.kv2-dialog').screenshot({ path: path.join(OUT_DIR, '04-card-detail.png') });
});

test('capture: create card dialog', async ({ page }) => {
  await page.goto('/');
  await page.locator('.kv2-create-btn').first().click();
  await expect(page.locator('.kv2-dialog')).toBeVisible();
  await page.locator('#create-card-title-input').fill('Telegram 알림 템플릿 다듬기');
  await page.locator('#create-card-description-input').fill('완료 알림에 결과 요약과 카드 링크를 포함하도록 포맷 개선');
  await settle(page);
  await page.locator('.kv2-dialog').screenshot({ path: path.join(OUT_DIR, '05-create-dialog.png') });
});

test('capture: queue after panel', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.kv2-board')).toBeVisible();
  const card = page.locator('.kv2-card', { hasText: '릴리즈 노트' }).first();
  await card.click();
  await expect(page.locator('.kv2-dialog')).toBeVisible();
  await settle(page);
  const control = page.locator('.kv2-queue-target-control');
  if (await control.count()) {
    await control.first().click();
    await settle(page, 400);
  }
  await page.locator('.kv2-dialog').screenshot({ path: path.join(OUT_DIR, '06-queue-panel.png') });
});

test('capture: session resume panel', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.kv2-board')).toBeVisible();
  const card = page.locator('.kv2-card', { hasText: '릴리즈 노트' }).first();
  await card.click();
  await expect(page.locator('.kv2-dialog')).toBeVisible();
  await settle(page, 1000);
  const sidebar = page.locator('.kv2-detail-sidebar');
  await expect(sidebar).toBeVisible();
  await sidebar.screenshot({ path: path.join(OUT_DIR, '07-resume-panel.png') });
});

test('capture: queued card on board (NEXT badge)', async ({ page }) => {
  await page.setViewportSize(BOARD_VIEWPORT);
  await page.goto('/');
  await expect(page.locator('.kv2-board')).toBeVisible();
  const card = page.locator('.kv2-card', { hasText: '스케줄러 cron 파싱' }).first();
  await expect(card).toBeVisible();
  await settle(page, 400);
  await card.screenshot({ path: path.join(OUT_DIR, '08-queued-card.png') });
});

test('capture: scheduler tab', async ({ page }) => {
  await page.goto('/');
  await page.locator('#app-tab-scheduler').click();
  await settle(page, 900);
  await page.screenshot({ path: path.join(OUT_DIR, '09-scheduler.png'), fullPage: false });
});

test('capture: scripts tab', async ({ page }) => {
  await page.goto('/');
  await page.locator('#app-tab-scripts').click();
  await settle(page, 900);
  await page.screenshot({ path: path.join(OUT_DIR, '10-scripts.png'), fullPage: false });
});

test('capture: list view', async ({ page }) => {
  await page.setViewportSize(BOARD_VIEWPORT);
  await page.goto('/');
  await expect(page.locator('.kv2-board')).toBeVisible();
  const listBtn = page.locator('.app-board-view-toggle-btn', { hasText: 'List' });
  await listBtn.click();
  await settle(page, 700);
  await page.screenshot({ path: path.join(OUT_DIR, '11-list-view.png'), fullPage: false });
});
