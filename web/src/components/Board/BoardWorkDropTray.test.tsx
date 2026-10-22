import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Work } from '../../../../src/core/types';
import { BoardWorkDropTray, describeDropHover } from './BoardWorkDropTray';
import { BoardWorkDnDContext, clearDropHover, getDropHover, setDropHover, type BoardWorkDnD } from './board-work-dnd';
import type { WorkDragSource } from './board-works';
import { BOARD_WORKS_COPY } from '../../constants/copy';

function work(id: string, title: string): Work {
  return {
    id,
    title,
    status: 'active',
    sessionLinks: [],
    startedAt: '2026-10-20T00:00:00.000Z',
    createdAt: '2026-10-20T00:00:00.000Z',
    updatedAt: '2026-10-20T00:00:00.000Z',
  };
}

const works = [work('W1', 'Alpha'), work('W2', 'Beta')];

function dnd(drag: WorkDragSource | null): BoardWorkDnD {
  return {
    drag,
    works,
    workForSession: () => undefined,
    startDrag: () => {},
    endDrag: () => {},
    run: () => {},
  };
}

function withDnD(value: BoardWorkDnD | null, node: React.ReactNode): string {
  return renderToStaticMarkup(<BoardWorkDnDContext.Provider value={value}>{node}</BoardWorkDnDContext.Provider>);
}

const inBeta: WorkDragSource = { cardId: 'c1', sessionId: 's1', workId: 'W2', status: 'complete', title: 'Session one' };

describe('BoardWorkDropTray', () => {
  test('renders nothing when no drag is live (or outside works mode)', () => {
    expect(withDnD(dnd(null), <BoardWorkDropTray />)).toBe('');
    expect(withDnD(null, <BoardWorkDropTray />)).toBe('');
  });

  test('lists every active Work (current dimmed), ＋ 새 Work and ⊘ Work에서 빼기', () => {
    const html = withDnD(dnd(inBeta), <BoardWorkDropTray />);
    expect(html).toContain(`aria-label="${BOARD_WORKS_COPY.trayAria}"`);
    expect(html).toContain('data-tray-work-id="W1"');
    expect(html).toContain('class="kv2-work-tray-drop is-current" data-tray-work-id="W2"');
    expect(html).toContain(BOARD_WORKS_COPY.trayCurrent);
    expect(html).toContain(BOARD_WORKS_COPY.trayNew);
    expect(html).toContain(BOARD_WORKS_COPY.trayOut);
  });

  test('an unassigned session has no ⊘ target', () => {
    const html = withDnD(dnd({ ...inBeta, workId: undefined }), <BoardWorkDropTray />);
    expect(html).not.toContain(BOARD_WORKS_COPY.trayOut);
    expect(html).not.toContain('is-current');
  });

  test('a source without a session gets the note instead of targets', () => {
    const html = withDnD(dnd({ ...inBeta, sessionId: undefined }), <BoardWorkDropTray />);
    expect(html).toContain(BOARD_WORKS_COPY.trayNoSession);
    expect(html).not.toContain('data-tray-work-id');
  });
});

describe('tray hover label', () => {
  const loose: WorkDragSource = { cardId: 'c2', sessionId: 's2', status: 'complete', title: 'Loose' };

  test('describeDropHover names the action and the target Work', () => {
    expect(describeDropHover(loose, { kind: 'work', workId: 'W1', status: 'complete' }, works))
      .toBe(BOARD_WORKS_COPY.trayHoverLink('Alpha'));
    expect(describeDropHover(inBeta, { kind: 'work', workId: 'W1' }, works))
      .toBe(BOARD_WORKS_COPY.trayHoverMove('Alpha'));
    expect(describeDropHover(inBeta, { kind: 'unassigned', status: 'complete' }, works))
      .toBe(BOARD_WORKS_COPY.trayHoverUnlink);
    expect(describeDropHover(loose, { kind: 'new' }, works)).toBe(BOARD_WORKS_COPY.trayHoverNew);
  });

  test('no label without a target, or for a drop that does nothing', () => {
    expect(describeDropHover(loose, null, works)).toBeNull();
    expect(describeDropHover(inBeta, { kind: 'work', workId: 'W2' }, works)).toBeNull();
  });

  test('the tray swaps its label for the hovered target and back', () => {
    setDropHover({ kind: 'work', workId: 'W1' });
    const hovered = withDnD(dnd(loose), <BoardWorkDropTray />);
    expect(hovered).toContain(BOARD_WORKS_COPY.trayHoverPrefix);
    expect(hovered).toContain(BOARD_WORKS_COPY.trayHoverLink('Alpha'));
    setDropHover(null);
    const idle = withDnD(dnd(loose), <BoardWorkDropTray />);
    expect(idle).toContain(BOARD_WORKS_COPY.trayLabel);
  });

  test('a late leave from the previous target does not clear the new one', () => {
    setDropHover({ kind: 'work', workId: 'W1' });
    setDropHover({ kind: 'work', workId: 'W2' });
    clearDropHover({ kind: 'work', workId: 'W1' });
    expect(getDropHover()).toEqual({ kind: 'work', workId: 'W2' });
    clearDropHover({ kind: 'work', workId: 'W2' });
    expect(getDropHover()).toBeNull();
  });
});
