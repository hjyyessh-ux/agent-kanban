import { test, expect } from './fixtures/kanban';

test.describe('Board — TODO column drag-and-drop reorder', () => {
  test('dragging a card to a new slot persists across reload, and later cards shift down', async ({ page, seedCard }) => {
    // Oldest first, so default (newest-first) DOM order is Gamma, Beta, Alpha.
    const alpha = await seedCard({ title: '[E2E-DND] Alpha', description: 'oldest' });
    const beta = await seedCard({ title: '[E2E-DND] Beta', description: 'middle' });
    const gamma = await seedCard({ title: '[E2E-DND] Gamma', description: 'newest' });
    void alpha; void beta; void gamma;

    await page.goto('/');

    const todoColumn = page.locator('.kv2-column[data-status="todo"]');
    const dndTitles = () => todoColumn.locator('.kv2-card-title').allTextContents()
      .then((titles) => titles.filter((t) => t.includes('[E2E-DND]')));

    await expect(todoColumn.locator('.kv2-card-title').first()).toBeVisible();
    expect(await dndTitles()).toEqual(['[E2E-DND] Gamma', '[E2E-DND] Beta', '[E2E-DND] Alpha']);

    // Drag Alpha (bottom) to the top slot, above Gamma, grabbing it by the card
    // BODY (title) — the whole card is the drag source, not a small handle icon.
    // The board's drag-and-drop is a hand-rolled native HTML5 DnD (not a library),
    // which Playwright's mouse-based dragTo() cannot reliably trigger — dispatch
    // the same DragEvents the app listens for.
    await page.evaluate(
      ({ sourceId, targetId }) => {
        const dataTransfer = new DataTransfer();
        const source = document.querySelector(`.kv2-card[data-id="${sourceId}"] .kv2-card-title`);
        const target = document.querySelector(`.kv2-card[data-id="${targetId}"]`);
        const columnBody = target?.closest('.kv2-column-body');
        if (!source || !target || !columnBody) throw new Error('drag elements not found');

        const rect = target.getBoundingClientRect();
        const near = { clientX: rect.left + 10, clientY: rect.top + 2 };

        source.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer }));
        columnBody.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer, ...near }));
        columnBody.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer, ...near }));
        source.dispatchEvent(new DragEvent('dragend', { bubbles: true, cancelable: true, dataTransfer }));
      },
      { sourceId: alpha.id, targetId: gamma.id },
    );

    // Alpha now leads; Gamma and Beta both shifted down one slot.
    await expect(async () => {
      expect(await dndTitles()).toEqual(['[E2E-DND] Alpha', '[E2E-DND] Gamma', '[E2E-DND] Beta']);
    }).toPass({ timeout: 5_000 });

    // The reorder must be a real, persisted move — not just a visual reflow.
    await page.reload();
    await expect(todoColumn.locator('.kv2-card-title').first()).toBeVisible();
    await expect(async () => {
      expect(await dndTitles()).toEqual(['[E2E-DND] Alpha', '[E2E-DND] Gamma', '[E2E-DND] Beta']);
    }).toPass({ timeout: 5_000 });

    // A brand-new card must still land on top, above the now-manually-ordered
    // cards — regression check for a bug where new cards sank to the bottom.
    const delta = await seedCard({ title: '[E2E-DND] Delta', description: 'newest, unordered' });
    void delta;
    await page.reload();
    await expect(async () => {
      expect(await dndTitles()).toEqual([
        '[E2E-DND] Delta', '[E2E-DND] Alpha', '[E2E-DND] Gamma', '[E2E-DND] Beta',
      ]);
    }).toPass({ timeout: 5_000 });
  });
});
