import { test, expect } from './fixtures/kanban';
import type { Page } from '@playwright/test';
import {
  apiCreateCard,
  apiE2EAdvanceClock,
  apiE2EGetDispatchAttempts,
  apiE2EKickScheduledDispatch,
  apiE2ERestartServices,
  apiE2ESetClock,
  apiGetCards,
  apiGetSchedulers,
  apiGetSchedulerHistory,
} from './helpers/api';

const BASE_CLOCK = (() => {
  const date = new Date();
  date.setSeconds(0, 0);
  return date;
})();
const BASE_CLOCK_ISO = BASE_CLOCK.toISOString();

function baseClockPlus(offsetMinutes: number): string {
  return new Date(BASE_CLOCK.getTime() + offsetMinutes * 60_000).toISOString();
}

function kstScheduleAt(offsetMinutes: number): { input: string; labelPattern: RegExp } {
  const kst = new Date(BASE_CLOCK.getTime() + offsetMinutes * 60_000 + 9 * 60 * 60_000);
  const pad = (value: number) => String(value).padStart(2, '0');
  const stamp = `${kst.getUTCFullYear()}-${pad(kst.getUTCMonth() + 1)}-${pad(kst.getUTCDate())}`;
  const time = `${pad(kst.getUTCHours())}:${pad(kst.getUTCMinutes())}`;
  return {
    input: `${stamp}T${time}`,
    labelPattern: new RegExp(`${stamp} ${time} KST`),
  };
}
const VIEWPORTS = [
  { width: 1440, height: 1000 },
  { width: 1024, height: 768 },
  { width: 768, height: 1024 },
  { width: 390, height: 844 },
] as const;

function uniqueLabel(prefix: string): string {
  return `${prefix} ${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

async function findCardByTitle(title: string) {
  const cards = await apiGetCards();
  return cards.find((card) => card.title === title);
}

async function waitForCardStatus(title: string, status: string) {
  await expect.poll(async () => {
    const card = await findCardByTitle(title);
    return card?.status ?? null;
  }).toBe(status);
}

async function waitForScheduledStatus(title: string, status: string) {
  await expect.poll(async () => {
    const card = await findCardByTitle(title);
    const scheduled = card?.scheduledDispatch as { status?: string } | undefined;
    return scheduled?.status ?? null;
  }).toBe(status);
}

async function openScheduleDialogForCard(page: Page, title: string) {
  const card = page.locator('.kv2-column[data-status="todo"] .kv2-card', { hasText: title });
  await expect(card).toBeVisible();
  await card.getByRole('button', { name: 'Schedule', exact: true }).click();
  await expect(page.locator('.kv2-dialog')).toBeVisible();
  await expect(page.locator('#schedule-card-datetime')).toBeVisible();
}

async function saveScheduleDialog(page: Page, kstDateTime: string) {
  await page.locator('#schedule-card-datetime').fill(kstDateTime);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.locator('.kv2-dialog-overlay')).not.toBeVisible();
}

async function openCreateCardDialog(page: Page) {
  await page.getByRole('button', { name: 'Create new card' }).click();
  await expect(page.locator('.kv2-dialog')).toBeVisible();
}

async function setTheme(page: Page, theme: 'light' | 'dark') {
  await page.goto('/');
  await page.evaluate((nextTheme) => {
    localStorage.setItem('kanban-theme', nextTheme);
  }, theme);
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
}

test.describe('Scheduled dispatch and Scheduler user flows', () => {
  test.beforeEach(async () => {
    await apiE2ESetClock(BASE_CLOCK_ISO);
  });

  test('New Task 예약 시작 → CREATE & SCHEDULE → 보드 배지 → 상세 Reschedule/Cancel → due dispatch', async ({ page }) => {
    const title = uniqueLabel('[E2E-SCHEDULE] UI create');

    await page.goto('/');
    await openCreateCardDialog(page);
    await page.locator('#create-card-title-input').fill(title);
    await page.locator('#create-card-description-input').fill('scheduled dispatch from ui [hold-open]');
    const schedule = kstScheduleAt(15);
    await page.getByRole('button', { name: 'Schedule', exact: true }).click();
    await page.getByRole('switch', { name: /예약 시작/ }).click();
    await page.locator('#create-card-schedule-datetime').fill(schedule.input);
    await expect(page.getByRole('button', { name: 'CREATE & SCHEDULE', exact: true })).toBeEnabled();
    await page.getByRole('button', { name: 'CREATE & SCHEDULE', exact: true }).click();

    const todoCard = page.locator('.kv2-column[data-status="todo"] .kv2-card', { hasText: title });
    await expect(todoCard.locator('.kv2-scheduled-badge')).toBeVisible();
    await expect(todoCard.locator('.kv2-scheduled-badge')).toHaveAttribute('aria-label', schedule.labelPattern);
    await todoCard.click();
    const detailDialog = page.locator('.kv2-dialog').last();
    await expect(detailDialog.getByRole('button', { name: 'Reschedule', exact: true })).toBeVisible();
    await expect(detailDialog.getByRole('button', { name: 'Cancel schedule', exact: true })).toBeVisible();
    await page.keyboard.press('Escape');

    await apiE2EAdvanceClock(15 * 60_000, true);

    await waitForCardStatus(title, 'in_progress');
    await expect(page.locator('.kv2-column[data-status="in_progress"] .kv2-card', { hasText: title })).toHaveCount(1);
    expect((await findCardByTitle(title))?.scheduledDispatch?.status).toBe('dispatched');
  });

  test('New Task에서 Queue와 예약이 동시에 선택되지 않으며 이유가 보인다', async ({ page, seedCardWithStatus }) => {
    const queueParent = await seedCardWithStatus(
      { title: uniqueLabel('[E2E-SCHEDULE] create queue parent'), description: 'queue target' },
      'in_progress',
    );

    await page.goto('/');
    await openCreateCardDialog(page);
    await page.locator('#create-card-title-input').fill(uniqueLabel('[E2E-SCHEDULE] create queue-block'));
    await page.locator('#create-card-description-input').fill('queue and schedule exclusion');
    await page.getByRole('button', { name: 'Queue After' }).click();
    const queuePicker = page.locator('.kv2-session-config-card').last();
    await queuePicker.locator('.kv2-session-item', { hasText: queueParent.title }).getByRole('button', { name: 'SELECT', exact: true }).click();
    await page.getByRole('button', { name: 'Schedule', exact: true }).click();
    await expect(page.locator('#create-card-schedule-disabled-reason')).toContainText('Queue After가 설정되어 있어 예약 시작을 사용할 수 없습니다.');
    await expect(page.getByRole('switch', { name: /예약 시작/ })).toBeDisabled();
    await page.keyboard.press('Escape');

    await openCreateCardDialog(page);
    await page.locator('#create-card-title-input').fill(uniqueLabel('[E2E-SCHEDULE] create schedule-block'));
    await page.locator('#create-card-description-input').fill('schedule and queue exclusion');
    await page.getByRole('button', { name: 'Schedule', exact: true }).click();
    await page.getByRole('switch', { name: /예약 시작/ }).click();
    await expect(page.locator('#create-card-queue-disabled-reason')).toContainText('예약 시작이 설정되어 있어 Queue After를 사용할 수 없습니다.');
    await expect(page.getByRole('button', { name: 'Queue After' })).toBeDisabled();
    await page.keyboard.press('Escape');
  });

  test('reschedule/cancel/reload persists and restart dispatches overdue reservations once', async ({ page }) => {
    const title = uniqueLabel('[E2E-SCHEDULE] persist');
    await apiCreateCard({ title, description: 'restart overdue dispatch [hold-open]' });

    await page.goto('/');

    await openScheduleDialogForCard(page, title);
    await saveScheduleDialog(page, kstScheduleAt(20).input);

    const rescheduled = kstScheduleAt(30);
    const todoCard = page.locator('.kv2-column[data-status="todo"] .kv2-card', { hasText: title });
    await todoCard.getByRole('button', { name: 'Reschedule', exact: true }).click();
    await saveScheduleDialog(page, rescheduled.input);
    await expect(todoCard.locator('.kv2-scheduled-badge')).toHaveAttribute('aria-label', rescheduled.labelPattern);

    await page.reload();
    const reloadedCard = page.locator('.kv2-column[data-status="todo"] .kv2-card', { hasText: title });
    await expect(reloadedCard.locator('.kv2-scheduled-badge')).toHaveAttribute('aria-label', rescheduled.labelPattern);

    await reloadedCard.getByRole('button', { name: 'Cancel schedule', exact: true }).click();
    await expect(reloadedCard.locator('.kv2-scheduled-badge')).toHaveCount(0);

    await reloadedCard.getByRole('button', { name: 'Schedule', exact: true }).click();
    await saveScheduleDialog(page, kstScheduleAt(5).input);
    await waitForScheduledStatus(title, 'scheduled');

    await apiE2ESetClock(baseClockPlus(10));
    await apiE2ERestartServices();

    await waitForCardStatus(title, 'in_progress');
    expect(await apiE2EGetDispatchAttempts((await findCardByTitle(title))!.id)).toBe(1);
  });

  test('schedule/queue are mutually exclusive and scheduled Start Now races background dispatch only once', async ({ page, seedCardWithStatus }) => {
    const queueParent = await seedCardWithStatus(
      { title: uniqueLabel('[E2E-SCHEDULE] queue parent'), description: 'queue target' },
      'in_progress',
    );
    const queuedTitle = uniqueLabel('[E2E-SCHEDULE] queued');
    const scheduledTitle = uniqueLabel('[E2E-SCHEDULE] scheduled-race');
    await apiCreateCard({ title: queuedTitle, description: 'queued card candidate' });
    const scheduledCard = await apiCreateCard({ title: scheduledTitle, description: 'scheduled race [hold-open]' });

    await page.goto('/');

    const queuedCard = page.locator('.kv2-column[data-status="todo"] .kv2-card', { hasText: queuedTitle });
    await queuedCard.click();
    await page.locator('.kv2-dialog').getByRole('button', { name: 'Queue After' }).click();
    const targetItem = page.locator('#detail-queue-select .kv2-session-item', { hasText: queueParent.title });
    await targetItem.getByRole('button', { name: 'SELECT', exact: true }).click();
    await page.getByText('SAVE QUEUE SETTINGS').click();
    const detailDialog = page.locator('.kv2-dialog').last();
    await expect(detailDialog).toBeVisible();
    await detailDialog.getByRole('button', { name: 'Schedule for later', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('Queued cards cannot be scheduled');
    await page.keyboard.press('Escape');

    await openScheduleDialogForCard(page, scheduledTitle);
    await saveScheduleDialog(page, kstScheduleAt(10).input);
    const scheduledBoardCard = page.locator('.kv2-column[data-status="todo"] .kv2-card', { hasText: scheduledTitle });
    await scheduledBoardCard.getByRole('button', { name: 'Queue', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('예약된 카드는 먼저 예약을 취소해야 Queue에 넣을 수 있습니다.');

    await scheduledBoardCard.click();
    await apiE2ESetClock(baseClockPlus(10));
    await Promise.all([
      page.getByRole('button', { name: 'START NOW', exact: true }).click(),
      apiE2EKickScheduledDispatch(),
    ]);

    await waitForCardStatus(scheduledTitle, 'in_progress');
    expect(await apiE2EGetDispatchAttempts(scheduledCard.id)).toBe(1);
    expect((await findCardByTitle(scheduledTitle))?.scheduledDispatch?.status).toBe('dispatched');
  });

  test('Scheduler Bash 생성, 수동 실행, output 확인', async ({ page }) => {
    const name = uniqueLabel('[E2E-SCHEDULER] bash');

    await page.goto('/');
    await page.getByRole('tab', { name: 'Scheduler' }).click();
    await page.getByRole('button', { name: '새 Scheduler' }).click();
    await page.locator('#scheduler-name-input').fill(name);
    await page.locator('#scheduler-description-input').fill('bash output test');
    await page.getByRole('radio', { name: /Cron 직접 입력/ }).click();
    await expect(page.locator('#scheduler-cron-input')).toBeVisible();
    await page.locator('#scheduler-cron-input').fill('0 10 * * *');
    await page.locator('#scheduler-command-input').fill("printf 'scheduler bash ok\\n'");
    await page.getByRole('button', { name: 'Create scheduler', exact: true }).click();

    const entry = page.locator('.scheduler-item', { hasText: name });
    await expect(entry).toBeVisible();
    await entry.getByRole('button', { name: '지금 실행', exact: true }).click();
    await entry.getByRole('button', { name: /기록 1개/ }).click();

    await expect(page.locator('.scheduler-history-output')).toContainText('scheduler bash ok');
    const scheduler = (await apiGetSchedulers()).find((item) => item.name === name);
    expect(scheduler?.id).toBeTruthy();
    const history = await apiGetSchedulerHistory(scheduler!.id);
    expect(history[0]?.stdout).toContain('scheduler bash ok');
  });

  test('Scheduler Prompt runtime/model 선택 → 실행 → scheduler-origin badge/cardId → runtime dispatch', async ({ page }) => {
    const name = uniqueLabel('[E2E-SCHEDULER] prompt');

    await page.goto('/');
    await page.getByRole('tab', { name: 'Scheduler' }).click();
    await page.getByRole('button', { name: '새 Scheduler' }).click();
    await page.locator('#scheduler-name-input').fill(name);
    await page.locator('#scheduler-description-input').fill('prompt dispatch test');
    await page.getByRole('radio', { name: /Cron 직접 입력/ }).click();
    await expect(page.locator('#scheduler-cron-input')).toBeVisible();
    await page.locator('#scheduler-cron-input').fill('0 11 * * *');
    await page.getByRole('radio', { name: /Agent prompt/i }).click();
    await page.locator('#scheduler-prompt-input').fill('scheduler prompt runtime test [hold-open]');
    await page.getByRole('radio', { name: 'Codex' }).click();
    let modelValue = '';
    await expect.poll(async () => {
      modelValue = await page.locator('#scheduler-model-select option').evaluateAll((options) => {
        return options.find((option) => option.textContent?.includes('GPT-5.4'))?.getAttribute('value') ?? '';
      });
      return modelValue;
    }).not.toBe('');
    await page.locator('#scheduler-model-select').selectOption(modelValue);
    await page.getByRole('button', { name: 'Create scheduler', exact: true }).click();

    const entry = page.locator('.scheduler-item', { hasText: name });
    await expect(entry).toContainText('Codex · gpt-5.4');
    await entry.getByRole('button', { name: '지금 실행', exact: true }).click();
    const scheduler = (await apiGetSchedulers()).find((item) => item.name === name);
    expect(scheduler?.id).toBeTruthy();

    let schedulerCardId = '';
    await expect.poll(async () => {
      const history = await apiGetSchedulerHistory(scheduler!.id);
      schedulerCardId = history[0]?.cardId ?? '';
      return schedulerCardId;
    }).not.toBe('');

    const cards = await apiGetCards();
    const schedulerCard = cards.find((card) => card.id === schedulerCardId);
    expect(schedulerCard?.originChannel).toBe('scheduler');
    expect(schedulerCard?.agentRuntime).toBe('codex');
    expect(schedulerCard?.schedulerRunId).toBeTruthy();
    expect(schedulerCard?.schedulerId).toBeTruthy();
    expect(schedulerCard?.status).toBe('in_progress');

    await page.getByRole('tab', { name: 'Board' }).click();
    const schedulerBoardCard = page.locator('.kv2-column[data-status="in_progress"] .kv2-card', { hasText: name });
    await expect(schedulerBoardCard.locator('.kv2-scheduler-badge')).toBeVisible();
    await schedulerBoardCard.click();
    await expect(page.locator('.kv2-dialog .kv2-title-text')).toContainText(name);
  });

  test('light/dark, small viewport, keyboard Escape smoke', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/');

    await page.getByRole('button', { name: 'Create new card' }).click();
    await expect(page.locator('.kv2-dialog')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('.kv2-dialog-overlay')).not.toBeVisible();

    await page.getByRole('tab', { name: 'Settings' }).click();
    const themeGroup = page.getByRole('group', { name: 'Theme' });
    await themeGroup.getByRole('button', { name: /Dark/ }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await themeGroup.getByRole('button', { name: /Light/ }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');

    await page.getByRole('tab', { name: 'Scheduler' }).click();
    await page.getByRole('button', { name: '새 Scheduler' }).click();
    await expect(page.locator('.kv2-dialog')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('.kv2-dialog-overlay')).not.toBeVisible();
  });

  test('예약 시작 create dialog를 required viewport/light-dark로 캡처한다', async ({ page }) => {
    test.setTimeout(120000);

    for (const theme of ['light', 'dark'] as const) {
      for (const viewport of VIEWPORTS) {
        await page.setViewportSize(viewport);
        await setTheme(page, theme);
        await openCreateCardDialog(page);
        await page.locator('#create-card-title-input').fill(`Capture ${theme} ${viewport.width}`);
        await page.locator('#create-card-description-input').fill('viewport audit');
        await page.getByRole('button', { name: 'Schedule', exact: true }).click();
        await page.getByRole('switch', { name: /예약 시작/ }).click();
        await expect(page.locator('#create-card-schedule-datetime')).toBeVisible();
        await expect(page.getByRole('button', { name: 'CREATE & SCHEDULE', exact: true })).toBeVisible();
        await page.locator('.kv2-dialog').screenshot({
          path: `e2e/results/create-card-schedule-${theme}-${viewport.width}x${viewport.height}.png`,
        });
        await page.keyboard.press('Escape');
        await expect(page.locator('.kv2-dialog-overlay')).not.toBeVisible();
      }
    }
  });
});
