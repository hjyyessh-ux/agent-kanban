import React from 'react';
import { BOARD_WORKS_COPY } from '../../constants/copy';
import { useBoardWorkDnD, workDropTargetProps } from './board-work-dnd';

/**
 * Bottom drop tray (`GROUP: WORKS`, mockup B안): rises while a session group
 * or a card is being dragged, so a session can go into **any** active Work —
 * including one with no fragment in this column, which is every Work for a
 * todo / in-progress card. Lists every active Work (the current one dimmed and
 * inert, `(현재)`), `＋ 새 Work`, and `⊘ Work에서 빼기` when there is a Work
 * to leave. A source with no session gets a note instead of targets.
 *
 * `position: fixed` and mounted only after `dragstart` (BoardScreen defers the
 * state flip a frame), so it never shifts anything under the pointer.
 */
export const BoardWorkDropTray: React.FC = () => {
  const dnd = useBoardWorkDnD();
  if (!dnd?.drag) return null;
  const source = dnd.drag;

  return (
    <div className="kv2-work-tray" role="region" aria-label={BOARD_WORKS_COPY.trayAria}>
      <span className="kv2-work-tray-label">{BOARD_WORKS_COPY.trayLabel}</span>
      {source.sessionId ? (
        <div className="kv2-work-tray-list">
          {dnd.works.map((work) => {
            const current = work.id === source.workId;
            return (
              <div
                key={work.id}
                className={`kv2-work-tray-drop${current ? ' is-current' : ''}`}
                data-tray-work-id={work.id}
                title={work.title}
                {...workDropTargetProps(dnd, { kind: 'work', workId: work.id })}
              >
                <span className="kv2-card-work-tag-icon" aria-hidden="true">{BOARD_WORKS_COPY.tagIcon}</span>
                <span className="kv2-work-tray-drop-title">{work.title}</span>
                {current && <span className="kv2-work-tray-current">{BOARD_WORKS_COPY.trayCurrent}</span>}
              </div>
            );
          })}
          <div
            className="kv2-work-tray-drop kv2-work-tray-drop--new"
            data-tray-new=""
            {...workDropTargetProps(dnd, { kind: 'new' })}
          >
            {BOARD_WORKS_COPY.trayNew}
          </div>
          {source.workId && (
            <div
              className="kv2-work-tray-drop kv2-work-tray-drop--out"
              data-tray-out=""
              {...workDropTargetProps(dnd, { kind: 'unassigned' })}
            >
              {BOARD_WORKS_COPY.trayOut}
            </div>
          )}
        </div>
      ) : (
        <span className="kv2-work-tray-note">{BOARD_WORKS_COPY.trayNoSession}</span>
      )}
    </div>
  );
};
