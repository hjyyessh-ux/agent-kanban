import { describe, expect, test } from 'bun:test';
import type { MentionCandidate, MentionSearchResponse } from '../../../../src/core/mention-search';
import { buildMentionRows } from './MentionPopover';

const candidate = (kind: MentionCandidate['kind'], id: string): MentionCandidate => ({
  kind,
  id,
  label: id,
  updatedAt: '2026-11-16T00:00:00.000Z',
});

const response: MentionSearchResponse = {
  q: '',
  groups: {
    sessions: [candidate('session', 'aaaa1111')],
    works: [],
    docs: [candidate('doc', 'a.md')],
    skills: [candidate('skill', 'consensus'), candidate('skill', 'egm:egm-review')],
  },
  totals: { sessions: 1, works: 0, docs: 1, skills: 2 },
};

describe('buildMentionRows — skills', () => {
  test('the All tab mixes only things to read; skills stay in their own tab', () => {
    const all = buildMentionRows(response, 'all');
    expect(all.candidates.map((row) => row.kind)).toEqual(['session', 'doc']);
  });

  test('the Skills tab lists every skill without a group heading', () => {
    const skills = buildMentionRows(response, 'skill');
    expect(skills.candidates.map((row) => row.id)).toEqual(['consensus', 'egm:egm-review']);
    expect(skills.items.every((item) => item.type === 'row')).toBe(true);
  });
});
