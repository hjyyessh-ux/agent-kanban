import { describe, expect, mock, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { KanbanCard, Work } from '../../../../src/core/types';
import { BoardWorkContainer, workFragmentSelector } from './BoardWorkContainer';
import { selectWorkFragments } from './board-works';
import { BOARD_GROUP_COPY, BOARD_WORKS_COPY } from '../../constants/copy';

let seq = 0;
/** A read complete turn answered at `hour` (UTC) on 10-20 — larger hour = newer. */
function turn(sessionId: string, hour: number, overrides: Partial<KanbanCard> = {}): KanbanCard {
  seq += 1;
  const at = `2026-10-20T${String(hour).padStart(2, '0')}:00:00.000Z`;
  return {
    id: `t${seq}`,
    title: `Turn of ${sessionId} @${hour}`,
    description: '',
    status: 'complete',
    sessionId,
    createdAt: at,
    updatedAt: at,
    completedAt: at,
    completedSeenAt: at,
    ...overrides,
  };
}

function work(id: string, sessionIds: string[], overrides: Partial<Work> = {}): Work {
  return {
    id,
    title: `Work ${id}`,
    status: 'active',
    sessionLinks: sessionIds.map((sessionId) => ({ sessionId, linkedAt: '2026-10-19T00:00:00.000Z' })),
    projectDir: '/Users/user/workspace/agent-kanban',
    startedAt: '2026-10-19T00:00:00.000Z',
    createdAt: '2026-10-19T00:00:00.000Z',
    updatedAt: '2026-10-19T00:00:00.000Z',
    ...overrides,
  };
}

const unread = { completedSeenAt: undefined };

function render(cards: KanbanCard[], works: Work[], props: Partial<React.ComponentProps<typeof BoardWorkContainer>> = {}) {
  const model = selectWorkFragments({ cards, works });
  const [fragment] = model.complete.fragments;
  return renderToStaticMarkup(
    <BoardWorkContainer
      fragment={fragment}
      status="complete"
      onCardClick={mock(() => undefined)}
      onWorkOpen={mock(() => undefined)}
      {...props}
    />,
  );
}

describe('BoardWorkContainer', () => {
  const cards = [
    turn('s1', 1),
    turn('s2', 3, unread),
    turn('s3', 5),
    turn('s3', 6, { favorite: true }),
    turn('s4', 7, { status: 'in_progress' }),
  ];
  const works = [work('W1', ['s1', 's2', 's3', 's4'])];

  test('wears the WORK tab and marks itself for peer highlight and jumps', () => {
    const html = render(cards, works);
    expect(html).toContain(`<span class="kv2-work-tab" aria-hidden="true">${BOARD_GROUP_COPY.workTab}</span>`);
    expect(html).toContain('data-work-id="W1"');
    expect(html).toContain('data-work-status="complete"');
    expect(html).toContain('aria-label="Work Work W1"');
  });

  test('header: title button · ⋯ menu (no chevron) — unread and the Work id live on the meta line', () => {
    const html = render(cards, works);
    expect(html).not.toContain('kv2-work-chevron');
    expect(html).toMatch(/<button type="button" class="kv2-work-title"[^>]*>Work W1<\/button>/);
    expect(html).toContain(`aria-label="${BOARD_WORKS_COPY.menuLabel('Work W1')}"`);
    const head = html.slice(html.indexOf('<header class="kv2-work-head"'), html.indexOf('</header>'));
    expect(head).not.toContain('kv2-work-unread');
    expect(head).not.toContain('kv2-id-chip');
    const meta = html.slice(html.indexOf('<div class="kv2-work-meta"'));
    const end = meta.slice(meta.indexOf('<span class="kv2-work-meta-end"'));
    expect(end).toMatch(/^<span class="kv2-work-meta-end"><span class="kv2-work-unread" title="1 unread" aria-label="1 unread">● 1<\/span>/);
    expect(end).toContain('kv2-id-chip');
  });

  test('⋯ menu carries only the Work dialog flows — folding is the footer toggle', () => {
    const html = render(cards, works);
    expect(html).toContain(`title="${[
      BOARD_WORKS_COPY.menuOpen,
      BOARD_WORKS_COPY.menuRename,
      BOARD_WORKS_COPY.menuMerge,
      BOARD_WORKS_COPY.menuComplete,
    ].join(' · ')}"`);
  });

  test('without onWorkOpen the title is inert and there is no ⋯ menu', () => {
    const html = render(cards, works, { onWorkOpen: undefined });
    expect(html).toMatch(/class="kv2-work-title"[^>]*disabled=""/);
    expect(html).not.toContain(BOARD_WORKS_COPY.menuLabel('Work W1'));
    expect(html).toContain('kv2-work-toggle');
  });

  test('open: footer hide toggle styled like a session group toggle, no hidden note', () => {
    const html = render(cards, works);
    expect(html).toMatch(new RegExp(`class="kv2-complete-session-toggle kv2-work-toggle" aria-expanded="true" aria-label="${BOARD_WORKS_COPY.collapse}">${BOARD_WORKS_COPY.toggleHide}</button>`));
    expect(html).not.toContain('kv2-work-foot-note');
  });

  test('meta line: project chip · x / y sessions · ★ N · other-column chips', () => {
    const html = render(cards, works);
    expect(html).toContain('works-dir-chip kv2-project-chip kv2-work-project');
    expect(html).toContain('>agent-kanban</span>');
    // 3 sessions here, 4 across the board (s4 is in progress).
    expect(html).toContain(BOARD_WORKS_COPY.sessionCount(3, 4));
    expect(html).toContain('3 / 4 sessions');
    expect(html).toContain('class="kv2-favorite-pill"');
    expect(html).toContain('★ 1');
    expect(html).toContain('class="kv2-work-elsewhere"');
    expect(html).toContain('진행중 1 ↗');
  });

  test('body: the newest two sessions as regular session groups, header-only, then Show N more', () => {
    const html = render(cards, works);
    const groups = html.match(/class="kv2-complete-session-group /g) ?? [];
    expect(groups).toHaveLength(2);
    expect(html.match(/class="kv2-session-tab"/g)).toHaveLength(2);
    expect(html).toContain('data-session-group-key="session:s3"');
    expect(html).toContain('data-session-group-key="session:s2"');
    expect(html).not.toContain('data-session-group-key="session:s1"');
    // Header-only: the turn timeline stays closed until the group is opened.
    expect(html).not.toContain('kv2-complete-session-timeline');
    expect(html).toContain(BOARD_WORKS_COPY.showMore(1));
  });

  test('Show N more names the unread folded behind it', () => {
    const html = render([turn('s1', 1, unread), turn('s2', 3), turn('s3', 5)], [work('W1', ['s1', 's2', 's3'])]);
    expect(html).toContain('<span class="kv2-work-more-unread">● 1 unread</span>');
  });

  test('no Show more button when every session is visible', () => {
    const html = render([turn('s1', 1), turn('s2', 3)], [work('W1', ['s1', 's2'])]);
    expect(html).not.toContain('kv2-work-more');
    expect(html).toContain(BOARD_WORKS_COPY.sessionCount(2, 2));
  });

  test('collapsed: header and meta line only — no session groups, no Show more', () => {
    const html = render(cards, works, { defaultCollapsed: true });
    expect(html).toContain('kv2-work kv2-work--collapsed');
    expect(html).toContain(`aria-expanded="false" aria-label="${BOARD_WORKS_COPY.expand}">${BOARD_WORKS_COPY.toggleShow(3)}</button>`);
    expect(html).toContain('show 3');
    expect(html).toContain(`<span class="kv2-work-foot-note">${BOARD_WORKS_COPY.hiddenNote(3, 1)}</span>`);
    expect(html).toContain('숨긴 세션 3 · unread 1');
    expect(html).toContain('class="kv2-work-meta"');
    expect(html).toContain('3 / 4 sessions');
    expect(html).toContain('● 1');
    expect(html).not.toContain('kv2-complete-session-group');
    expect(html).not.toContain('kv2-work-more');
    expect(html).not.toContain('kv2-work-mini');
  });


  test('session header carries ★ N for its starred turns', () => {
    const html = render(cards, works);
    expect(html).toContain(`title="${BOARD_WORKS_COPY.sessionFavoriteHint(1)}"`);
  });

  test('workFragmentSelector targets one column or every fragment', () => {
    expect(workFragmentSelector('W1', 'in_progress')).toBe('[data-work-id="W1"][data-work-status="in_progress"]');
    expect(workFragmentSelector('W1')).toBe('[data-work-id="W1"]');
  });
});
