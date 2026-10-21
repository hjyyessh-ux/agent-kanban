import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Work } from '../../../../src/core/types';
import { BoardWorkDropTray } from './BoardWorkDropTray';
import { BoardWorkMoveMenu } from './BoardWorkMoveMenu';
import { BoardWorkDnDContext, type BoardWorkDnD } from './board-work-dnd';
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

describe('BoardWorkMoveMenu', () => {
  test('a ⋯ trigger named for the session, only in works mode and only with a session', () => {
    const html = withDnD(dnd(null), <BoardWorkMoveMenu source={inBeta} />);
    expect(html).toContain(`aria-label="${BOARD_WORKS_COPY.moveMenuLabel('Session one')}"`);
    // The trigger's title previews the choices: the other Work, new, out — never its own Work.
    expect(html).toContain(BOARD_WORKS_COPY.moveTo('Alpha'));
    expect(html).not.toContain(BOARD_WORKS_COPY.moveTo('Beta'));
    expect(html).toContain(BOARD_WORKS_COPY.moveNew);
    expect(html).toContain(BOARD_WORKS_COPY.moveOut);

    expect(withDnD(null, <BoardWorkMoveMenu source={inBeta} />)).toBe('');
    expect(withDnD(dnd(null), <BoardWorkMoveMenu source={{ ...inBeta, sessionId: undefined }} />)).toBe('');
  });
});
