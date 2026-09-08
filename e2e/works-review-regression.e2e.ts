import { test, expect } from './fixtures/kanban';
import { apiAddWorkSession, apiArchiveCards, apiResetWorksState, apiUpdateCard } from './helpers/api';

test.beforeEach(async () => { await apiResetWorksState(); });

for (const width of [1440, 390]) {
  test(`Works combines assignment and active work without overflow at ${width}px`, async ({ page, seedCard, seedWork }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    const work = await seedWork({ title: '검색과 결과 개선' });
    await seedCard({ title: '연결된 작업', description: 'Works review fixture', sessionId: 'linked-layout' });
    await apiAddWorkSession(work.id, { sessionId: 'linked-layout' });
    for (let i = 0; i < 30; i++) await seedCard({ title: `미배정 세션 ${i}`, description: 'Works review fixture', sessionId: `layout-inbox-${i}` });
    await page.goto('/');
    await page.getByRole('tab', { name: 'Works' }).click();
    const title = page.getByRole('button', { name: work.title, exact: true });
    await expect(page.locator('.works-inbox')).toBeInViewport();
    await expect(page.locator('.works-navigation button')).toHaveText(['진행 중 1', '완료·폐기 0']);
    await expect(page.locator('.works-inbox-row-group')).toHaveCount(30);
    await expect(page.locator('.works-inbox-row-group').first().getByRole('button', { name: '배정', exact: true })).toBeInViewport();
    const inboxBox = await page.locator('.works-inbox-rows').boundingBox();
    expect(inboxBox!.height).toBeLessThanOrEqual(width === 390 ? 280 : 480);
    if (width === 1440) await expect(title).toBeInViewport();
    await expect(page.locator('.works-card')).toContainText('카드 1');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`works-${width}.png`), fullPage: true });
    await title.click();
    const detail = page.getByRole('dialog', { name: work.title, exact: true });
    await expect(detail.getByLabel('Start', { exact: true })).toBeVisible();
    await expect(detail.getByLabel('Planned end', { exact: true })).toBeVisible();
    await expect(detail.getByRole('button', { name: /Directory/ })).toBeVisible();
    expect(await detail.locator('.work-detail-overview').evaluate(element =>
      Boolean(element.compareDocumentPosition(element.parentElement!.querySelector('.work-summary')!) & Node.DOCUMENT_POSITION_FOLLOWING),
    )).toBe(true);
    await expect(detail.getByRole('button', { name: /^(활동·타임라인|결과|개요|관리)$/ })).toHaveCount(0);
    await expect(detail.getByLabel('연결할 세션')).toBeVisible();
    await expect(detail.getByRole('button', { name: '폐기…', exact: true })).toBeVisible();
    await expect(detail.getByRole('button', { name: '삭제…', exact: true })).toBeVisible();
    await expect(detail.getByRole('button', { name: '⇉ 다른 Work에 병합…' })).toBeVisible();
    await expect(detail.getByLabel('보관된 Work의 Wiki')).toHaveCount(0);
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
  await expect(detail.locator('.work-session-meta')).toContainText('카드 2');
  await detail.locator('.work-session-item').getByRole('button', { name: '대화', exact: true }).click();
  await expect(page.locator('.session-conversation-dialog')).toContainText('첫 번째 결과');
});

test('the visible session picker adds sessions and conversation includes archived and live turns', async ({ page, seedCard, seedWork }, testInfo) => {
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
  await expect(detail.getByLabel('연결할 세션')).toBeVisible();
  await detail.getByLabel('연결할 세션').selectOption('additional-review');
  await detail.getByRole('button', { name: '이 Work에 연결' }).click();
  await expect(detail.locator('.work-session-list')).toContainText('추가 리뷰');
  await page.screenshot({ path: testInfo.outputPath('sessions-mobile.png'), fullPage: true });
  await detail.locator('.work-session-item').filter({ hasText: '이전 결정' }).getByRole('button', { name: '대화', exact: true }).click();
  const conversation = page.locator('.session-conversation-dialog');
  await expect(conversation).toContainText('이전 프롬프트');
  await expect(conversation).toContainText('후속 프롬프트');
  await expect(conversation).toContainText('기존 결정: JSON 보관을 유지합니다.');
  await expect(conversation).toContainText('후속 검증도 통과했습니다.');
});

test('bulk archiving reveals the Wiki directory and generated documents update in place', async ({ page, seedCard, seedWork }, testInfo) => {
  const work = await seedWork({ title: '보관 후 Wiki에서 확인' });
  const card = await seedCard({ title: '문서로 남길 결정', description: 'Wiki archive fixture', sessionId: 'wiki-directory' });
  await apiUpdateCard(card.id, { status: 'complete', result: '저장 경로와 문서를 함께 표시합니다.' });
  await apiAddWorkSession(work.id, { sessionId: 'wiki-directory' });
  await page.route('**/api/wiki/config', route => route.fulfill({ json: {
    configured: true, enabled: true, vaultDir: '/tmp/works-review-vault', model: 'test', route: 'codex', effort: 'low',
  } }));
  await page.goto('/');
  await page.getByRole('tab', { name: 'Works' }).click();
  await page.getByRole('button', { name: work.title, exact: true }).click();
  const detail = page.getByRole('dialog', { name: work.title, exact: true });
  await expect(detail.getByLabel('보관된 Work의 Wiki')).toHaveCount(0);
  await expect(detail.getByRole('button', { name: '결과', exact: true })).toHaveCount(0);
  await detail.getByRole('button', { name: '✔ 완료 (일괄 archive)' }).click();
  await page.getByRole('dialog', { name: '완료 확인', exact: true }).getByRole('button', { name: '✔ 완료 (일괄 archive)' }).click();
  await expect(detail).toHaveCount(0);
  await page.getByRole('button', { name: /^완료·폐기 \d/ }).click();
  await page.getByRole('button', { name: work.title, exact: true }).click();
  const wiki = detail.getByLabel('보관된 Work의 Wiki');
  await expect(wiki).toContainText('/tmp/works-review-vault');
  await expect(wiki).toContainText('Wiki 문서 생성 대기 중');

  // Simulate the read response after wiki generation; never invoke a real LLM.
  await page.route(`**/api/works/${work.id}/sessions`, async route => {
    const response = await route.fetch();
    const body = await response.json();
    await route.fulfill({ json: { ...body, wikiDocPaths: ['decision/work-note.md'], wikiPending: false } });
  });
  await page.route('**/api/wiki/doc?*', route => route.fulfill({ json: {
    path: 'decision/work-note.md', content: '# Work 기록\n\n저장 경로와 문서를 함께 표시합니다.',
  } }));
  const doc = wiki.getByRole('button', { name: 'decision/work-note.md', exact: true });
  await expect(doc).toBeVisible({ timeout: 12000 });
  await expect(wiki).not.toContainText('생성 대기 중');
  await wiki.scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath('archived-wiki-directory.png'), fullPage: true });
  await doc.click();
  await expect(page.getByRole('dialog', { name: 'Wiki 문서', exact: true })).toContainText('저장 경로와 문서를 함께 표시합니다.');
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
