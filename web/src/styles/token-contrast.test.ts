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
 * match the `color-mix` percentage in `kv2/project-color.css`.
 */
const CHIP_TINT_PERCENT = 0.14;

/**
 * `.kv2-ref-chip` (`kv2/mention.css`) tints its own background from the kind
 * accent the same way, at its own percentage. Must match that rule.
 */
const REF_CHIP_TINT_PERCENT = 0.11;

const SLOTS = [1, 2, 3, 4, 5, 6, 7, 8] as const;

/** Every background a directory/lineage label can land on, for one theme. */
function backgrounds(tokens: TokenMap, accent: Rgb, tintPercent: number): { name: string; rgb: Rgb }[] {
  const surfaces = SURFACE_TOKENS.map((name) => ({ name, rgb: resolveTokenColor(name, tokens) }));
  return [
    ...surfaces,
    ...surfaces.map(({ name, rgb }) => ({
      name: `${name} + ${tintPercent * 100}% tint`,
      rgb: mixSrgb(accent, tintPercent, rgb),
    })),
  ];
}

function worstContrast(
  textToken: string,
  accentToken: string,
  tokens: TokenMap,
  tintPercent: number = CHIP_TINT_PERCENT,
): { ratio: number; against: string } {
  const text = resolveTokenColor(textToken, tokens);
  const accent = resolveTokenColor(accentToken, tokens);
  let worst = { ratio: Infinity, against: '' };
  for (const bg of backgrounds(tokens, accent, tintPercent)) {
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

/**
 * The same guard for the `@` mention reference kinds. They are a second
 * categorical layer ① series (`--kv2-ref-session|work|doc`), and the popover
 * row's kind glyph plus the chip's token span are painted in the `-text` twin
 * — so the twin, not the swatch, is what has to clear AA. The mix percentages
 * differ per kind for the same reason the directory slots' do: how far a hue
 * has to travel toward the ink to land on 4.5:1 depends on the hue.
 */
const REF_KINDS = ['session', 'work', 'doc'] as const;

describe('mention reference kind text tokens meet WCAG AA', () => {
  for (const theme of [{ label: 'light', tokens: light }, { label: 'dark', tokens: dark }]) {
    for (const kind of REF_KINDS) {
      test(`--kv2-ref-${kind}-text clears 4.5:1 in ${theme.label}`, () => {
        const worst = worstContrast(
          `--kv2-ref-${kind}-text`,
          `--kv2-ref-${kind}`,
          theme.tokens,
          REF_CHIP_TINT_PERCENT,
        );
        expect(
          worst.ratio,
          `--kv2-ref-${kind}-text is ${worst.ratio.toFixed(2)}:1 on ${worst.against}`,
        ).toBeGreaterThanOrEqual(AA);
      });
    }
  }

  test('the reference accents are declared once — layer ① is not re-stated in dark', () => {
    const { dark: overlaid } = parseThemeTokens(CSS);
    for (const kind of REF_KINDS) {
      expect(resolveTokenColor(`--kv2-ref-${kind}`, overlaid))
        .toEqual(resolveTokenColor(`--kv2-ref-${kind}`, light));
    }
  });

  test('each -text token keeps its kind hue instead of collapsing to ink', () => {
    // Mixing all the way to --kv2-text-primary would satisfy AA and make all
    // three kinds the same near-black, which is the one thing the series is for.
    for (const theme of [{ label: 'light', tokens: light }, { label: 'dark', tokens: dark }]) {
      for (const kind of REF_KINDS) {
        const accentHue = hueOf(resolveTokenColor(`--kv2-ref-${kind}`, theme.tokens));
        const textHue = hueOf(resolveTokenColor(`--kv2-ref-${kind}-text`, theme.tokens));
        expect(
          hueDistance(accentHue, textHue),
          `--kv2-ref-${kind}-text drifted off its hue in ${theme.label} `
            + `(${accentHue.toFixed(0)}° → ${textHue.toFixed(0)}°)`,
        ).toBeLessThan(30);
      }
    }
  });

  test('the three kinds stay apart in hue, so a chip is identifiable by colour', () => {
    // 'work' shares the lineage violet with --kv2-affinity-chain by design; the
    // three *kinds* still have to be mutually distinguishable.
    const hues = REF_KINDS.map((kind) => ({
      kind,
      hue: hueOf(resolveTokenColor(`--kv2-ref-${kind}`, light)),
    }));
    for (let i = 0; i < hues.length; i += 1) {
      for (let j = i + 1; j < hues.length; j += 1) {
        expect(
          hueDistance(hues[i].hue, hues[j].hue),
          `--kv2-ref-${hues[i].kind} and --kv2-ref-${hues[j].kind} are the same hue`,
        ).toBeGreaterThan(30);
      }
    }
  });
});

/**
 * Unread completion tokens. The dark indicator used to be #a66b7b — 3.4:1 on
 * the surface, which is why unread read as "dimmer" than the red latest-turn
 * border it was being confused with. The indicator now doubles as text
 * (`Show N more · k unread`), and the filled pill / NEW tag print on it.
 */
const UNREAD_SURFACES = ['--kv2-surface', '--kv2-surface-tint-cool', '--kv2-unread-surface'];

describe('unread completion tokens', () => {
  for (const theme of [{ label: 'light', tokens: light }, { label: 'dark', tokens: dark }]) {
    test(`--kv2-unread-fill-fg clears 4.5:1 on the indicator in ${theme.label}`, () => {
      const ratio = contrastRatio(
        resolveTokenColor('--kv2-unread-fill-fg', theme.tokens),
        resolveTokenColor('--kv2-unread-indicator', theme.tokens),
      );
      expect(ratio, `filled unread pill is ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(AA);
    });

    test(`--kv2-unread-indicator stands out from every surface in ${theme.label}`, () => {
      const indicator = resolveTokenColor('--kv2-unread-indicator', theme.tokens);
      for (const surface of UNREAD_SURFACES) {
        const ratio = contrastRatio(indicator, resolveTokenColor(surface, theme.tokens));
        // 3:1 is the WCAG non-text bar; the node, strip and border sit on these.
        expect(ratio, `indicator is ${ratio.toFixed(2)}:1 on ${surface}`).toBeGreaterThanOrEqual(3);
      }
    });

    test(`--kv2-unread-text clears 4.5:1 on the surface in ${theme.label}`, () => {
      for (const surface of ['--kv2-surface', '--kv2-surface-tint-cool']) {
        const ratio = contrastRatio(
          resolveTokenColor('--kv2-unread-text', theme.tokens),
          resolveTokenColor(surface, theme.tokens),
        );
        expect(ratio, `unread text is ${ratio.toFixed(2)}:1 on ${surface}`).toBeGreaterThanOrEqual(AA);
      }
    });

    test(`body text stays readable on --kv2-unread-surface in ${theme.label}`, () => {
      for (const text of ['--kv2-text-primary', '--kv2-text-secondary']) {
        const ratio = contrastRatio(
          resolveTokenColor(text, theme.tokens),
          resolveTokenColor('--kv2-unread-surface', theme.tokens),
        );
        expect(ratio, `${text} is ${ratio.toFixed(2)}:1 on the unread turn`).toBeGreaterThanOrEqual(AA);
      }
    });
  }
});

/**
 * `--kv2-text-muted` prints captions, timestamps and placeholders on ~80
 * selectors. It used to be #8190a8 (light) / #737a82 (dark) — about 3.1:1 on
 * the app frame and under 2.9:1 on a hovered row, i.e. below AA everywhere it
 * landed. It has to clear 4.5:1 on every panel surface and the app frame, and
 * it still has to be the *quieter* step under `--kv2-text-secondary`, or the
 * three-level ink hierarchy collapses to two.
 */
describe('--kv2-text-muted meets WCAG AA', () => {
  for (const theme of [{ label: 'light', tokens: light }, { label: 'dark', tokens: dark }]) {
    const muted = resolveTokenColor('--kv2-text-muted', theme.tokens);

    for (const surface of SURFACE_TOKENS) {
      test(`--kv2-text-muted clears 4.5:1 on ${surface} in ${theme.label}`, () => {
        const ratio = contrastRatio(muted, resolveTokenColor(surface, theme.tokens));
        expect(ratio, `muted text is ${ratio.toFixed(2)}:1 on ${surface}`).toBeGreaterThanOrEqual(AA);
      });
    }

    test(`--kv2-text-muted stays quieter than --kv2-text-secondary in ${theme.label}`, () => {
      const surface = resolveTokenColor('--kv2-surface', theme.tokens);
      const mutedRatio = contrastRatio(muted, surface);
      const secondaryRatio = contrastRatio(
        resolveTokenColor('--kv2-text-secondary', theme.tokens),
        surface,
      );
      expect(mutedRatio, 'muted reads as loud as secondary').toBeLessThan(secondaryRatio);
    });
  }
});

/**
 * Works on the board (GROUP: WORKS) and the unified board toolbar. Each pair is
 * a label and the face it prints on. `--kv2-work-tint-2` is a hover face for
 * ink, not for `--kv2-work-text`, so it is only checked against the ink steps.
 * The raw `--kv2-work-border` swatch is never a text face in dark (white on
 * #3d7fd0 is 3.8:1) — filled Work labels sit on `--kv2-work-tab-bg`.
 */
const WORK_AND_TOOLBAR_PAIRS: [text: string, face: string][] = [
  ['--kv2-work-text', '--kv2-surface'],
  ['--kv2-work-text', '--kv2-work-tint'],
  ['--kv2-text-primary', '--kv2-work-tint'],
  ['--kv2-text-primary', '--kv2-work-tint-2'],
  ['--kv2-text-secondary', '--kv2-work-tint'],
  ['--kv2-text-secondary', '--kv2-work-tint-2'],
  ['--kv2-work-tab-fg', '--kv2-work-tab-bg'],
  ['--kv2-session-tab-fg', '--kv2-session-tab-bg'],
  ['--kv2-favorite-pill-fg', '--kv2-favorite-pill-bg'],
  ['--kv2-toolbar-fg', '--kv2-toolbar-bg'],
  ['--kv2-toolbar-label-fg', '--kv2-toolbar-label-bg'],
  ['--kv2-toolbar-unread-fg', '--kv2-toolbar-bg'],
  ['--kv2-unread-fill-fg', '--kv2-unread-indicator'],
  ['--kv2-toolbar-view-active-fg', '--kv2-toolbar-view-active-bg'],
  ['--kv2-toolbar-filter-active-fg', '--kv2-toolbar-filter-active-bg'],
  ['--kv2-toolbar-works-active-fg', '--kv2-toolbar-works-active-bg'],
];

describe('Works-on-board and toolbar tokens meet WCAG AA', () => {
  for (const theme of [{ label: 'light', tokens: light }, { label: 'dark', tokens: dark }]) {
    for (const [text, face] of WORK_AND_TOOLBAR_PAIRS) {
      test(`${text} clears 4.5:1 on ${face} in ${theme.label}`, () => {
        const ratio = contrastRatio(
          resolveTokenColor(text, theme.tokens),
          resolveTokenColor(face, theme.tokens),
        );
        expect(ratio, `${text} is ${ratio.toFixed(2)}:1 on ${face}`).toBeGreaterThanOrEqual(AA);
      });
    }

    test(`the Work border stands out from the app frame and surface in ${theme.label}`, () => {
      const border = resolveTokenColor('--kv2-work-border', theme.tokens);
      for (const surface of ['--kv2-app-bg', '--kv2-surface']) {
        const ratio = contrastRatio(border, resolveTokenColor(surface, theme.tokens));
        // 3:1 is the WCAG non-text bar for the container outline.
        expect(ratio, `Work border is ${ratio.toFixed(2)}:1 on ${surface}`).toBeGreaterThanOrEqual(3);
      }
    });
  }
});
