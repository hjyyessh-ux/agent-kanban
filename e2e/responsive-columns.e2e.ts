import { test, expect } from './fixtures/kanban';

/**
 * Responsive Column Width Tests
 *
 * Tests that kanban board columns are evenly distributed across various
 * viewport sizes — tablet portrait, tablet landscape, small desktop,
 * and large desktop. Catches issues where one column (e.g., "Complete")
 * takes disproportionate width due to long header text or content overflow.
 */

const VIEWPORTS = {
  /** iPad Mini portrait */
  tabletPortrait: { width: 768, height: 1024 },
  /** iPad portrait */
  iPadPortrait: { width: 810, height: 1080 },
  /** iPad landscape */
  tabletLandscape: { width: 1024, height: 768 },
  /** iPad Pro landscape */
  iPadProLandscape: { width: 1194, height: 834 },
  /** Small desktop / large tablet */
  smallDesktop: { width: 1280, height: 800 },
  /** Standard desktop */
  desktop: { width: 1440, height: 900 },
  /** Galaxy Tab S8 portrait */
  galaxyTabPortrait: { width: 753, height: 1205 },
  /** Surface Pro portrait-ish */
  surfacePro: { width: 912, height: 1368 },
} as const;

test.describe('Responsive Column Widths', () => {

  test('desktop (1440px): all 4 columns have equal width', async ({ page, seedCard }) => {
    await seedCard({ title: '[E2E] Col Width Desktop', description: 'Test card for column width measurement' });
    await page.setViewportSize(VIEWPORTS.desktop);
    await page.goto('/');
    await expect(page.locator('.kv2-board')).toBeVisible();

    const widths = await page.locator('.kv2-column').evaluateAll(els =>
      els.map(el => Math.round(el.getBoundingClientRect().width))
    );

    expect(widths).toHaveLength(4);
    // All columns should be within 5px of each other (equal 1fr)
    const maxWidth = Math.max(...widths);
    const minWidth = Math.min(...widths);
    expect(maxWidth - minWidth).toBeLessThanOrEqual(5);
  });

  test('small desktop (1280px): all 4 columns have equal width', async ({ page, seedCard }) => {
    await seedCard({ title: '[E2E] Col Width SmallDesktop', description: 'Test card' });
    await page.setViewportSize(VIEWPORTS.smallDesktop);
    await page.goto('/');
    await expect(page.locator('.kv2-board')).toBeVisible();

    const widths = await page.locator('.kv2-column').evaluateAll(els =>
      els.map(el => Math.round(el.getBoundingClientRect().width))
    );

    expect(widths).toHaveLength(4);
    const maxWidth = Math.max(...widths);
    const minWidth = Math.min(...widths);
    expect(maxWidth - minWidth).toBeLessThanOrEqual(5);
  });

  test('iPad Pro landscape (1194px): columns have equal width within their row', async ({ page, seedCard }) => {
    await seedCard({ title: '[E2E] Col Width iPadProLand', description: 'Test card' });
    await page.setViewportSize(VIEWPORTS.iPadProLandscape);
    await page.goto('/');
    await expect(page.locator('.kv2-board')).toBeVisible();

    const rects = await page.locator('.kv2-column').evaluateAll(els =>
      els.map(el => {
        const r = el.getBoundingClientRect();
        return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width) };
      })
    );

    // At 1194px (> 1024px breakpoint), should be 4 columns side-by-side
    // OR if it falls into 2-col layout, columns in the same row should be equal width
    const uniqueY = new Set(rects.map(r => r.y));

    for (const y of uniqueY) {
      const rowWidths = rects.filter(r => r.y === y).map(r => r.width);
      if (rowWidths.length > 1) {
        const maxW = Math.max(...rowWidths);
        const minW = Math.min(...rowWidths);
        expect(maxW - minW).toBeLessThanOrEqual(5);
      }
    }
  });

  test('tablet landscape (1024px): 2-col layout with equal column widths', async ({ page, seedCard }) => {
    await seedCard({ title: '[E2E] Col Width TabLand', description: 'Test card' });
    await page.setViewportSize(VIEWPORTS.tabletLandscape);
    await page.goto('/');
    await expect(page.locator('.kv2-board')).toBeVisible();

    const rects = await page.locator('.kv2-column').evaluateAll(els =>
      els.map(el => {
        const r = el.getBoundingClientRect();
        return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width) };
      })
    );

    // At exactly 1024px → triggers max-width: 1024px media query → 2-col layout
    // Columns in the same row must be equal width
    const uniqueY = new Set(rects.map(r => r.y));

    for (const y of uniqueY) {
      const rowWidths = rects.filter(r => r.y === y).map(r => r.width);
      if (rowWidths.length > 1) {
        const maxW = Math.max(...rowWidths);
        const minW = Math.min(...rowWidths);
        expect(maxW - minW).toBeLessThanOrEqual(5);
      }
    }
  });

  test('iPad portrait (810px): 2-col layout with equal column widths', async ({ page, seedCard }) => {
    await seedCard({ title: '[E2E] Col Width iPad', description: 'Test card' });
    await page.setViewportSize(VIEWPORTS.iPadPortrait);
    await page.goto('/');
    await expect(page.locator('.kv2-board')).toBeVisible();

    const rects = await page.locator('.kv2-column').evaluateAll(els =>
      els.map(el => {
        const r = el.getBoundingClientRect();
        return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width) };
      })
    );

    // At 810px → 2-col layout (between 768px and 1024px breakpoints)
    const uniqueY = new Set(rects.map(r => r.y));

    for (const y of uniqueY) {
      const rowWidths = rects.filter(r => r.y === y).map(r => r.width);
      if (rowWidths.length > 1) {
        const maxW = Math.max(...rowWidths);
        const minW = Math.min(...rowWidths);
        expect(maxW - minW).toBeLessThanOrEqual(5);
      }
    }
  });

  test('tablet portrait (768px): single column layout', async ({ page, seedCard }) => {
    await seedCard({ title: '[E2E] Col Width TabPortrait', description: 'Test card' });
    await page.setViewportSize(VIEWPORTS.tabletPortrait);
    await page.goto('/');
    await expect(page.locator('.kv2-board')).toBeVisible();

    const rects = await page.locator('.kv2-column').evaluateAll(els =>
      els.map(el => {
        const r = el.getBoundingClientRect();
        return { x: Math.round(r.x), width: Math.round(r.width) };
      })
    );

    // At 768px → single column (hits max-width: 768px breakpoint)
    // All columns should have same x position and same width
    const uniqueX = new Set(rects.map(r => r.x));
    expect(uniqueX.size).toBe(1);

    const widths = rects.map(r => r.width);
    const maxW = Math.max(...widths);
    const minW = Math.min(...widths);
    expect(maxW - minW).toBeLessThanOrEqual(5);
  });

  test('Galaxy Tab portrait (753px): single column layout', async ({ page, seedCard }) => {
    await seedCard({ title: '[E2E] Col Width Galaxy', description: 'Test card' });
    await page.setViewportSize(VIEWPORTS.galaxyTabPortrait);
    await page.goto('/');
    await expect(page.locator('.kv2-board')).toBeVisible();

    const rects = await page.locator('.kv2-column').evaluateAll(els =>
      els.map(el => {
        const r = el.getBoundingClientRect();
        return { x: Math.round(r.x), width: Math.round(r.width) };
      })
    );

    // Below 768px → single column
    const uniqueX = new Set(rects.map(r => r.x));
    expect(uniqueX.size).toBe(1);
  });

  test('Surface Pro (912px): 2-col layout with equal column widths', async ({ page, seedCard }) => {
    await seedCard({ title: '[E2E] Col Width Surface', description: 'Test card' });
    await page.setViewportSize(VIEWPORTS.surfacePro);
    await page.goto('/');
    await expect(page.locator('.kv2-board')).toBeVisible();

    const rects = await page.locator('.kv2-column').evaluateAll(els =>
      els.map(el => {
        const r = el.getBoundingClientRect();
        return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width) };
      })
    );

    // 912px → 2-col layout
    const uniqueY = new Set(rects.map(r => r.y));

    for (const y of uniqueY) {
      const rowWidths = rects.filter(r => r.y === y).map(r => r.width);
      if (rowWidths.length > 1) {
        const maxW = Math.max(...rowWidths);
        const minW = Math.min(...rowWidths);
        expect(maxW - minW).toBeLessThanOrEqual(5);
      }
    }
  });

  test('column header text does not overflow or cause uneven widths', async ({ page, seedCard }) => {
    // Seed cards in different statuses to ensure all columns have content
    await seedCard({ title: '[E2E] Header Overflow Test', description: 'Card to test header overflow' });

    // Test across multiple viewports
    for (const [name, size] of Object.entries(VIEWPORTS)) {
      await page.setViewportSize(size);
      await page.goto('/');
      await expect(page.locator('.kv2-board')).toBeVisible();

      // Check that no header text overflows its container
      const headerOverflows = await page.locator('.kv2-column-header').evaluateAll(els =>
        els.map(el => {
          return {
            text: el.querySelector('h2')?.textContent ?? '',
            overflowsX: el.scrollWidth > el.clientWidth,
          };
        })
      );

      for (const header of headerOverflows) {
        expect(header.overflowsX, `Header "${header.text}" overflows at ${name} (${size.width}x${size.height})`).toBe(false);
      }
    }
  });

  test('screenshot comparison: tablet viewports', async ({ page, seedCard }) => {
    await seedCard({ title: '[E2E] Screenshot Test', description: 'Visual regression card' });

    // Take screenshots at each tablet viewport for visual inspection
    for (const [name, size] of [
      ['tablet-portrait-768', VIEWPORTS.tabletPortrait],
      ['ipad-portrait-810', VIEWPORTS.iPadPortrait],
      ['tablet-landscape-1024', VIEWPORTS.tabletLandscape],
      ['ipad-pro-landscape-1194', VIEWPORTS.iPadProLandscape],
    ] as const) {
      await page.setViewportSize(size);
      await page.goto('/');
      await expect(page.locator('.kv2-board')).toBeVisible();
      await page.screenshot({ path: `e2e/results/responsive-${name}.png`, fullPage: true });
    }
  });
});
