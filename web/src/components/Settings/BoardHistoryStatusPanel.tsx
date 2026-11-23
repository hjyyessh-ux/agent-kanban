import type { BoardHistoryDeclaredGap, BoardHistoryStatusSummary } from '../../../../src/core/types';
import { useBoardHistoryStatus, type BoardHistoryStatusFailure } from '../../hooks/useBoardHistoryStatus';
import { BOARD_HISTORY_COPY as COPY } from '../../constants/copy';
import { ErrorAlert } from '../shared/ErrorAlert';
import './BoardHistoryStatusPanel.css';

const kst = (value: string) => new Date(value).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', hour12: false });
const time = (value: string | null, empty: string = COPY.never) => (value ? `${kst(value)} KST` : empty);

const STATE_LABEL: Record<BoardHistoryStatusSummary['state'], string> = {
  registered: COPY.stateRegistered,
  not_registered: COPY.stateNotRegistered,
  inactive: COPY.stateInactive,
  unavailable: COPY.stateUnavailable,
};
const STATE_HELP: Partial<Record<BoardHistoryStatusSummary['state'], string>> = {
  not_registered: COPY.notRegisteredHelp,
  inactive: COPY.inactiveHelp,
  unavailable: COPY.unavailableHelp,
};

function Metric({ label, value, help }: { label: string; value: string; help?: string }) {
  return <div>
    <dt>{label}</dt>
    <dd>{value}</dd>
    {help && <dd className="settings-board-history-help">{help}</dd>}
  </div>;
}

function gapLine(gap: BoardHistoryDeclaredGap): string {
  const kind = gap.kind === 'card' ? COPY.gapKindCard : COPY.gapKindWork;
  const reason = gap.reason === 'unobserved_writer' ? COPY.gapUnobserved : COPY.gapInterrupted;
  return `${kind} · ${kst(gap.from)} ~ ${kst(gap.to)} · ${reason}`;
}

export function BoardHistoryStatusContent({ summary }: { summary: BoardHistoryStatusSummary }) {
  const r = summary.registration;
  const help = STATE_HELP[summary.state];
  const badges: { label: string; tone: 'primary' | 'quiet' | 'warning' }[] = [
    { label: STATE_LABEL[summary.state], tone: 'primary' },
  ];
  if (r) {
    if (r.continuousSinceWindowStart) badges.push({ label: COPY.continuous, tone: 'quiet' });
    if (r.preCaptureGap) badges.push({ label: COPY.preCaptureBadge, tone: 'warning' });
    if (r.gapCount > 0) badges.push({ label: COPY.declaredMissing(r.gapCount), tone: 'warning' });
    if (r.pendingSince) badges.push({ label: COPY.pendingBadge, tone: 'warning' });
  }
  return <div className="settings-board-history-list" data-state={summary.state}>
    <div className="settings-board-history-badges">
      {badges.map(({ label, tone }) => <span key={label}
        className={`kv2-badge${tone === 'primary' ? ' kv2-badge--accent' : tone === 'warning' ? ' settings-board-history-badge--warning' : ''}`}>{label}</span>)}
    </div>
    {help && <p className="settings-network-desc">{help}</p>}
    {r?.consumer.cursorExpired && <p className="settings-board-history-attention">{COPY.cursorExpired}</p>}
    <details className="settings-board-history-details">
      <summary>{COPY.details}</summary>
      <div className="settings-board-history-detail-body settings-board-history-list">
        <p className="settings-network-desc" data-testid="board-history-checked-at">
          {COPY.checkedAt}: {time(summary.checkedAt)}
        </p>
        {r && <>
          <section aria-label={COPY.sectionWindow}>
            <h4 className="settings-board-history-section">{COPY.sectionWindow}</h4>
            <dl className="settings-board-history-metrics">
              <Metric label={COPY.windowStart} value={time(r.windowStart)} />
              <Metric label={COPY.installedAt} value={time(r.installedAt)} />
              <Metric label={COPY.captureStartedAt} value={time(r.captureStartedAt, COPY.captureNotStarted)} />
              <Metric label={COPY.preCaptureGap}
                value={r.preCaptureGap ? `${time(r.preCaptureGap.from)} ~ ${time(r.preCaptureGap.to)}` : COPY.preCaptureNone}
                help={r.preCaptureGap ? COPY.preCaptureHelp : undefined} />
            </dl>
          </section>
          <section aria-label={COPY.sectionGaps}>
            <h4 className="settings-board-history-section">{COPY.sectionGaps}</h4>
            <dl className="settings-board-history-metrics">
              <Metric label={COPY.gaps} value={r.gapCount > 0 ? COPY.declaredMissing(r.gapCount) : COPY.gapsNone}
                help={r.gapCount > 0 ? COPY.gapHelp : undefined} />
              <Metric label={COPY.pending} value={r.pendingSince ? COPY.pendingSince(time(r.pendingSince)) : COPY.pendingNone} />
            </dl>
            {r.gaps.length > 0 && <ul className="settings-board-history-gaps">
              {r.gaps.map(gap => <li key={`${gap.kind}:${gap.from}:${gap.to}:${gap.reason}`}>{gapLine(gap)}</li>)}
            </ul>}
            {r.gapCount > r.gaps.length && <p className="settings-network-desc">{COPY.gapsMore(r.gaps.length, r.gapCount)}</p>}
          </section>
          <section aria-label={COPY.sectionConsumer}>
            <h4 className="settings-board-history-section">{COPY.sectionConsumer}</h4>
            <dl className="settings-board-history-metrics">
              <Metric label={COPY.lastRead} value={COPY.notCollected} />
              <Metric label={COPY.lastAck} value={COPY.notCollected} />
              <Metric label={COPY.ackedThrough}
                value={r.consumer.ackedThroughRecordedAt ? time(r.consumer.ackedThroughRecordedAt)
                  : r.consumer.ackedEvents === 0 ? COPY.ackedThroughNone : COPY.ackedThroughPruned}
                help={COPY.ackedThroughHelp} />
              <Metric label={COPY.awaitingAck} value={r.consumer.deliveryAwaitingAck ? COPY.yes : COPY.no} />
              <Metric label={COPY.acked} value={r.consumer.ackedEvents === null ? COPY.ackedPartial : String(r.consumer.ackedEvents)} />
              <Metric label={COPY.unacked} value={r.consumer.unackedEvents === null ? COPY.unackedExpired : String(r.consumer.unackedEvents)} />
            </dl>
          </section>
          <section aria-label={COPY.sectionActivity}>
            <h4 className="settings-board-history-section">{COPY.sectionActivity}</h4>
            <dl className="settings-board-history-metrics">
              <Metric label={COPY.lastChange} value={time(r.lastChangeRecordedAt, COPY.lastChangeNone)} />
              <Metric label={COPY.lastSave} value={time(r.lastSaveObservedAt)} help={COPY.lastSaveHelp} />
            </dl>
          </section>
          <p className="settings-network-desc">{COPY.metadataOnly}</p>
          <p className="settings-network-desc">{COPY.readBasis}</p>
        </>}
      </div>
    </details>
  </div>;
}

export function BoardHistoryStatusView({ summary, failure, refreshing, onRefresh, manualRefreshStatus = '' }: {
  summary: BoardHistoryStatusSummary | null;
  failure: BoardHistoryStatusFailure | null;
  refreshing: boolean;
  onRefresh: () => void;
  manualRefreshStatus?: string;
}) {
  return <section className="settings-item settings-board-history-panel" aria-label={COPY.title}>
    <div className="settings-board-history-header">
      <div>
        <h3 className="kv2-panel-heading">{COPY.title}</h3>
        <p className="settings-network-desc">{COPY.description}</p>
      </div>
      <button type="button" className="kv2-btn kv2-btn--outline kv2-btn--small"
        onClick={() => { if (!refreshing) onRefresh(); }}
        aria-disabled={refreshing || undefined} aria-busy={refreshing || undefined}>
        {refreshing ? COPY.refreshing : COPY.refresh}
      </button>
    </div>
    <span role="status" className="settings-board-history-screen-reader">{manualRefreshStatus}</span>
    {failure && <ErrorAlert title={COPY.errorTitle} variant="inline"
      message={`${failure.message} (${COPY.failedAt(time(failure.at))})${summary ? ` ${COPY.staleNote(time(summary.checkedAt))}` : ''}`} />}
    {summary ? <BoardHistoryStatusContent summary={summary} /> : !failure && <p>{COPY.loading}</p>}
  </section>;
}

export function BoardHistoryStatusPanel() {
  const { summary, failure, refreshing, refresh, manualRefreshStatus } = useBoardHistoryStatus();
  return <BoardHistoryStatusView summary={summary} failure={failure} refreshing={refreshing}
    manualRefreshStatus={manualRefreshStatus} onRefresh={() => void refresh(true)} />;
}
