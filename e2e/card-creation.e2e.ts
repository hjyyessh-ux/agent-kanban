import { test, expect } from './fixtures/kanban';
import { apiE2ESetClock, apiUpdateCard, apiGetCards } from './helpers/api';

function futureKstSchedule(offsetMinutes: number): { input: string; labelPattern: RegExp } {
  const date = new Date(Date.now() + offsetMinutes * 60_000);
  date.setSeconds(0, 0);
  const kst = new Date(date.getTime() + 9 * 60 * 60_000);
  const pad = (value: number) => String(value).padStart(2, '0');
  const stamp = `${kst.getUTCFullYear()}-${pad(kst.getUTCMonth() + 1)}-${pad(kst.getUTCDate())}`;
  const time = `${pad(kst.getUTCHours())}:${pad(kst.getUTCMinutes())}`;
  return {
    input: `${stamp}T${time}`,
    labelPattern: new RegExp(`${stamp} ${time} KST`),
  };
}

test.describe('Card Creation', () => {
  test('created card appears in TODO column', async ({ page, seedCard }) => {
    const card = await seedCard({ title: '[E2E] New Card Test', description: 'E2E test description' });
    await page.goto('/');

    const todoColumn = page.locator('.kv2-column[data-status="todo"]');
    const cardTitle = todoColumn.locator('.kv2-card-title', { hasText: card.title });
    await expect(cardTitle).toBeVisible();
  });

  test('created card shows prompt summary', async ({ page, seedCard }) => {
    const card = await seedCard({ title: '[E2E] Phase Test', description: 'Testing prompt phase' });
    await page.goto('/');

    const todoColumn = page.locator('.kv2-column[data-status="todo"]');
    const cardEl = todoColumn.locator('.kv2-card', { hasText: card.title });
    await expect(cardEl.locator('.kv2-card-section-label', { hasText: 'PROMPT' })).toBeVisible();
    await expect(cardEl.locator('.kv2-card-prompt')).toBeVisible();
  });

  test('create card with projectDir stores it via API', async ({ seedCard }) => {
    const card = await seedCard({ title: '[E2E] Dir Card', description: 'Directory test' });
    await apiUpdateCard(card.id, { projectDir: '/Users/test/project' });

    const cards = await apiGetCards();
    const updated = cards.find(c => c.id === card.id);
    expect(updated).toBeDefined();
    expect(updated!.projectDir).toBe('/Users/test/project');
  });

  test('create dialog shows inline alert before submit when required fields are missing', async ({ page }) => {
    await page.goto('/');

    await page.getByRole('button', { name: 'Create new card' }).click();
    await page.getByRole('button', { name: 'CREATE', exact: true }).click();

    const inlineAlert = page.locator('.kv2-create-alert');
    await expect(inlineAlert).toBeVisible();
    await expect(inlineAlert).toContainText('Missing required information');
    await expect(page.locator('#create-card-title-input')).toHaveAttribute('aria-invalid', 'true');
    await expect(page.locator('#create-card-description-input')).toHaveAttribute('aria-invalid', 'true');
  });

  test('create dialog schedules directly from the launch timing selector and shows the badge immediately', async ({ page }) => {
    const title = `[E2E] Scheduled Create ${Date.now()}`;
    const schedule = futureKstSchedule(30);
    await apiE2ESetClock(new Date().toISOString());

    await page.goto('/');
    await page.getByRole('button', { name: 'Create new card' }).click();
    const scheduleToggle = page.getByRole('button', { name: 'Schedule', exact: true });
    await expect(scheduleToggle).toHaveAttribute('aria-expanded', 'false');
    await expect(page.getByRole('switch', { name: /예약 시작/ })).toHaveCount(0);
    await scheduleToggle.click();
    await expect(scheduleToggle).toHaveAttribute('aria-expanded', 'true');
    const scheduleSwitch = page.getByRole('switch', { name: /예약 시작/ });
    await expect(scheduleSwitch).toHaveAttribute('aria-checked', 'false');
    await expect(page.locator('#create-card-schedule-datetime')).toHaveCount(0);
    await expect(page.getByText('지금 시작', { exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'CREATE', exact: true })).toBeVisible();
    await page.locator('#create-card-title-input').fill(title);
    await page.locator('#create-card-description-input').fill('Create and schedule in one step');
    await scheduleSwitch.click();
    await expect(scheduleSwitch).toHaveAttribute('aria-checked', 'true');
    await page.locator('#create-card-schedule-datetime').fill(schedule.input);
    await page.getByRole('button', { name: 'CREATE & SCHEDULE', exact: true }).click();

    const todoCard = page.locator('.kv2-column[data-status="todo"] .kv2-card', { hasText: title });
    await expect(todoCard).toBeVisible();
    await expect(todoCard.locator('.kv2-scheduled-badge')).toHaveAttribute('aria-label', schedule.labelPattern);

    await page.reload();
    const reloadedCard = page.locator('.kv2-column[data-status="todo"] .kv2-card', { hasText: title });
    await expect(reloadedCard.locator('.kv2-scheduled-badge')).toHaveAttribute('aria-label', schedule.labelPattern);
    await expect(reloadedCard.getByRole('button', { name: 'Reschedule', exact: true })).toBeVisible();
    await expect(reloadedCard.getByRole('button', { name: 'Cancel schedule', exact: true })).toBeVisible();
  });

  test('390px create footer preserves button meaning for schedule mode', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/');

    await page.getByRole('button', { name: 'Create new card' }).click();
    await page.getByRole('button', { name: 'Schedule', exact: true }).click();
    await page.getByRole('switch', { name: /예약 시작/ }).click();
    await expect(page.getByRole('button', { name: 'Cancel', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'CREATE & SCHEDULE', exact: true })).toBeVisible();
  });
});
