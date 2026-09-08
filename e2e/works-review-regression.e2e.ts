import { test, expect } from './fixtures/kanban';
import { apiAddWorkSession, apiArchiveCards, apiResetWorksState, apiUpdateCard } from './helpers/api';

test.beforeEach(async () => { await apiResetWorksState(); });

for (const width of [1440, 390]) {
  test(`Works opens on grouped work with a large Inbox at ${width}px`, async ({ page, seedCard, seedWork }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    const work = await seedWork({ title: '검색과 결과 개선' });
    await seedCard({ title: '연결된 작업', description: 'Works review fixture', sessionId: 'linked-layout' });
    await apiAddWorkSession(work.id, { sessionId: 'linked-layout' });
    for (let i = 0; i < 30; i++) await seedCard({ title: `미배정 세션 ${i}`, description: 'Works review fixture', sessionId: `layout-inbox-${i}` });
    await page.goto('/');
    await page.getByRole('tab', { name: 'Works' }).click();
    const title = page.getByRole('button', { name: work.title, exact: true });
    await expect(title).toBeInViewport();
    await expect(page.locator('.works-inbox')).not.toBeVisible();
    await expect(page.locator('.works-card')).toContainText('카드 1');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`works-${width}.png`), fullPage: true });
    await page.getByRole('button', { name: '미배정 30', exact: true }).click();
    await expect(page.locator('.works-inbox-row-group')).toHaveCount(30);
    await page.getByRole('button', { name: '진행 중 1', exact: true }).click();
    await title.click();
    const detail = page.getByRole('dialog', { name: work.title, exact: true });
    await expect(detail.getByText('연결된 세션', { exact: true })).toBeInViewport();
    await expect(detail.getByRole('button', { name: '삭제…' })).not.toBeVisible();
    await page.screenshot({ path: testInfo.outputPath(`detail-${width}.png`), fullPage: true });
  });
}

test('Work detail refreshes card activity while it remains open', async ({ page, seedCard, seedWork }) => {
  const work = await seedWork({ title: '열린 상세 갱신' });
  const first = await seedCard({ title: '첫 실행', description: 'Works review fixture', sessionId: 'polling-session' });
  await apiAddWorkSession(work.id, { sessionId: 'polling-session' });
  await page.goto('/');
  await page.getByRole('tab', { name: 'Works' }).click();
  await page.getByRole('button', { name: work.title, exact: true }).click();
  const detail = page.getByRole('dialog', { name: work.title, exact: true });
  await expect(detail.getByLabel('작업 현황')).toContainText('카드 1');
  await apiUpdateCard(first.id, { status: 'complete', result: '첫 번째 결과' });
  await seedCard({ title: '두 번째 실행', description: 'Works review fixture', sessionId: 'polling-session' });
  await expect(detail.getByLabel('작업 현황')).toContainText('카드 2', { timeout: 12000 });
  await expect(detail.getByLabel('작업 현황')).toContainText('완료 1');
  await detail.getByRole('button', { name: '활동·타임라인', exact: true }).click();
  await expect(detail.getByLabel('활동 타임라인')).toContainText('두 번째 실행');
  await detail.getByRole('button', { name: '결과', exact: true }).click();
  await expect(detail.getByLabel('작업 결과')).toContainText('첫 번째 결과');
});

test('results and conversation include archived and live turns, and sessions can be added', async ({ page, seedCard, seedWork }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const work = await seedWork({ title: '누적 기록 확인' });
  const old = await seedCard({ title: '이전 결정', description: '이전 프롬프트', sessionId: 'mixed-history' });
  await apiUpdateCard(old.id, { status: 'done', result: '기존 결정: JSON 보관을 유지합니다.' });
  await apiArchiveCards([old.id]);
  const live = await seedCard({ title: '후속 검증', description: '후속 프롬프트', sessionId: 'mixed-history' });
  await apiUpdateCard(live.id, { status: 'complete', result: '후속 검증도 통과했습니다.' });
  await apiAddWorkSession(work.id, { sessionId: 'mixed-history' });
  await seedCard({ title: '추가 리뷰', description: 'Works review fixture', sessionId: 'additional-review' });
  await page.goto('/');
  await page.getByRole('tab', { name: 'Works' }).click();
  await page.getByRole('button', { name: work.title, exact: true }).click();
  const detail = page.getByRole('dialog', { name: work.title, exact: true });
  await detail.getByText('＋ 세션 추가', { exact: true }).click();
  await detail.getByLabel('연결할 세션').selectOption('additional-review');
  await detail.getByRole('button', { name: '이 Work에 연결' }).click();
  await expect(detail.locator('.work-session-list')).toContainText('추가 리뷰');
  await detail.getByRole('button', { name: '결과', exact: true }).click();
  const results = detail.getByLabel('작업 결과');
  await expect(results).toContainText('기존 결정: JSON 보관을 유지합니다.');
  await expect(results).toContainText('후속 검증도 통과했습니다.');
  await page.screenshot({ path: testInfo.outputPath('results-mobile.png'), fullPage: true });
  await results.getByRole('button', { name: '대화 · 이어서 작업' }).first().click();
  const conversation = page.locator('.session-conversation-dialog');
  await expect(conversation).toContainText('이전 프롬프트');
  await expect(conversation).toContainText('후속 프롬프트');
  await expect(conversation).toContainText('기존 결정: JSON 보관을 유지합니다.');
});


test('a partial archive failure stays visible instead of closing as a success', async ({ page, seedCard, seedWork }) => {
  const work = await seedWork({ title: '보관 실패 표시' });
  const card = await seedCard({ title: '재검사 대상', description: 'partial archive fixture', sessionId: 'partial-sweep' });
  await apiAddWorkSession(work.id, { sessionId: 'partial-sweep' });
  await page.route(`**/api/works/${work.id}`, async route => {
    if (route.request().method() !== 'PATCH') return route.continue();
    await route.fulfill({ json: { ...work, status: 'done', sweep: {
      archivedCount: 0, failed: [{ cardId: card.id, message: '보관 직전 새 실행을 감지했습니다.' }],
    } } });
  });
  await page.goto('/');
  await page.getByRole('tab', { name: 'Works' }).click();
  await page.locator('.works-card').getByRole('button', { name: '완료…', exact: true }).click();
  const confirm = page.getByRole('dialog', { name: '완료 확인', exact: true });
  await confirm.getByRole('button', { name: '✔ 완료 (일괄 archive)' }).click();
  await expect(confirm).toBeVisible();
  await expect(confirm).toContainText('0개 보관 · 1개 실패');
  await expect(confirm).toContainText('보관 직전 새 실행을 감지했습니다.');
});
