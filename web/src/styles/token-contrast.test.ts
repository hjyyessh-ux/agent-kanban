import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  contrastRatio,
  hueDistance,
  hueOf,
  mixSrgb,
  parseThemeTokens,
  relativeLuminance,
  resolveTokenColor,
  type Rgb,
  type TokenMap,
} from './tokenColor';

/**
 * WCAG AA guard for the Works affinity palette's *text* tokens.
 *
 * The palette itself is a swatch series and is exempt (a 4px bar is not text),
 * but the Works tab also prints directory names and the `🔗 이어진 세션` mark in
 * those hues. That is what this file guards: the earlier code painted them in
 * the raw layer ① accent, which put the old `--kv2-dir-2` (#12967f) at 3.7:1 on
 * the light surface and `--kv2-affinity-chain` at 3.1:1 on the dark one — both
 * below AA,
 * and neither visible from reading the stylesheet.
 *
 * The tokens are read out of `kanban-v2.tokens.css` and evaluated (including
 * `color-mix`), so retuning a mix percentage in the stylesheet is checked here
 * with no second copy of the numbers to keep in sync.
 */
const CSS = readFileSync(join(import.meta.dir, 'kanban-v2.tokens.css'), 'utf-8');
const { light, dark } = parseThemeTokens(CSS);

const AA = 4.5;

/** Directory-name text sits on the panel surfaces, never on the app frame. */
const SURFACE_TOKENS = [
  '--kv2-surface',
  '--kv2-surface-raised',
  '--kv2-surface-sunken',
  '--kv2-surface-hover',
  '--kv2-app-bg',
];

/**
 * `.works-dir-chip` tints its own background from the accent, so the text has
 * to clear AA against the tint too — not just against the bare surface. Must
 * match the `color-mix` percentage in `Works.css`.
 */
const CHIP_TINT_PERCENT = 0.14;

const SLOTS = [1, 2, 3, 4, 5, 6, 7, 8] as const;

/** Every background a directory/lineage label can land on, for one theme. */
function backgrounds(tokens: TokenMap, accent: Rgb): { name: string; rgb: Rgb }[] {
  const surfaces = SURFACE_TOKENS.map((name) => ({ name, rgb: resolveTokenColor(name, tokens) }));
  return [
    ...surfaces,
    ...surfaces.map(({ name, rgb }) => ({
      name: `${name} + ${CHIP_TINT_PERCENT * 100}% tint`,
      rgb: mixSrgb(accent, CHIP_TINT_PERCENT, rgb),
    })),
  ];
}

function worstContrast(
  textToken: string,
  accentToken: string,
  tokens: TokenMap,
): { ratio: number; against: string } {
  const text = resolveTokenColor(textToken, tokens);
  const accent = resolveTokenColor(accentToken, tokens);
  let worst = { ratio: Infinity, against: '' };
  for (const bg of backgrounds(tokens, accent)) {
    const ratio = contrastRatio(text, bg.rgb);
    if (ratio < worst.ratio) worst = { ratio, against: bg.name };
  }
  return worst;
}

describe('Works affinity text tokens meet WCAG AA', () => {
  for (const theme of [{ label: 'light', tokens: light }, { label: 'dark', tokens: dark }]) {
    for (const slot of SLOTS) {
      test(`--kv2-dir-${slot}-text clears 4.5:1 in ${theme.label}`, () => {
        const worst = worstContrast(`--kv2-dir-${slot}-text`, `--kv2-dir-${slot}`, theme.tokens);
        expect(
          worst.ratio,
          `--kv2-dir-${slot}-text is ${worst.ratio.toFixed(2)}:1 on ${worst.against}`,
        ).toBeGreaterThanOrEqual(AA);
      });
    }

    test(`--kv2-affinity-chain-text clears 4.5:1 in ${theme.label}`, () => {
      const worst = worstContrast(
        '--kv2-affinity-chain-text',
        '--kv2-affinity-chain',
        theme.tokens,
      );
      expect(
        worst.ratio,
        `--kv2-affinity-chain-text is ${worst.ratio.toFixed(2)}:1 on ${worst.against}`,
      ).toBeGreaterThanOrEqual(AA);
    });
  }

  test('the raw accents are declared once — layer ① is not re-stated in dark', () => {
    // Layer ① is invariant by contract (docs/design-system.md): dark mode is
    // served by the `-text` twins, not by repainting the swatch.
    const { dark: overlaid } = parseThemeTokens(CSS);
    for (const slot of SLOTS) {
      expect(resolveTokenColor(`--kv2-dir-${slot}`, overlaid))
        .toEqual(resolveTokenColor(`--kv2-dir-${slot}`, light));
    }
  });

  test('each -text token keeps its slot hue instead of collapsing to ink', () => {
    // The cheap way to pass a contrast check is to mix so far toward
    // --kv2-text-primary that all eight slots read as the same near-black —
    // which would satisfy AA and destroy the one thing the palette is for.
    // The label has to still be *this* directory's hue, in both themes.
    for (const theme of [{ label: 'light', tokens: light }, { label: 'dark', tokens: dark }]) {
      for (const slot of SLOTS) {
        const accentHue = hueOf(resolveTokenColor(`--kv2-dir-${slot}`, theme.tokens));
        const textHue = hueOf(resolveTokenColor(`--kv2-dir-${slot}-text`, theme.tokens));
        expect(
          hueDistance(accentHue, textHue),
          `--kv2-dir-${slot}-text drifted off slot ${slot}'s hue in ${theme.label} `
            + `(${accentHue.toFixed(0)}° → ${textHue.toFixed(0)}°)`,
        ).toBeLessThan(30);
      }
    }
  });
});

describe('Works affinity palette luminance axis', () => {
  test('hue-adjacent slots differ in luminance, so the ring survives greyscale', () => {
    // Hue alone cannot separate eight slots for a red-green-deficient eye, and
    // a 45° step is small. Neighbours on the ring therefore alternate light and
    // dark; this asserts the alternation actually holds.
    const ring = SLOTS
      .map((slot) => ({ slot, rgb: resolveTokenColor(`--kv2-dir-${slot}`, light) }))
      .map((entry) => ({ ...entry, luminance: relativeLuminance(entry.rgb) }));
    // Ring order is hue order, which `worksAffinity.test.ts` establishes.
    const byHue = [...ring].sort((a, b) => hueOf(a.rgb) - hueOf(b.rgb));
    for (let i = 0; i < byHue.length; i += 1) {
      const a = byHue[i];
      const b = byHue[(i + 1) % byHue.length];
      const ratio = (Math.max(a.luminance, b.luminance) + 0.05)
        / (Math.min(a.luminance, b.luminance) + 0.05);
      expect(ratio, `slots ${a.slot} and ${b.slot} are hue-adjacent and equally bright`)
        .toBeGreaterThan(1.3);
    }
  });
});
