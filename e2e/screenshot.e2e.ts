import { test, expect } from './fixtures/kanban';
import { apiUploadScreenshot, apiGetCards } from './helpers/api';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const TEST_IMAGE = path.join(__dirname, 'fixtures', 'test-screenshot.png');

test.describe('Screenshot - CreateCardModal', () => {
  test('create modal shows screenshot drop zone', async ({ page }) => {
    await page.goto('/');

    // Open create modal via New Task button in TODO column
    await page.locator('.kv2-create-btn').click();
    await expect(page.locator('.kv2-dialog-overlay')).toBeVisible();

    const dropZone = page.locator('.kv2-create-drop-zone');
    await expect(dropZone).toBeVisible();
    await expect(dropZone).toContainText('Click or drop screenshots');
  });

  test('attaching file shows preview thumbnail', async ({ page }) => {
    await page.goto('/');
    await page.locator('.kv2-create-btn').click();
    await expect(page.locator('.kv2-dialog')).toBeVisible();

    // Attach file via hidden input
    const fileInput = page.locator('.kv2-dialog input[type="file"][accept="image/*"]');
    await fileInput.setInputFiles(TEST_IMAGE);

    // Verify thumbnail appears
    await expect(page.locator('.kv2-screenshot-img')).toBeVisible();
    await expect(page.locator('.kv2-screenshot-card')).toHaveCount(1);
  });

  test('remove pending screenshot removes thumbnail', async ({ page }) => {
    await page.goto('/');
    await page.locator('.kv2-create-btn').click();
    await expect(page.locator('.kv2-dialog')).toBeVisible();

    // Attach file
    const fileInput = page.locator('.kv2-dialog input[type="file"][accept="image/*"]');
    await fileInput.setInputFiles(TEST_IMAGE);
    await expect(page.locator('.kv2-screenshot-img')).toBeVisible();

    // Click remove button
    await page.locator('.kv2-screenshot-delete').click();

    // Verify thumbnail is gone
    await expect(page.locator('.kv2-screenshot-card')).toHaveCount(0);
  });

  test('create card with screenshot uploads successfully', async ({ page, trackCard }) => {
    await page.goto('/');
    await page.locator('.kv2-create-btn').click();
    await expect(page.locator('.kv2-dialog')).toBeVisible();

    // Fill required fields
    await page.locator('#create-card-title-input').fill('[E2E] Screenshot Upload Test');
    await page.locator('#create-card-description-input').fill('Testing screenshot upload during card creation');

    // Attach screenshot
    const fileInput = page.locator('.kv2-dialog input[type="file"][accept="image/*"]');
    await fileInput.setInputFiles(TEST_IMAGE);
    await expect(page.locator('.kv2-screenshot-img')).toBeVisible();

    // Click CREATE button
    await page.getByRole('button', { name: 'CREATE', exact: true }).click();

    // Wait for modal to close (card created + screenshots uploaded)
    await expect(page.locator('.kv2-dialog-overlay')).not.toBeVisible({ timeout: 10_000 });

    // Verify card exists with screenshot via API
    const cards = await apiGetCards();
    const created = cards.find(c => c.title === '[E2E] Screenshot Upload Test');
    expect(created).toBeDefined();
    trackCard(created!.id);
    expect(created!.screenshots).toBeDefined();
    expect(created!.screenshots!.length).toBe(1);
    expect(created!.screenshots![0].originalName).toBe('test-screenshot.png');
  });
});

test.describe('Screenshot - CardDetailModal', () => {
  test('uploading screenshot shows thumbnail immediately without refresh', async ({ page, seedCard }) => {
    const card = await seedCard({ title: '[E2E] Screenshot Immediate', description: 'Test immediate thumbnail' });
    await page.goto('/');

    // Click card to open detail modal
    const cardEl = page.locator('.kv2-card', { hasText: '[E2E] Screenshot Immediate' });
    await expect(cardEl).toBeVisible();
    await cardEl.click();
    await expect(page.locator('.kv2-dialog-overlay')).toBeVisible();

    // Verify no screenshots initially
    await expect(page.locator('.kv2-dialog .kv2-screenshot-thumb')).toHaveCount(0);

    // Upload screenshot via file input in detail modal
    const fileInput = page.locator('.kv2-dialog input[type="file"][accept="image/*"]');
    await fileInput.setInputFiles(TEST_IMAGE);

    // Verify thumbnail appears immediately (no page refresh needed)
    await expect(page.locator('.kv2-dialog .kv2-screenshot-thumb')).toBeVisible({ timeout: 5_000 });
    await expect(page.locator('.kv2-dialog .kv2-screenshot-item')).toHaveCount(1);
  });

  test('screenshot uploaded via API is visible in detail modal', async ({ page, seedCard }) => {
    // Upload screenshot via API first
    const card = await seedCard({ title: '[E2E] Screenshot API', description: 'Test API screenshot' });
    await apiUploadScreenshot(card.id, TEST_IMAGE);

    await page.goto('/');

    // Open detail modal
    const cardEl = page.locator('.kv2-card', { hasText: '[E2E] Screenshot API' });
    await expect(cardEl).toBeVisible();
    await cardEl.click();
    await expect(page.locator('.kv2-dialog')).toBeVisible();

    // Verify screenshot thumbnail is visible
    await expect(page.locator('.kv2-dialog .kv2-screenshot-thumb')).toBeVisible();
  });
});
