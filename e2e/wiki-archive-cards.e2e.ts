import { test, expect } from './fixtures/kanban';
import { apiArchiveCards, apiCreateCard, apiUpdateCard } from './helpers/api';

const ARCHIVE_CARD_COUNT = 55;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test('Wiki Archive Cards shows first page and loads more cards', async ({ page }) => {
  const runId = `wiki-archive-${Date.now()}`;
  const cardIds: string[] = [];

  for (let i = 0; i < ARCHIVE_CARD_COUNT; i++) {
    const card = await apiCreateCard({
      title: `[E2E Wiki Archive ${runId}] ${i}`,
      description: 'Archive Cards pagination fixture',
    });
    cardIds.push(card.id);
    await apiUpdateCard(card.id, { status: 'done' });
    await sleep(2);
  }
  await apiArchiveCards(cardIds);

  await page.goto('/');
  await page.getByRole('tab', { name: 'Wiki' }).click();

  await expect(page.getByText('Kept 카드')).toBeVisible();
  const archiveStat = page.getByRole('button', { name: /Archive Cards/i });
  await expect(archiveStat).toBeVisible();
  await archiveStat.click();

  const search = page.getByRole('searchbox');
  await search.fill(runId);

  await expect(page.getByText(`[E2E Wiki Archive ${runId}] 54`)).toBeVisible();
  await expect(page.getByText(`[E2E Wiki Archive ${runId}] 0`)).toHaveCount(0);

  await page.getByRole('button', { name: 'Load more' }).click();
  await expect(page.getByText(`[E2E Wiki Archive ${runId}] 0`)).toBeVisible();

  await search.fill(`no-match-${runId}`);
  await expect(page.getByText('조건에 맞는 아카이브 카드가 없습니다.')).toBeVisible();
});

test('Wiki Archive Cards falls back when the paginated API is missing', async ({ page }) => {
  const runId = `wiki-archive-fallback-${Date.now()}`;
  const card = await apiCreateCard({
    title: `[E2E Wiki Archive Fallback ${runId}]`,
    description: 'Legacy archive API fallback fixture',
  });
  await apiUpdateCard(card.id, { status: 'done' });
  await apiArchiveCards([card.id]);

  await page.route('**/api/wiki/archive/cards**', async (route) => {
    await route.fulfill({
      status: 404,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'Not found' }),
    });
  });

  await page.goto('/');
  await page.getByRole('tab', { name: 'Wiki' }).click();
  await page.getByRole('button', { name: /Archive Cards/i }).click();
  await page.getByRole('searchbox').fill(runId);

  await expect(page.getByText(`[E2E Wiki Archive Fallback ${runId}]`)).toBeVisible();
  await expect(page.getByText(/Archive Cards error/i)).toHaveCount(0);
});

test('Wiki Archive Cards shows API errors', async ({ page }) => {
  await page.route('**/api/wiki/archive/cards**', async (route) => {
    await route.fulfill({
      status: 500,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'forced archive error' }),
    });
  });

  await page.goto('/');
  await page.getByRole('tab', { name: 'Wiki' }).click();
  await page.getByRole('button', { name: /Archive Cards/i }).click();

  await expect(page.getByRole('alert').filter({ hasText: 'forced archive error' })).toBeVisible();
  await expect(page.getByText('Archive Cards를 불러오지 못했습니다.')).toBeVisible();
});
