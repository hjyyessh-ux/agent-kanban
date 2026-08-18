import React, { useEffect, useMemo, useRef, useState } from 'react';
import type {
  CreateQuickActionInput,
  QuickActionView,
  RunQuickActionResponse,
  ScriptEntry,
  UpdateQuickActionInput,
} from '../../../../src/core/types';
import { DialogSkeleton } from '../Card/DialogSkeleton';
import { ErrorAlert } from '../shared/ErrorAlert';
import { QuickActionEditorDialog } from './QuickActionEditorDialog';
import { QuickActionRunPanel } from './QuickActionRunPanel';

export {
  buildQuickActionInput,
  buildQuickActionUpdateInput,
  makeQuickActionEditorDraft,
} from './quickActionEditorModel';

type EditorTarget = QuickActionView | 'new' | null;

export interface QuickActionsDrawerProps {
  open: boolean;
  actions: QuickActionView[];
  scripts: ScriptEntry[];
  loading: boolean;
  error: string | null;
  runningActionIds: string[];
  onOpen: () => void;
  onClose: () => void;
  onCreate: (input: CreateQuickActionInput) => Promise<QuickActionView>;
  onUpdate: (id: string, input: UpdateQuickActionInput) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  onRun: (
    id: string,
    parameterValues: Readonly<Record<string, unknown>>,
  ) => Promise<RunQuickActionResponse>;
  onRefresh: () => Promise<void>;
  onClearError: () => void;
}

function getActionState(
  action: QuickActionView,
  runningActionIds: readonly string[],
): { label: string | null; unavailable: boolean; running: boolean } {
  const running = runningActionIds.includes(action.id);
  if (running) return { label: 'Running', unavailable: false, running: true };
  if (!action.enabled) return { label: 'Disabled', unavailable: true, running: false };
  if (!action.available) return { label: 'Unavailable', unavailable: true, running: false };
  return { label: null, unavailable: false, running: false };
}

export const QuickActionsDrawer: React.FC<QuickActionsDrawerProps> = ({
  open,
  actions,
  scripts,
  loading,
  error,
  runningActionIds,
  onOpen,
  onClose,
  onCreate,
  onUpdate,
  onDelete,
  onRun,
  onRefresh,
  onClearError,
}) => {
  const railButtonRef = useRef<HTMLButtonElement>(null);
  const wasOpenRef = useRef(open);
  const addButtonRef = useRef<HTMLButtonElement>(null);
  const runButtonRefs = useRef(new Map<string, HTMLButtonElement>());
  const menuButtonRefs = useRef(new Map<string, HTMLElement>());
  const editorReturnTargetRef = useRef<'add' | string | null>(null);
  const runReturnTargetRef = useRef<string | null>(null);
  const [editorTarget, setEditorTarget] = useState<EditorTarget>(null);
  const [selectedActionId, setSelectedActionId] = useState<string | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);

  const selectedAction = useMemo(
    () => actions.find((action) => action.id === selectedActionId) ?? null,
    [actions, selectedActionId],
  );

  useEffect(() => {
    if (selectedActionId && !selectedAction) setSelectedActionId(null);
  }, [selectedAction, selectedActionId]);

  useEffect(() => {
    const wasOpen = wasOpenRef.current;
    wasOpenRef.current = open;
    let focusFrame: number | undefined;
    if (!open) {
      setSelectedActionId(null);
      setLocalError(null);
      setEditorTarget(null);
      if (wasOpen) {
        focusFrame = window.requestAnimationFrame(() => railButtonRef.current?.focus());
      }
    }
    return () => {
      if (focusFrame !== undefined) window.cancelAnimationFrame(focusFrame);
    };
  }, [open]);

  useEffect(() => {
    if (!open || editorTarget !== null || editorReturnTargetRef.current === null) return;
    const target = editorReturnTargetRef.current;
    editorReturnTargetRef.current = null;
    const focusFrame = window.requestAnimationFrame(() => {
      if (target === 'add') addButtonRef.current?.focus();
      else menuButtonRefs.current.get(target)?.focus();
    });
    return () => window.cancelAnimationFrame(focusFrame);
  }, [editorTarget, open]);

  useEffect(() => {
    if (!open || selectedActionId !== null || runReturnTargetRef.current === null) return;
    const target = runReturnTargetRef.current;
    runReturnTargetRef.current = null;
    const focusFrame = window.requestAnimationFrame(() => runButtonRefs.current.get(target)?.focus());
    return () => window.cancelAnimationFrame(focusFrame);
  }, [open, selectedActionId]);

  const openEditor = (action?: QuickActionView) => {
    setLocalError(null);
    editorReturnTargetRef.current = action?.id ?? 'add';
    setEditorTarget(action ?? 'new');
  };

  const closeDrawer = () => {
    setSelectedActionId(null);
    setLocalError(null);
    onClose();
  };

  const deleteAction = async (action: QuickActionView) => {
    if (!window.confirm(`Delete Quick Action “${action.name}”?`)) return;
    setLocalError(null);
    try {
      await onDelete(action.id);
    } catch (caught: unknown) {
      setLocalError(caught instanceof Error ? caught.message : 'Failed to delete quick action');
    }
  };

  return (
    <>
      <aside
        className="kv2-quick-actions-drawer kv2-quick-actions-drawer--collapsed"
        aria-label="Quick Actions"
      >
        <button
          ref={railButtonRef}
          type="button"
          className="kv2-btn kv2-btn--primary kv2-btn--edge-tab kv2-quick-actions-rail"
          aria-label="Open Quick Actions"
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-controls="quick-actions-drawer-panel"
          title="Open Quick Actions"
          hidden={open}
          onClick={onOpen}
        >
          <span className="kv2-quick-actions-rail-icon" aria-hidden="true">⚡</span>
          <span className="kv2-quick-actions-rail-label" aria-hidden="true">Quick</span>
          <span className="kv2-quick-actions-rail-cue" aria-hidden="true">›</span>
        </button>
      </aside>

      {open && !editorTarget && (
        <DialogSkeleton
          title="Quick Actions"
          dialogId="quick-actions-drawer-panel"
          className="kv2-dialog--side-sheet kv2-dialog--quick-actions-sheet"
          overlayClassName="kv2-dialog-overlay--side-sheet"
          width="min(28rem, 100vw)"
          initialFocusRef={addButtonRef}
          onClose={closeDrawer}
        >
          <div className="kv2-quick-actions-drawer-body">
            <div className="kv2-quick-actions-sheet-intro">
              <p className="kv2-panel-subtitle">Run saved actions without leaving the Board.</p>
              <button
                ref={addButtonRef}
                type="button"
                className="kv2-btn kv2-btn--small kv2-btn--primary kv2-quick-actions-add"
                onClick={() => openEditor()}
              >
                Add Action
              </button>
            </div>

            {(error || localError) && (
              <ErrorAlert
                title="Quick Action error"
                message={localError ?? error ?? 'Unknown error'}
                actionLabel="Refresh"
                onAction={() => { void onRefresh(); }}
                onDismiss={() => {
                  setLocalError(null);
                  onClearError();
                }}
                variant="inline"
              />
            )}

            {selectedAction ? (
              <QuickActionRunPanel
                key={selectedAction.id}
                action={selectedAction}
                running={runningActionIds.includes(selectedAction.id)}
                onRun={onRun}
                onBack={() => {
                  runReturnTargetRef.current = selectedAction.id;
                  setSelectedActionId(null);
                  setLocalError(null);
                }}
                onCompleted={closeDrawer}
                onError={(message) => setLocalError(message || null)}
              />
            ) : loading && actions.length === 0 ? (
              <div className="loading-spinner" role="status" aria-label="Loading quick actions" />
            ) : actions.length === 0 ? (
              <div className="kv2-quick-actions-empty">No Quick Actions yet. Add one to start.</div>
            ) : (
              <ul className="kv2-quick-action-drawer-list">
                {actions.map((action) => {
                  const state = getActionState(action, runningActionIds);
                  return (
                    <li className="kv2-quick-action-drawer-row" key={action.id}>
                      <button
                        ref={(element) => {
                          if (element) runButtonRefs.current.set(action.id, element);
                          else runButtonRefs.current.delete(action.id);
                        }}
                        type="button"
                        className="kv2-btn kv2-btn--ghost kv2-quick-action-drawer-select"
                        aria-label={`Run ${action.name}`}
                        disabled={state.unavailable || state.running}
                        onClick={() => {
                          setLocalError(null);
                          setSelectedActionId(action.id);
                        }}
                      >
                        <span className="kv2-quick-action-item-icon" aria-hidden="true">{action.icon}</span>
                        <span className="kv2-quick-action-item-main">
                          <span className="kv2-quick-action-item-title">
                            {action.name}
                          </span>
                          <span className="kv2-quick-action-item-meta kv2-quick-action-drawer-meta">
                            <span className="kv2-badge kv2-badge--accent">
                              {action.type === 'prompt' ? 'Prompt' : 'Script'}
                            </span>
                            {action.pinned && (
                              <span className="kv2-badge" title="Shown before unpinned Quick Actions">
                                Pinned
                              </span>
                            )}
                            {state.label && (
                              <span className="kv2-badge" role={state.running ? 'status' : undefined}>
                                {state.label}
                              </span>
                            )}
                          </span>
                          {(action.description || (!action.available && action.unavailableReason)) && (
                            <span className="kv2-quick-action-item-description">
                              {!action.available && action.unavailableReason
                                ? action.unavailableReason
                                : action.description}
                            </span>
                          )}
                        </span>
                        <span className="kv2-quick-action-run-affordance" aria-hidden="true">Run →</span>
                      </button>
                      <details className="kv2-quick-action-row-menu">
                        <summary
                          ref={(element) => {
                            if (element) menuButtonRefs.current.set(action.id, element);
                            else menuButtonRefs.current.delete(action.id);
                          }}
                          className="kv2-btn kv2-btn--small kv2-btn--outline"
                          aria-label={`More actions for ${action.name}`}
                        >
                          <span aria-hidden="true">•••</span>
                        </summary>
                        <div className="kv2-quick-action-manage-actions">
                          <button
                            type="button"
                            className="kv2-btn kv2-btn--small kv2-btn--outline"
                            aria-label={`Edit ${action.name}`}
                            onClick={() => openEditor(action)}
                          >
                            Edit
                          </button>
                          <button
                            type="button"
                            className="kv2-btn kv2-btn--small kv2-btn--subtle-danger"
                            aria-label={`Delete ${action.name}`}
                            onClick={() => { void deleteAction(action); }}
                          >
                            Delete
                          </button>
                        </div>
                      </details>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </DialogSkeleton>
      )}

      {editorTarget && (
        <QuickActionEditorDialog
          action={editorTarget === 'new' ? undefined : editorTarget}
          actions={actions}
          scripts={scripts}
          error={error}
          onCreate={onCreate}
          onUpdate={onUpdate}
          onRefresh={onRefresh}
          onClearError={onClearError}
          onSaved={() => setEditorTarget(null)}
          onCancel={() => setEditorTarget(null)}
        />
      )}
    </>
  );
};
