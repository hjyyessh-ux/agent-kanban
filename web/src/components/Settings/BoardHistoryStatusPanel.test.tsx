import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { BoardHistoryStatusSummary } from '../../../../src/core/types';
import { BoardHistoryStatusView } from './BoardHistoryStatusPanel';
import { BOARD_HISTORY_COPY as COPY } from '../../constants/copy';
import { boardHistoryFailureMessage } from '../../hooks/useBoardHistoryStatus';

const CHECKED = '2026-11-23T01:00:00.000Z';
function registered(overrides: Partial<NonNullable<BoardHistoryStatusSummary['registration']>> = {}): BoardHistoryStatusSummary {
  return {
    state: 'registered', checkedAt: CHECKED,
    registration: {
      installedAt: '2026-11-20T00:00:00.000Z', windowStart: '2026-11-13T00:00:00.000Z',
      captureStartedAt: '2026-11-20T00:00:00.000Z',
      preCaptureGap: { from: '2026-11-13T00:00:00.000Z', to: '2026-11-20T00:00:00.000Z' },
      gaps: [], gapCount: 0, pendingSince: null, continuousSinceWindowStart: false,
      lastChangeRecordedAt: null, lastSaveObservedAt: '2026-11-22T00:00:00.000Z',
      consumer: { readAndAckTimesCollected: false, ackedThroughRecordedAt: null, deliveryAwaitingAck: false,
        unackedEvents: 0, ackedEvents: 0, cursorExpired: false },
      ...overrides,
    },
  };
}
const view = (summary: BoardHistoryStatusSummary | null, failure: { message: string; at: string } | null = null) =>
  renderToStaticMarkup(<BoardHistoryStatusView summary={summary} failure={failure} refreshing={false} onRefresh={() => undefined} />);

test('registered with no changes yet is ON, not OFF; window start and pre-install gap are distinct', () => {
  const html = view(registered());
  expect(html).toContain(COPY.stateRegistered);
  expect(html).not.toContain(COPY.stateNotRegistered);
  expect(html).toContain(COPY.lastChangeNone);
  expect(html).toContain(COPY.windowStart);
  expect(html).toContain(COPY.preCaptureGap);
  expect(html).toContain(COPY.preCaptureHelp);
  expect(html).toContain(COPY.metadataOnly);
});

test('details start closed, while capture gaps and expired cursors are visible in the summary', () => {
  const summary = registered();
  const html = view(registered({
    ...summary.registration,
    consumer: { ...summary.registration!.consumer, cursorExpired: true },
  }));
  const summaryHtml = html.split('<details')[0];
  expect(summaryHtml).toContain(COPY.preCaptureBadge);
  expect(summaryHtml).toContain(COPY.cursorExpired);
  expect(summaryHtml).not.toContain(COPY.windowStart);
  expect(summaryHtml).not.toContain(COPY.checkedAt);
  expect(html).toContain('<details class="settings-board-history-details"><summary>');
  expect(html).toContain(COPY.details);
});

test('read and ACK times are shown as not collected; the committed-event time is labelled as such', () => {
  const html = view(registered({ consumer: { readAndAckTimesCollected: false, ackedThroughRecordedAt: '2026-11-22T03:00:00.000Z',
    deliveryAwaitingAck: true, unackedEvents: 4, ackedEvents: 9, cursorExpired: false } }));
  expect(html.split(COPY.notCollected).length - 1).toBe(2);
  expect(html).toContain(COPY.ackedThrough);
  expect(html).toContain(COPY.ackedThroughHelp);
  expect(html).toContain('>9<');
  expect(html).toContain('>4<');
});

test('counts are withheld when they would mislead; gaps and pending are listed', () => {
  const html = view(registered({
    gaps: [{ kind: 'card', from: '2026-11-21T00:00:00.000Z', to: '2026-11-21T01:00:00.000Z', reason: 'unobserved_writer' }],
    gapCount: 3, pendingSince: '2026-11-22T05:00:00.000Z',
    consumer: { readAndAckTimesCollected: false, ackedThroughRecordedAt: null, deliveryAwaitingAck: false,
      unackedEvents: null, ackedEvents: null, cursorExpired: true },
  }));
  expect(html).toContain(COPY.declaredMissing(3));
  expect(html).toContain(COPY.gapUnobserved);
  expect(html).toContain(COPY.gapsMore(1, 3));
  expect(html).toContain(COPY.pendingBadge);
  expect(html).toContain(COPY.ackedPartial);
  expect(html).toContain(COPY.unackedExpired);
  expect(html).toContain(COPY.cursorExpired);
});

test('not registered, inactive and unavailable are three different messages', () => {
  const off = view({ state: 'not_registered', checkedAt: CHECKED });
  expect(off).toContain(COPY.stateNotRegistered);
  expect(off).toContain(COPY.notRegisteredHelp);
  expect(off).not.toContain(COPY.sectionConsumer);
  expect(view({ state: 'inactive', checkedAt: CHECKED })).toContain(COPY.inactiveHelp);
  const down = view({ state: 'unavailable', checkedAt: CHECKED });
  expect(down).toContain(COPY.stateUnavailable);
  expect(down).not.toContain(COPY.stateNotRegistered);
});

test('a failed refresh keeps the last good summary and says it is stale', () => {
  const html = view(registered(), { message: boardHistoryFailureMessage(503), at: '2026-11-23T02:00:00.000Z' });
  expect(html).toContain(COPY.errorTemporary);
  expect(html).toContain(COPY.stateRegistered);
  expect(html).toContain('직전에 성공한 조회');
  expect(boardHistoryFailureMessage(401)).toBe(COPY.errorUnauthorized);
  expect(boardHistoryFailureMessage(403)).toBe(COPY.errorLocalOnly);
  const first = view(null, { message: COPY.errorTemporary, at: '2026-11-23T02:00:00.000Z' });
  expect(first).not.toContain(COPY.loading);
  expect(first).not.toContain(COPY.stateNotRegistered);
});
