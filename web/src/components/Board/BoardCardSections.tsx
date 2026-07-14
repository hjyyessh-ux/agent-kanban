import React, { useEffect, useState } from 'react';
import type { KanbanStatus } from '../../../../src/core/types';
import codexIconUrl from '../../assets/codex-icon-transparent.png';
import type { ChildItem, V2CardViewModel } from './board-selectors';

export const ActionSpinner: React.FC = () => (
  <span className="kv2-action-spinner" aria-hidden="true" />
);

const FavoriteStarIcon: React.FC<{ active: boolean }> = ({ active }) => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false">
    <path
      d="M12 2.8 14.95 8.76 21.52 9.72 16.76 14.35 17.88 20.88 12 17.79 6.12 20.88 7.24 14.35 2.48 9.72 9.05 8.76 12 2.8Z"
      fill={active ? 'currentColor' : 'none'}
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinejoin="round"
    />
  </svg>
);

const TelegramIcon: React.FC<{ size?: number }> = ({ size = 21 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false">
    <circle cx="12" cy="12" r="12" fill="var(--kv2-runtime-telegram)" />
    <path d="M5.2 11.7l12.1-4.7c.6-.2 1.1.1.9.9l-2 9.6c-.2.7-.6.9-1.1.5l-3-2.3-1.4 1.4c-.2.2-.4.3-.7.3l.3-3.1 5.6-5c.2-.2-.1-.3-.4-.1L7.4 14.3 4.5 13.4c-.7-.2-.7-.6.7-1.7z" fill="white" />
  </svg>
);

export const TelegramBadge: React.FC<{ title?: string; size?: number }> = ({ title = 'Telegram origin', size = 21 }) => (
  <span className="kv2-telegram-badge" title={title} role="img" aria-label="Telegram">
    <TelegramIcon size={size} />
  </span>
);

export function formatRuntimeLabel(runtime: V2CardViewModel['agentRuntime'] | undefined): string {
  if (runtime === 'codex') return 'Codex';
  if (runtime === 'claude') return 'Claude';
  return 'Opencode';
}

export const RuntimeBadge: React.FC<{ runtime: V2CardViewModel['agentRuntime'] | undefined }> = ({ runtime }) => (
  <span className={`kv2-runtime-badge kv2-runtime-badge--${runtime ?? 'opencode'}`} title={`${formatRuntimeLabel(runtime)} runtime`}>
    <RuntimeBadgeIcon runtime={runtime ?? 'opencode'} />
    <span className="kv2-runtime-badge-text">{formatRuntimeLabel(runtime).toUpperCase()}</span>
  </span>
);

export const RuntimeBadgeIcon: React.FC<{ runtime: NonNullable<V2CardViewModel['agentRuntime']> }> = ({ runtime }) => {
  if (runtime === 'codex') {
    return (
      <span className="kv2-runtime-badge-icon kv2-runtime-badge-icon--codex" aria-hidden="true">
        <img className="kv2-runtime-badge-image" src={codexIconUrl} alt="" />
      </span>
    );
  }

  if (runtime === 'claude') {
    return (
      <span className="kv2-runtime-badge-icon kv2-runtime-badge-icon--claude" aria-hidden="true">
        <ClaudeCodeStar />
      </span>
    );
  }

  return (
    <span className="kv2-runtime-badge-icon kv2-runtime-badge-icon--opencode" aria-hidden="true">
      <span className="kv2-opencode-icon-panel" />
    </span>
  );
};

const ClaudeCodeStar = () => (
  <svg width="14" height="14" viewBox="0 0 26 28" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false">
    <path d="M5.07306 17.7192L9.99106 14.9614L10.0721 14.7199L9.99106 14.5854H9.74786L8.92369 14.5352L6.11341 14.46L3.68143 14.3597L1.31701 14.2344L0.722529 14.109L0.168579 13.3694L0.222623 13.0059L0.722529 12.6675L1.43861 12.7301L3.0194 12.843L5.39733 13.0059L7.11322 13.1062L9.66679 13.3694H10.0721L10.1262 13.2065L9.99106 13.1062L9.88297 13.0059L7.42397 11.3387L4.76231 9.58378L3.37068 8.56843L2.62758 8.05448L2.24927 7.57814L2.08714 6.52518L2.76269 5.77306L3.68143 5.83574L3.91112 5.89842L4.84338 6.61293L6.82949 8.15476L9.4236 10.0601L9.80191 10.3735L9.95424 10.2707L9.97755 10.198L9.80191 9.9097L8.39676 7.36504L6.89705 4.77024L6.2215 3.69221L6.04585 3.05291C5.97781 2.78463 5.93777 2.56267 5.93777 2.28826L6.70789 1.2353L7.14024 1.09741L8.18059 1.2353L8.61294 1.61136L9.26147 3.09052L10.3018 5.40954L11.9231 8.56843L12.396 9.50857L12.6527 10.3735L12.7473 10.6367H12.9094V10.4863L13.0445 8.70631L13.2877 6.52518L13.5309 3.71728L13.612 2.92756L14.0038 1.97488L14.7875 1.46093L15.3954 1.74925L15.8954 2.46376L15.8278 2.92756L15.5306 4.85799L14.9496 7.87899L14.5713 9.9097H14.7875L15.0442 9.64646L16.071 8.29265L17.7869 6.13659L18.5435 5.28419L19.4352 4.34404L20.0027 3.89277H21.0836L21.8672 5.07109L21.5159 6.28701L20.408 7.69096L19.4893 8.88181L18.172 10.6467L17.3545 12.0658L17.4278 12.1828L17.6248 12.166L20.5972 11.5267L22.205 11.2384L24.1235 10.9125L24.9882 11.3136L25.0828 11.7273L24.745 12.5672L22.6914 13.0686L20.2864 13.5575L16.7051 14.4005L16.6655 14.4324L16.7123 14.5018L18.3273 14.648L19.0164 14.6856H20.7053L23.8533 14.9238L24.6775 15.4628L25.1639 16.1272L25.0828 16.6411L23.8128 17.2804L22.1104 16.8793L18.1247 15.9266L16.7601 15.5882H16.5709V15.701L17.7058 16.8166L19.8 18.6969L22.4076 21.1288L22.5428 21.7304L22.205 22.2068L21.8537 22.1566L19.5568 20.4268L18.6651 19.6496L16.6655 17.9573H16.5304V18.1328L16.9897 18.8097L19.4352 22.4826L19.5568 23.6107L19.3812 23.9743L18.7462 24.1999L18.0571 24.0745L16.6114 22.0564L15.1387 19.8L13.9498 17.7693L13.8062 17.86L13.0986 25.4158L12.7743 25.8044L12.0177 26.0927L11.3827 25.6164L11.0449 24.8392L11.3827 23.2974L11.788 21.2917L12.1123 19.6997L12.4095 17.7192L12.5911 17.0575L12.575 17.0133L12.43 17.0376L10.9368 19.0855L8.66698 22.1566L6.87002 24.0745L6.43767 24.25L5.69457 23.8614L5.76212 23.172L6.18096 22.5578L8.66698 19.3989L10.1667 17.4309L11.1333 16.3012L11.1239 16.1378L11.0705 16.1332L4.46507 20.4393L3.28961 20.5897L2.7762 20.1134L2.84375 19.3362L3.08695 19.0855L5.07306 17.7192Z" fill="var(--kv2-runtime-claude)"/>
  </svg>
);

export const AgentPill: React.FC<{
  emoji: string | null;
  label: string | null;
  color: string;
  sourceContext?: string;
}> = ({ emoji, label, color, sourceContext }) => {
  if (sourceContext === 'claude-code') {
    return (
      <span className="kv2-agent-pill kv2-agent-pill--claude-code">
        <ClaudeCodeStar />
        <span className="kv2-agent-pill-text">CLAUDE</span>
      </span>
    );
  }

  if (!label) return null;

  return (
    <span
      className="kv2-agent-pill"
      style={{ '--kv2-pill-color': color } as React.CSSProperties}
    >
      {emoji && <span className="kv2-agent-pill-emoji">{emoji}</span>}
      <span className="kv2-agent-pill-text">{label.toUpperCase()}</span>
    </span>
  );
};


export const NestedChildAccordion: React.FC<{ items: ChildItem[] }> = ({ items }) => {
  const [open, setOpen] = useState(false);
  if (items.length === 0) return null;

  return (
    <div className="kv2-nested-accordion">
      <button
        type="button"
        className="kv2-nested-accordion-toggle"
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
      >
        <span className="kv2-nested-accordion-arrow">{open ? '▾' : '▸'}</span>
        <span>Tasks ({items.length})</span>
      </button>
      {open && (
        <ul className="kv2-nested-accordion-list">
          {items.map((item) => {
            const dot =
              item.status === 'complete' || item.status === 'done'
                ? '✅'
                : item.status === 'in_progress'
                  ? '⏳'
                  : '○';
            return (
              <li key={item.id} className="kv2-nested-accordion-item">
                <span className="kv2-nested-accordion-dot">{dot}</span>
                <span className="kv2-nested-accordion-title">{item.title}</span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
};

export const QueueTargetChip: React.FC<{
  queueTargetTitle: string | undefined;
  queuedAfterCardId: string | undefined;
  queuePosition: number | undefined;
  queueSessionMode: V2CardViewModel['queueSessionMode'];
  onClick?: () => void;
}> = ({ queueTargetTitle, queuedAfterCardId, queuePosition, queueSessionMode, onClick }) => {
  if (!queuedAfterCardId) return null;

  const title = queueTargetTitle ?? 'Queued target';
  const chipLabel = queueTargetTitle ? `🔗 ${queueTargetTitle}` : 'Queued target';
  const modeHint = queueSessionMode === 'continue_queued_after_session' ? 'Continue session' : 'New session';
  const posHint = queuePosition === 1 ? 'Next up' : queuePosition ? `Queued #${queuePosition}` : 'Queued';

  if (onClick) {
    return (
      <button
        type="button"
        className="kv2-card-queue-target"
        title={`${posHint} · ${modeHint} · ${title}`}
        onClick={(event) => {
          event.stopPropagation();
          onClick();
        }}
      >
        <span className="kv2-card-queue-target-text">{chipLabel}</span>
      </button>
    );
  }

  return (
    <span className="kv2-card-queue-target" title={`${posHint} · ${modeHint} · ${title}`}>
      <span className="kv2-card-queue-target-text">{chipLabel}</span>
    </span>
  );
};

export const FavoriteToggleButton: React.FC<{
  active: boolean;
  onToggle: () => void;
  className?: string;
}> = ({ active, onToggle, className = '' }) => {
  const buttonClassName = ['kv2-favorite-toggle', active ? 'is-active' : '', className]
    .filter(Boolean)
    .join(' ');

  return (
    <button
      type="button"
      className={buttonClassName}
      aria-pressed={active}
      aria-label={active ? 'Unstar card' : 'Star card'}
      title={active ? 'Keep in Complete' : 'Star card'}
      onClick={(event) => {
        event.stopPropagation();
        onToggle();
      }}
    >
      <FavoriteStarIcon active={active} />
    </button>
  );
};

interface CardActionsProps {
  vm: V2CardViewModel;
  onStatusChange?: (newStatus: KanbanStatus) => void;
  onDispatch?: () => void | Promise<void>;
  onQueueOpen?: () => void;
  onUnqueue?: () => void;
}

export const CardActions: React.FC<CardActionsProps> = ({
  vm,
  onStatusChange,
  onDispatch,
  onQueueOpen,
  onUnqueue,
}) => {
  const [starting, setStarting] = useState(false);

  // Keep the busy state until the card actually leaves `todo`. Dispatch only
  // *initiates* the run; the status flips to in_progress asynchronously (via
  // polling), so resetting right after onDispatch() would briefly flash the
  // "▶ Start" button again before the card transitions. A safety timeout
  // clears the state if the status never changes.
  useEffect(() => {
    if (!starting) return;
    if (vm.status !== 'todo') {
      setStarting(false);
      return;
    }
    const timer = setTimeout(() => setStarting(false), 30000);
    return () => clearTimeout(timer);
  }, [starting, vm.status]);

  if (vm.parentCardId) return null;

  const stop = (e: React.MouseEvent) => e.stopPropagation();

  if (vm.status === 'todo') {
    return (
      <div className="kv2-card-actions">
        {onDispatch && (
          <button
            type="button"
            className="kv2-card-action kv2-card-action--start"
            disabled={starting}
            aria-busy={starting}
            onClick={async (e) => {
              stop(e);
              if (starting) return;
              setStarting(true);
              try {
                await onDispatch();
                // Leave `starting` set; the effect above clears it once the
                // card status transitions away from `todo`.
              } catch {
                setStarting(false);
              }
            }}
          >
            {starting ? (
              <>
                <ActionSpinner /> Starting…
              </>
            ) : (
              '▶ Start'
            )}
          </button>
        )}

        {vm.queuedAfterCardId && onUnqueue ? (
          <button
            type="button"
            className="kv2-card-action kv2-card-action--queue kv2-card-action--no-upper"
            onClick={(e) => {
              stop(e);
              onUnqueue();
            }}
          >
            Dequeue
          </button>
        ) : onQueueOpen ? (
          <button
            type="button"
            className="kv2-card-action kv2-card-action--queue"
            onClick={(e) => {
              stop(e);
              onQueueOpen();
            }}
          >
            Queue
          </button>
        ) : null}

        <QueueTargetChip
          queueTargetTitle={vm.queueTargetTitle}
          queuedAfterCardId={vm.queuedAfterCardId}
          queuePosition={vm.queuePosition}
          queueSessionMode={vm.queueSessionMode}
          onClick={onQueueOpen}
        />
      </div>
    );
  }

  if (vm.status === 'in_progress') {
    return (
      <div className="kv2-card-actions">
        {onStatusChange && (
          <button
            type="button"
            className="kv2-card-action kv2-card-action--finish"
            onClick={(e) => {
              stop(e);
              onStatusChange('complete');
            }}
          >
            ✓ Finish
          </button>
        )}
        {onStatusChange && (
          <button
            type="button"
            className="kv2-card-action kv2-card-action--secondary"
            onClick={(e) => {
              stop(e);
              onStatusChange('todo');
            }}
          >
            Reopen
          </button>
        )}
      </div>
    );
  }

  if (vm.status === 'complete') {
    return (
      <div className="kv2-card-actions">
        {onStatusChange && (
          <button
            type="button"
            className="kv2-card-action kv2-card-action--done"
            onClick={(e) => {
              stop(e);
              onStatusChange('done');
            }}
          >
            ✓ Done
          </button>
        )}
        {onStatusChange && (
          <button
            type="button"
            className="kv2-card-action kv2-card-action--secondary"
            onClick={(e) => {
              stop(e);
              onStatusChange('todo');
            }}
          >
            Reopen
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="kv2-card-actions">
      {onStatusChange && (
        <button
          type="button"
          className="kv2-card-action kv2-card-action--secondary"
          onClick={(e) => {
            stop(e);
            onStatusChange('todo');
          }}
        >
          Reopen
        </button>
      )}
    </div>
  );
};
