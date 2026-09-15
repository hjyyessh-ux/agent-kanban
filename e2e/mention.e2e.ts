import type { Page } from '@playwright/test';
import { test, expect } from './fixtures/kanban';
import { apiGetCards } from './helpers/api';

/**
 * `@` 멘션 참조 — 입력부터 생성된 카드의 `description`까지.
 *
 * 이 기능의 계약은 "**본문 텍스트가 단일 진실**"이고, dispatch 경로는 한 줄도
 * 바뀌지 않는다는 것이다. 그래서 마지막 단언이 UI 상태가 아니라 **저장된 카드의
 * `description` 문자열**이다 — 참조가 거기에 없으면 에이전트는 아무것도 못 읽는다.
 */

const REFERENCE_BLOCK_OPEN = '<!-- agent-kanban:references v1';
const REFERENCE_BLOCK_CLOSE = '<!-- /agent-kanban:references -->';

/** 다른 e2e 카드에 걸리지 않을 검색어. 세션 카드의 본문에만 심는다. */
function uniqueMarker(): string {
  return `mentionmark${Date.now().toString(36)}`;
}

async function openCreateDialog(page: Page, title: string): Promise<void> {
  await page.goto('/');
  await page.getByRole('button', { name: 'Create new card' }).click();
  await page.locator('#create-card-title-input').fill(title);
}

/**
 * 프롬프트에 `@검색어`를 타이핑하고, 후보가 **실제로 도착할 때까지** 기다린다.
 *
 * 팝오버는 `@`를 친 순간 바로 뜨지만 목록은 150ms 디바운스 뒤에 채워진다. 셸이
 * 보이는 것만 확인하고 `Enter`를 치면 고를 후보가 없어 평범한 개행이 되고
 * (설계된 폴백이다), 테스트는 기능이 아니라 타이밍에서 깨진다.
 */
async function typeMention(page: Page, prefix: string, query: string, expectedRows: number): Promise<void> {
  const prompt = page.locator('#create-card-description-input');
  await prompt.click();
  // fill()은 input 이벤트를 한 번만 쏘고 캐럿 동기화가 어긋날 수 있어 실제 타이핑을 쓴다.
  await prompt.pressSequentially(`${prefix}@${query}`, { delay: 10 });
  await expect(page.locator('.kv2-mention-pop')).toBeVisible();
  await expect(page.locator('.kv2-mention-row')).toHaveCount(expectedRows);
}

test.describe('@ mention references', () => {
  test('@ 입력 → 팝오버 → ↓↓⏎ → 칩 1개 → Create 시 description에 참조 블록', async ({
    page,
    seedCard,
  }) => {
    const marker = uniqueMarker();
    // 세션 보유 카드 3장 = Sessions 후보 3건. 제목이 아니라 **본문**에 검색어를
    // 심는다 — 이 기능이 description/result까지 훑는다는 것이 설계의 전제다.
    // 토큰에 박히는 것은 sessionId의 **앞 8자**이므로, 세 세션의 앞 8자가 서로
    // 달라야 칩과 행을 구별할 수 있다.
    const sessionIds = [0, 1, 2].map((i) => `mention${i}-${marker}`);
    for (const [i, sessionId] of sessionIds.entries()) {
      await seedCard({
        title: `[E2E] mention source ${i}`,
        description: `${marker} 라는 표식이 본문에만 들어 있는 카드 ${i}`,
        sessionId,
        projectDir: '/Users/test/mention-project',
      });
    }

    const title = `[E2E] mention consumer ${marker}`;
    await openCreateDialog(page, title);
    // 제목에는 표식이 없으므로, 행 3개가 뜬다는 것 자체가 본문 검색이 돈다는 증거다.
    await typeMention(page, '이전 작업을 참고: ', marker, 3);

    const popover = page.locator('.kv2-mention-pop');
    const prompt = page.locator('#create-card-description-input');
    await prompt.press('ArrowDown');
    await prompt.press('ArrowDown');

    // 정렬 순서에 기대지 않는다 — 지금 선택된 행이 무엇인지 읽고 그걸 검증한다.
    const selectedId = await popover
      .locator('.kv2-mention-row.is-selected .kv2-mention-row-id')
      .innerText();
    expect(sessionIds.map((id) => id.slice(0, 8))).toContain(selectedId);

    await prompt.press('Enter');
    await expect(popover).toBeHidden();

    // 칩은 본문에서 파싱한 토큰의 렌더다.
    const chips = page.locator('.kv2-ref-chip');
    await expect(chips).toHaveCount(1);
    await expect(chips.first().locator('.kv2-ref-chip-token')).toContainText(selectedId);

    // 본문에도 토큰이 남아 있어야 한다 — 칩이 아니라 이쪽이 단일 진실이다.
    await expect(prompt).toHaveValue(new RegExp(`@session:${selectedId}`));

    await page.getByRole('button', { name: 'CREATE', exact: true }).click();
    await expect(page.locator('.kv2-card-title', { hasText: title })).toBeVisible();

    const created = (await apiGetCards()).find((card) => card.title === title);
    expect(created).toBeDefined();
    // 참조 블록이 저장된 본문에 실제로 붙었는가 — 이게 이 기능의 전부다.
    expect(created!.description).toContain(REFERENCE_BLOCK_OPEN);
    expect(created!.description).toContain(REFERENCE_BLOCK_CLOSE);
    expect(created!.description).toContain(`@session:${selectedId}`);
    expect(created!.description).toContain('작업 시작 전 반드시 읽을 것');
    // 사용자가 친 문장은 그대로 앞에 남는다.
    expect(created!.description).toContain('이전 작업을 참고:');
  });

  test('팝오버가 열린 상태의 Esc는 팝오버만 닫고 다이얼로그는 두 번째 Esc에서 닫힌다', async ({
    page,
    seedCard,
  }) => {
    const marker = uniqueMarker();
    await seedCard({
      title: '[E2E] mention esc source',
      description: `${marker} esc 검증용 본문`,
      sessionId: `e2e-mention-session-${marker}`,
      projectDir: '/Users/test/mention-project',
    });

    await openCreateDialog(page, `[E2E] mention esc ${marker}`);
    await typeMention(page, '참고: ', marker, 1);

    const popover = page.locator('.kv2-mention-pop');
    const dialog = page.locator('.kv2-dialog');

    const prompt = page.locator('#create-card-description-input');
    await prompt.press('Escape');

    // 팝오버만 닫힌다. `DialogSkeleton`이 Escape로 다이얼로그를 닫으므로,
    // 여기서 stopPropagation이 빠지면 작성 중이던 카드가 통째로 사라진다.
    await expect(popover).toBeHidden();
    await expect(dialog).toBeVisible();
    await expect(prompt).toHaveValue(new RegExp(`@${marker}$`));

    // 팝오버가 닫힌 뒤의 Esc는 평소대로 다이얼로그를 닫는다.
    await prompt.press('Escape');
    await expect(dialog).toBeHidden();
  });

  test('칩의 ×는 본문에서 토큰을 지운다 (칩 state가 아니라 텍스트를 고친다)', async ({
    page,
    seedCard,
  }) => {
    const marker = uniqueMarker();
    await seedCard({
      title: '[E2E] mention remove source',
      description: `${marker} 제거 검증용 본문`,
      sessionId: `e2e-mention-session-${marker}`,
      projectDir: '/Users/test/mention-project',
    });

    await openCreateDialog(page, `[E2E] mention remove ${marker}`);
    await typeMention(page, '참고: ', marker, 1);

    const prompt = page.locator('#create-card-description-input');
    await prompt.press('Enter');

    const chips = page.locator('.kv2-ref-chip');
    await expect(chips).toHaveCount(1);
    await expect(prompt).toHaveValue(/@session:/);

    await chips.first().locator('.kv2-ref-chip-remove').click();

    // 칩이 사라지는 것은 결과이고, 원인은 본문에서 토큰이 없어진 것이다.
    await expect(prompt).not.toHaveValue(/@session:/);
    await expect(chips).toHaveCount(0);
    await expect(page.locator('.kv2-ref-strip')).toHaveCount(0);
  });

  test('이메일 주소는 멘션으로 오인되지 않는다', async ({ page }) => {
    await openCreateDialog(page, `[E2E] mention email ${Date.now()}`);
    const prompt = page.locator('#create-card-description-input');
    await prompt.click();
    await prompt.pressSequentially('junyeong@naverz', { delay: 10 });

    await expect(page.locator('.kv2-mention-pop')).toHaveCount(0);
  });
});
