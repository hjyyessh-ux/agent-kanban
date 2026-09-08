import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Work, WorkSessionLink } from '../../../../src/core/types';
import {
  hasToken,
  hueDistance,
  hueOf,
  parseThemeTokens,
  resolveTokenColor,
} from '../../styles/tokenColor';
import {
  DIR_COLOR_SLOTS,
  chainedWorkIds,
  dirAccentClass,
  projectDirColorSlot,
} from './worksAffinity';

function work(id: string, sessionIds: string[]): Work {
  const sessionLinks: WorkSessionLink[] = sessionIds.map((sessionId) => ({
    sessionId,
    linkedAt: '2026-09-01T00:00:00.000Z',
  }));
  return {
    id,
    title: id,
    status: 'active',
    sessionLinks,
    startedAt: '2026-09-01T00:00:00.000Z',
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
  };
}

describe('projectDirColorSlot', () => {
  test('is stable and inside the palette for any path', () => {
    const dirs = [
      '/Users/me/workspace/agent-kanban',
      '/Users/me/workspace/mcp-server',
      '/srv/zdd-zetta2',
      '/a',
    ];
    for (const dir of dirs) {
      const slot = projectDirColorSlot(dir);
      expect(slot).toBe(projectDirColorSlot(dir));
      expect(slot).toBeGreaterThanOrEqual(1);
      expect(slot).toBeLessThanOrEqual(DIR_COLOR_SLOTS);
    }
  });

  test('ignores a trailing slash so one directory never gets two colours', () => {
    expect(projectDirColorSlot('/w/agent-kanban/')).toBe(projectDirColorSlot('/w/agent-kanban'));
  });

  test('hashes the whole path, not the last segment', () => {
    // Two checkouts that both end in `web` must not claim the same colour.
    expect(projectDirColorSlot('/w/one/web')).not.toBe(projectDirColorSlot('/w/two/web'));
  });

  test('has no colour for a session or Work without a directory', () => {
    expect(projectDirColorSlot(undefined)).toBeNull();
    expect(projectDirColorSlot('/')).toBeNull();
    expect(dirAccentClass(undefined)).toBe('');
    expect(dirAccentClass('/w/agent-kanban')).toMatch(/^works-dir-c[1-8]$/);
  });
});

describe('chainedWorkIds', () => {
  const works = [work('w-lineage', ['ses-parent']), work('w-other', ['ses-unrelated'])];

  test('matches Works holding a session this one continues', () => {
    const matched = chainedWorkIds({ relatedSessionIds: ['ses-parent'] }, works);
    expect([...matched]).toEqual(['w-lineage']);
  });

  test('is empty when the session has no lineage at all', () => {
    // Absent `relatedSessionIds` means "no lineage found" (the server always
    // computes it), never "not loaded" — so this must not guess.
    expect(chainedWorkIds({}, works).size).toBe(0);
    expect(chainedWorkIds({ relatedSessionIds: [] }, works).size).toBe(0);
  });

  test('is empty when the lineage belongs to no Work yet', () => {
    expect(chainedWorkIds({ relatedSessionIds: ['ses-nowhere'] }, works).size).toBe(0);
  });
});

/**
 * The palette itself, read out of `kanban-v2.tokens.css`.
 *
 * `projectDirColorSlot` hands out slots uniformly, so the palette is only as
 * good as its worst pair — and the pair that mattered was blue: the first
 * version put `--kv2-dir-1` (#2f6fed), `-5` (#2f9bd0) and `-8` (#4b5bd6) inside
 * 34° of each other, which on a machine with four checkouts produced four blue
 * chips and no information. Hence a hard floor on hue spacing, checked against
 * the stylesheet rather than a copy of the values.
 */
describe('directory palette (--kv2-dir-1..8)', () => {
  const css = readFileSync(
    join(import.meta.dir, '../../styles/kanban-v2.tokens.css'),
    'utf-8',
  );
  const { light } = parseThemeTokens(css);
  const slots = Array.from({ length: DIR_COLOR_SLOTS }, (_, i) => i + 1);

  test('declares one token per slot the hash can return', () => {
    for (const slot of slots) {
      expect(hasToken(`--kv2-dir-${slot}`, light), `--kv2-dir-${slot} is missing`).toBe(true);
    }
    // A ninth token without bumping DIR_COLOR_SLOTS is a colour the hash can
    // never reach; the pair has to move together.
    expect(hasToken(`--kv2-dir-${DIR_COLOR_SLOTS + 1}`, light)).toBe(false);
  });

  test('declares an AA-safe text twin per slot, plus one for lineage', () => {
    // Components print directory names in these, never in the raw accent.
    // `styles/token-contrast.test.ts` checks the ratios; this only checks that
    // a new slot cannot be added without its text colour.
    for (const slot of slots) {
      expect(hasToken(`--kv2-dir-${slot}-text`, light), `--kv2-dir-${slot}-text is missing`)
        .toBe(true);
    }
    expect(hasToken('--kv2-affinity-chain-text', light)).toBe(true);
  });

  test('spreads the slots evenly round the hue ring', () => {
    const hues = slots
      .map((slot) => hueOf(resolveTokenColor(`--kv2-dir-${slot}`, light)))
      .sort((a, b) => a - b);
    // Eight slots on a 360° ring average 45° apart; allow drift but never let a
    // neighbouring pair close to within half a step, which is what made the old
    // blues indistinguishable at 10px.
    const MIN_GAP = 30;
    for (let i = 0; i < hues.length; i += 1) {
      const next = hues[(i + 1) % hues.length];
      const gap = hueDistance(hues[i], next);
      expect(gap, `hues ${hues[i].toFixed(0)}° and ${next.toFixed(0)}° are too close`)
        .toBeGreaterThanOrEqual(MIN_GAP);
    }
  });

  test('keeps the lineage hue out of every directory slot', () => {
    // "Same colour = same directory" only holds while 🔗 이어진 세션 — a
    // different signal entirely — cannot be mistaken for a directory swatch.
    const chain = hueOf(resolveTokenColor('--kv2-affinity-chain', light));
    for (const slot of slots) {
      const hue = hueOf(resolveTokenColor(`--kv2-dir-${slot}`, light));
      expect(hueDistance(chain, hue), `--kv2-dir-${slot} sits on the lineage hue`)
        .toBeGreaterThanOrEqual(20);
    }
  });
});
