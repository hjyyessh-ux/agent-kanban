import React, { useState } from 'react';
import type { ScriptEntry, ScriptSyncResult, CreateScriptInput, UpdateScriptInput } from '../../../../src/core/types';
import { ScriptEditModal } from './ScriptEditModal';
import { ScriptHistoryPanel } from './ScriptHistoryPanel';
import '../../styles/components.css';
import './Scripts.css';

interface ScriptsViewProps {
  entries: ScriptEntry[];
  loading: boolean;
  error: string | null;
  onCreateEntry: (input: CreateScriptInput) => Promise<ScriptEntry>;
  onUpdateEntry: (id: string, input: UpdateScriptInput) => Promise<void>;
  onDeleteEntry: (id: string) => Promise<void>;
  onRunEntry: (id: string) => Promise<void>;
  onRefresh: () => Promise<void>;
  onSync: () => Promise<ScriptSyncResult>;
}

export function ScriptsView({
  entries,
  loading,
  error,
  onCreateEntry,
  onUpdateEntry,
  onDeleteEntry,
  onRunEntry,
  onRefresh,
  onSync
}: ScriptsViewProps) {
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [editEntry, setEditEntry] = useState<ScriptEntry | null>(null);
  const [historyEntry, setHistoryEntry] = useState<ScriptEntry | null>(null);
  const [runningScriptIds, setRunningScriptIds] = useState<Set<string>>(new Set());
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState<string | null>(null);

  // Format time helper
  const timeAgo = (dateStr: string) => {
    if (!dateStr) return 'Never';
    const date = new Date(dateStr);
    const now = new Date();
    const seconds = Math.floor((now.getTime() - date.getTime()) / 1000);

    if (seconds < 60) return 'Just now';
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    return `${days}d ago`;
  };

  const handleCreate = async (input: CreateScriptInput) => {
    try {
      await onCreateEntry(input);
      setShowCreateModal(false);
      await onRefresh();
    } catch (err) {
      console.error('Failed to create script:', err);
      // Ideally show toast or alert
    }
  };

  const handleUpdate = async (input: CreateScriptInput) => {
    if (!editEntry) return;
    try {
      await onUpdateEntry(editEntry.id, input);
      setEditEntry(null);
      await onRefresh();
    } catch (err) {
      console.error('Failed to update script:', err);
    }
  };

  const handleDelete = async (id: string) => {
    if (!window.confirm('Are you sure you want to delete this script? This cannot be undone.')) {
      return;
    }
    try {
      await onDeleteEntry(id);
      await onRefresh();
    } catch (err) {
      console.error('Failed to delete script:', err);
    }
  };

  const handleRun = async (id: string) => {
    try {
      setRunningScriptIds(prev => new Set(prev).add(id));
      await onRunEntry(id);
      await onRefresh();
    } catch (err) {
      console.error('Failed to run script:', err);
    } finally {
      setRunningScriptIds(prev => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  };

  const handleEditOpen = (entry: ScriptEntry) => {
    setEditEntry(entry);
  };

  const stopClickPropagation = (event: React.MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
  };

  // Sort by createdAt desc
  const sortedEntries = [...entries].sort((a, b) => {
    return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
  });

  if (loading && entries.length === 0) {
    return (
      <div className="neo-surface scripts-loading">
        <div className="neo-spinner"></div>
        <p>Loading scripts...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="neo-surface neo-surface--error scripts-error">
        <h3>Error Loading Scripts</h3>
        <p>{error}</p>
        <button type="button" className="neo-button" onClick={() => onRefresh()}>Try Again</button>
      </div>
    );
  }

  return (
    <div className="scripts-view">
      <div className="scripts-header">
        <div className="scripts-title-group">
          <h2 className="scripts-title">Scripts</h2>
          <span className="neo-badge">{entries.length}</span>
        </div>
        <p className="scripts-source-hint">Sync reads files from ~/.agent-kanban/scripts (or KANBAN_DATA_DIR/scripts).</p>
        <div className="scripts-header-actions">
          {syncResult && (
            <span className="scripts-sync-result">{syncResult}</span>
          )}
          <button
            type="button"
            className="neo-button neo-button--secondary"
            onClick={async () => {
              setSyncing(true);
              setSyncResult(null);
              try {
                const result = await onSync();
                const msg = `Data-dir sync: ${result.created} new, ${result.updated} updated, ${result.removed} removed`;
                setSyncResult(msg);
                setTimeout(() => setSyncResult(null), 4000);
              } catch {
                setSyncResult('Sync failed');
                setTimeout(() => setSyncResult(null), 4000);
              } finally {
                setSyncing(false);
              }
            }}
            disabled={syncing}
          >
            {syncing ? 'Syncing...' : '🔄 Sync'}
          </button>
          <button
            type="button"
            className="neo-button neo-button--primary"
            onClick={() => setShowCreateModal(true)}
          >
            + New Script
          </button>
        </div>
      </div>

      <div className="scripts-list">
        {sortedEntries.length === 0 ? (
          <div className="scripts-empty">
            <p>No scripts found. Create one to get started.</p>
          </div>
        ) : (
          sortedEntries.map(entry => (
            <div
              key={entry.id}
              className="neo-surface scripts-item"
              onClick={() => handleEditOpen(entry)}
              style={{ cursor: 'pointer' }}
            >
              <div className="scripts-item-header">
                <div className="scripts-item-main">
                  <h3 className="scripts-item-name">{entry.name}</h3>
                  <div className="scripts-badges">
                    <span className={`neo-badge scripts-badge--${entry.language}`}>
                      {entry.language}
                    </span>
                    {entry.lastRunStatus && (
                      <span className={`neo-badge neo-badge--${entry.lastRunStatus === 'success' ? 'success' : 'error'}`}>
                        {entry.lastRunStatus === 'success' ? 'Success' : 'Failed'}
                      </span>
                    )}
                  </div>
                </div>
                <div className="scripts-item-meta">
                  {entry.lastRunAt && (
                    <span className="scripts-last-run">
                      Ran {timeAgo(entry.lastRunAt)}
                    </span>
                  )}
                </div>
              </div>

              {entry.description && (
                <p className="scripts-item-description">{entry.description}</p>
              )}

              <div className="scripts-item-content">
                $ {entry.content.substring(0, 80).replace(/\n/g, ' ')}
                {entry.content.length > 80 ? '...' : ''}
              </div>

              <div className="scripts-item-actions">
                <button 
                  type="button"
                  className="neo-button neo-button--sm"
                  onClick={(event) => {
                    stopClickPropagation(event);
                    void handleRun(entry.id);
                  }}
                  disabled={runningScriptIds.has(entry.id)}
                >
                  {runningScriptIds.has(entry.id) ? 'Running...' : '▶ Run Now'}
                </button>
                <button 
                  type="button"
                  className="neo-button neo-button--secondary neo-button--sm"
                  onClick={(event) => {
                    stopClickPropagation(event);
                    setHistoryEntry(entry);
                  }}
                >
                  📋 History ({entry.history.length})
                </button>
                <button 
                  type="button"
                  className="neo-button neo-button--secondary neo-button--sm"
                  onClick={(event) => {
                    stopClickPropagation(event);
                    handleEditOpen(entry);
                  }}
                >
                  ✎ Edit
                </button>
                <button 
                  type="button"
                  className="neo-button neo-button--danger neo-button--sm"
                  onClick={(event) => {
                    stopClickPropagation(event);
                    void handleDelete(entry.id);
                  }}
                >
                  ✕ Delete
                </button>
              </div>
            </div>
          ))
        )}
      </div>

      {showCreateModal && (
        <ScriptEditModal
          onClose={() => setShowCreateModal(false)}
          onSave={handleCreate}
        />
      )}

      {editEntry && (
        <ScriptEditModal
          editEntry={editEntry}
          onClose={() => setEditEntry(null)}
          onSave={handleUpdate}
        />
      )}

      {historyEntry && (
        <ScriptHistoryPanel
          entry={historyEntry}
          onClose={() => setHistoryEntry(null)}
        />
      )}
    </div>
  );
}
