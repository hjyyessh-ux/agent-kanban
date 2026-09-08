/**
 * Colour maths + a tiny reader for `kanban-v2.tokens.css`.
 *
 * Test-only support code (imported by `token-contrast.test.ts` and
 * `components/Works/worksAffinity.test.ts`), which is why it lives beside the
 * stylesheet it reads rather than in a component: the assertions it enables are
 * about the *tokens*, not about any screen.
 *
 * The tokens stay the single source of truth. Nothing here restates a palette
 * value — the parser reads the declarations out of the CSS and evaluates them,
 * so a token edited in the stylesheet cannot drift away from the guard.
 */

export type Rgb = readonly [number, number, number];

/** `#rgb` / `#rrggbb` → sRGB channel triple. Throws on anything else. */
export function hexToRgb(hex: string): Rgb {
  const body = hex.trim().replace(/^#/, '');
  const full = body.length === 3
    ? body.split('').map((c) => c + c).join('')
    : body;
  if (!/^[0-9a-fA-F]{6}$/.test(full)) throw new Error(`Not a hex colour: ${hex}`);
  return [
    parseInt(full.slice(0, 2), 16),
    parseInt(full.slice(2, 4), 16),
    parseInt(full.slice(4, 6), 16),
  ];
}

/** WCAG 2.1 relative luminance (0 = black, 1 = white). */
export function relativeLuminance(rgb: Rgb): number {
  const linear = rgb.map((channel) => {
    const v = channel / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
}

/** WCAG 2.1 contrast ratio, always >= 1. */
export function contrastRatio(a: Rgb, b: Rgb): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/**
 * `color-mix(in srgb, a P%, b)` — a plain per-channel sRGB lerp, which is what
 * the `in srgb` colour space means. `weight` is `a`'s share, 0…1.
 */
export function mixSrgb(a: Rgb, weight: number, b: Rgb): Rgb {
  return [0, 1, 2].map((i) => Math.round(a[i] * weight + b[i] * (1 - weight))) as unknown as Rgb;
}

/** HSL hue in degrees (0…360); 0 for a fully desaturated colour. */
export function hueOf(rgb: Rgb): number {
  const [r, g, b] = rgb.map((c) => c / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  if (delta === 0) return 0;
  let hue: number;
  if (max === r) hue = ((g - b) / delta) % 6;
  else if (max === g) hue = (b - r) / delta + 2;
  else hue = (r - g) / delta + 4;
  hue *= 60;
  return hue < 0 ? hue + 360 : hue;
}

/** Shortest distance between two hues on the 360° ring (0…180). */
export function hueDistance(a: number, b: number): number {
  const raw = Math.abs(a - b) % 360;
  return raw > 180 ? 360 - raw : raw;
}

// ─── kanban-v2.tokens.css reader ─────────────────────────────────────

/** One theme's custom-property declarations, token name → raw value. */
export type TokenMap = Map<string, string>;

/**
 * Splits `kanban-v2.tokens.css` into the light and dark token maps.
 *
 * Light = every `:root { … }` block (the file uses several, one per layer);
 * dark = light overlaid with `:root[data-theme="dark"] { … }`, which is how the
 * cascade resolves it — both selectors match the same element, so dark inherits
 * every token it does not restate.
 */
export function parseThemeTokens(css: string): { light: TokenMap; dark: TokenMap } {
  const light: TokenMap = new Map();
  const dark: TokenMap = new Map();
  // The file has no nested braces inside :root blocks, so a non-greedy body
  // match is unambiguous.
  const blocks = css.matchAll(/(:root(?:\[data-theme="dark"\])?)\s*\{([^}]*)\}/g);
  for (const [, selector, body] of blocks) {
    const target = selector.includes('dark') ? dark : light;
    for (const [, name, value] of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
      target.set(name, value.trim());
    }
  }
  return { light, dark: new Map([...light, ...dark]) };
}

/**
 * Resolves a token to an sRGB colour, following `var()` chains and evaluating
 * `color-mix(in srgb, <a> P%, <b>)`. Only the subset of CSS colour syntax the
 * kv2 tokens actually use is supported; anything else throws, so an
 * unevaluatable token fails the guard loudly instead of being skipped.
 */
export function resolveTokenColor(name: string, tokens: TokenMap): Rgb {
  return evaluate(expect(tokens.get(name), `token ${name} is not declared`), tokens, 0);
}

/** True when a token is declared at all — used to assert a token exists. */
export function hasToken(name: string, tokens: TokenMap): boolean {
  return tokens.has(name);
}

function expect<T>(value: T | undefined, message: string): T {
  if (value === undefined) throw new Error(message);
  return value;
}

function evaluate(value: string, tokens: TokenMap, depth: number): Rgb {
  if (depth > 16) throw new Error(`var() chain too deep at: ${value}`);
  const expr = value.trim();

  if (expr.startsWith('#')) return hexToRgb(expr);

  const varOnly = expr.match(/^var\(\s*(--[\w-]+)\s*\)$/);
  if (varOnly) {
    return evaluate(
      expect(tokens.get(varOnly[1]), `token ${varOnly[1]} is not declared`),
      tokens,
      depth + 1,
    );
  }

  const mix = expr.match(/^color-mix\(\s*in\s+srgb\s*,\s*(.+?)\s+([\d.]+)%\s*,\s*(.+?)\s*\)$/);
  if (mix) {
    const [, first, percent, second] = mix;
    return mixSrgb(
      evaluate(first, tokens, depth + 1),
      Number(percent) / 100,
      evaluate(second, tokens, depth + 1),
    );
  }

  throw new Error(`Unsupported colour expression: ${expr}`);
}
