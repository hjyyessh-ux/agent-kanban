import React, { useState, useEffect, useMemo } from 'react';
import type { SettingsEntry, CreateSettingsInput, UpdateSettingsInput } from '../../../../src/core/types';
import type { RuntimeCatalogModel } from '../../../../src/core/runtime-config';
import { CLAUDE_MODELS, CODEX_MODELS } from '../../../../src/core/runtime-config';
import { fetchModels, type ModelInfo } from '../../hooks/useKanbanApi';
import { readSyncedCatalog, useModelSync } from '../../hooks/useModelCatalog';
import { fetchSetting } from '../../hooks/useSettingsApi';
import { useFontScale } from '../../hooks/useFontScale';
import { useTheme, type ThemePreference } from '../../hooks/useTheme';
import { SettingsEntryModal } from './SettingsEntryModal';
import { SettingsMaintenancePanel } from './SettingsMaintenancePanel';
import { ErrorAlert } from '../shared/ErrorAlert';
import type { UiAlert } from '../../hooks/uiAlert';
import './Settings.css';

interface SettingsViewProps {
  entries: SettingsEntry[];
  loading: boolean;
  error: UiAlert | null;
  onCreateEntry: (input: CreateSettingsInput) => Promise<SettingsEntry>;
  onUpdateEntry: (id: string, input: UpdateSettingsInput) => Promise<void>;
  onDeleteEntry: (id: string) => Promise<void>;
  onRefresh: () => Promise<void>;
  onClearError: () => void;
}

const timeAgo = (isoString: string) => {
  const date = new Date(isoString);
  const now = new Date();
  const diffInSeconds = Math.floor((now.getTime() - date.getTime()) / 1000);
  if (diffInSeconds < 60) return 'just now';
  const diffInMinutes = Math.floor(diffInSeconds / 60);
  if (diffInMinutes < 60) return `${diffInMinutes}m ago`;
  const diffInHours = Math.floor(diffInMinutes / 60);
  if (diffInHours < 24) return `${diffInHours}h ago`;
  return `${Math.floor(diffInHours / 24)}d ago`;
};

const maskValue = (value: string) => {
  if (value.length <= 4) return '••••••••';
  return value.substring(0, 2) + '••••••' + value.substring(value.length - 2);
};

export const SettingsView: React.FC<SettingsViewProps> = ({
  entries,
  loading,
  error,
  onCreateEntry,
  onUpdateEntry,
  onDeleteEntry,
  onRefresh,
  onClearError,
}) => {
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [editEntry, setEditEntry] = useState<SettingsEntry | null>(null);
  const [revealedIds, setRevealedIds] = useState<Set<string>>(new Set());
  // Plaintext secret values fetched on demand (the list endpoint redacts them).
  const [revealedValues, setRevealedValues] = useState<Record<string, string>>({});
  const [modelList, setModelList] = useState<ModelInfo[]>([]);
  const MODEL_FILTER_KEY = 'kanban-enabled-models';
  const [enabledModelIds, setEnabledModelIds] = useState<Set<string>>(() => {
    try {
      const stored = localStorage.getItem(MODEL_FILTER_KEY);
      if (stored) return new Set(JSON.parse(stored));
    } catch {}
    return new Set<string>(); // empty = "all enabled" (initial state before models load)
  });
  const [hasStoredPreference, setHasStoredPreference] = useState(() => !!localStorage.getItem(MODEL_FILTER_KEY));
  const fontScale = useFontScale();
  const theme = useTheme();
  const { sync, syncing, outcome } = useModelSync();
  // Bumped after a sync so the derived catalogs re-read the synced pool.
  const [catalogNonce, setCatalogNonce] = useState(0);
  const [modelQuery, setModelQuery] = useState('');
  const [expandedModelGroups, setExpandedModelGroups] = useState<Set<string>>(
    () => new Set(['opencode']),
  );

  const claudeCatalog = useMemo<RuntimeCatalogModel[]>(() => {
    const synced = readSyncedCatalog().claude;
    const hardIds = new Set<string>(CLAUDE_MODELS.map((m) => m.id));
    return [
      ...CLAUDE_MODELS.map((m) => ({ id: m.id, label: m.label, tier: m.tier })),
      ...synced.filter((m) => !hardIds.has(m.id)),
    ];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [catalogNonce]);

  const codexCatalog = useMemo<RuntimeCatalogModel[]>(() => {
    const synced = readSyncedCatalog().codex;
    const hardIds = new Set<string>(CODEX_MODELS.map((m) => m.id));
    return [
      ...CODEX_MODELS.map((m) => ({ id: m.id, label: m.label, tier: m.tier })),
      ...synced.filter((m) => !hardIds.has(m.id)),
    ];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [catalogNonce]);

  const syncedAt = useMemo(() => readSyncedCatalog().syncedAt, [catalogNonce]);

  const allKnownIds = useMemo(
    () => [
      ...modelList.map((m) => m.id),
      ...claudeCatalog.map((m) => m.id),
      ...codexCatalog.map((m) => m.id),
    ],
    [modelList, claudeCatalog, codexCatalog],
  );
  const modelGroups = useMemo(() => {
    const query = modelQuery.trim().toLowerCase();
    const groups = [
      {
        key: 'opencode',
        label: 'OpenCode',
        items: modelList.map((model) => ({
          id: model.id,
          name: model.name,
          provider: model.providerName,
        })),
      },
      {
        key: 'claude',
        label: 'Claude',
        items: claudeCatalog.map((model) => ({
          id: model.id,
          name: model.label,
          provider: model.tier ?? 'claude',
        })),
      },
      {
        key: 'codex',
        label: 'Codex',
        items: codexCatalog.map((model) => ({
          id: model.id,
          name: model.label,
          provider: model.tier ?? 'codex',
        })),
      },
    ];

    return groups.map((group) => ({
      ...group,
      visibleItems: query
        ? group.items.filter((item) =>
            item.name.toLowerCase().includes(query) ||
            item.id.toLowerCase().includes(query) ||
            item.provider.toLowerCase().includes(query),
          )
        : group.items,
    }));
  }, [modelQuery, modelList, claudeCatalog, codexCatalog]);

  useEffect(() => {
    fetchModels().then(setModelList).catch(() => setModelList([]));
  }, []);

  useEffect(() => {
    if (allKnownIds.length > 0 && !hasStoredPreference) {
      setEnabledModelIds(new Set(allKnownIds));
    }
  }, [allKnownIds, hasStoredPreference]);

  const toggleModel = (modelId: string) => {
    setEnabledModelIds(prev => {
      const next = new Set(prev);
      if (next.has(modelId)) next.delete(modelId);
      else next.add(modelId);
      localStorage.setItem(MODEL_FILTER_KEY, JSON.stringify([...next]));
      setHasStoredPreference(true);
      return next;
    });
  };

  const toggleAllModels = () => {
    const allEnabled = allKnownIds.every(id => enabledModelIds.has(id));
    const next = allEnabled ? new Set<string>() : new Set(allKnownIds);
    setEnabledModelIds(next);
    localStorage.setItem(MODEL_FILTER_KEY, JSON.stringify([...next]));
    setHasStoredPreference(true);
  };

  const toggleModelGroup = (groupKey: string) => {
    setExpandedModelGroups((previous) => {
      const next = new Set(previous);
      if (next.has(groupKey)) next.delete(groupKey);
      else next.add(groupKey);
      return next;
    });
  };

  const handleSyncModels = async () => {
    await sync();
    setCatalogNonce(n => n + 1);
    // Sync updates the catalog only. Preserve the user's visibility selections.
    const raw = localStorage.getItem(MODEL_FILTER_KEY);
    if (raw) {
      try {
        setEnabledModelIds(new Set(JSON.parse(raw)));
        setHasStoredPreference(true);
      } catch {
        // keep current state
      }
    }
  };

  const handleCreate = async (input: CreateSettingsInput) => {
    await onCreateEntry(input);
  };

  const handleUpdate = async (id: string, input: UpdateSettingsInput) => {
    await onUpdateEntry(id, input);
  };

  const handleDelete = (entry: SettingsEntry) => {
    if (window.confirm(`Delete "${entry.key}"? This cannot be undone.`)) {
      void onDeleteEntry(entry.id);
    }
  };

  const toggleReveal = async (id: string) => {
    const willReveal = !revealedIds.has(id);
    setRevealedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    // The list endpoint redacts masked values; fetch the plaintext on demand.
    if (willReveal && revealedValues[id] === undefined) {
      try {
        const full = await fetchSetting(id);
        setRevealedValues(prev => ({ ...prev, [id]: full.value }));
      } catch {
        // Leave masked on failure.
      }
    }
  };

  // Separate network_exposed / lan_full_access from generic entries
  const networkEntry = entries.find(e => e.key === 'network_exposed');
  const lanFullAccessEntry = entries.find(e => e.key === 'lan_full_access');
  const genericEntries = entries.filter(e => e.key !== 'network_exposed' && e.key !== 'lan_full_access');

  // Sort by category (grouped), then by key alphabetically
  const sortedEntries = [...genericEntries].sort((a, b) => {
    const catA = a.category ?? '';
    const catB = b.category ?? '';
    if (catA !== catB) return catA.localeCompare(catB);
    return a.key.localeCompare(b.key);
  });

  const isNetworkExposed = networkEntry?.value === 'true';
  const isLanFullAccess = lanFullAccessEntry?.value === 'true';

  const handleNetworkToggle = async () => {
    if (!networkEntry) return;
    await onUpdateEntry(networkEntry.id, { value: isNetworkExposed ? 'false' : 'true' });
  };

  const handleLanFullAccessToggle = async () => {
    if (!lanFullAccessEntry) return;
    await onUpdateEntry(lanFullAccessEntry.id, { value: isLanFullAccess ? 'false' : 'true' });
  };

  return (
    <div className="settings-view">
      <div className="settings-toolbar">
        <div className="settings-toolbar-heading">
          <h2 className="settings-toolbar-title">Settings</h2>
          <p className="settings-toolbar-subtitle">
            연결, 모델, 화면 표시와 로컬 설정을 관리합니다. {entries.length}개 사용자 설정
          </p>
        </div>
        <button
          type="button"
          className="kv2-btn kv2-btn--primary"
          onClick={() => setShowCreateModal(true)}
        >
          + 새 설정
        </button>
      </div>

      {/* Network Exposure Toggle */}
      {networkEntry && (
        <div className="settings-network-toggle">
          <div className="settings-network-info">
            <h3 className="settings-network-title">네트워크 접근</h3>
            <p className="settings-network-desc">
              {isNetworkExposed
                ? '같은 네트워크의 다른 기기에서도 보드에 접근할 수 있습니다 (0.0.0.0).'
                : '이 기기에서만 보드에 접근할 수 있습니다 (localhost).'}
            </p>
          </div>
          <button
            type="button"
            className={`settings-toggle-switch ${isNetworkExposed ? 'settings-toggle-switch--on' : ''}`}
            onClick={handleNetworkToggle}
            role="switch"
            aria-checked={isNetworkExposed}
            aria-label="Toggle network access"
          >
            <span className="settings-toggle-knob" />
            <span className="settings-toggle-label">
              {isNetworkExposed ? 'ON' : 'OFF'}
            </span>
          </button>
        </div>
      )}

      {/* LAN Full Access Toggle — only relevant when the board is network-exposed */}
      {lanFullAccessEntry && isNetworkExposed && (
        <div className="settings-network-toggle">
          <div className="settings-network-info">
            <h3 className="settings-network-title">LAN 전체 접근</h3>
            <p className="settings-network-desc">
              {isLanFullAccess
                ? 'LAN 기기에 인증 토큰을 제공해 모든 기능과 변경 작업을 허용합니다. 이 포트에 접근 가능한 사용자는 전체 권한을 갖습니다.'
                : 'LAN 기기에는 읽기 전용 보드만 제공합니다. Capabilities와 Settings 변경은 localhost에서만 가능합니다.'}
            </p>
          </div>
          <button
            type="button"
            className={`settings-toggle-switch ${isLanFullAccess ? 'settings-toggle-switch--on' : ''}`}
            onClick={handleLanFullAccessToggle}
            role="switch"
            aria-checked={isLanFullAccess}
            aria-label="Toggle LAN full access"
          >
            <span className="settings-toggle-knob" />
            <span className="settings-toggle-label">
              {isLanFullAccess ? 'ON' : 'OFF'}
            </span>
          </button>
        </div>
      )}

      <SettingsMaintenancePanel />

      {/* Model Visibility Filter */}
      <div className="settings-model-filter">
        <div className="settings-model-filter-header">
          <div className="settings-model-filter-info">
            <h3 className="settings-network-title">Model Visibility</h3>
            <p className="settings-network-desc">
              카드 생성·편집 화면에 표시할 모델을 선택합니다.
            </p>
          </div>
          <div className="settings-model-filter-actions">
            <button
              type="button"
              className="kv2-btn kv2-btn--outline kv2-btn--small"
              onClick={() => void handleSyncModels()}
              disabled={syncing}
              title="Fetch the latest Claude/Codex models from the backend provider list"
            >
              {syncing ? '동기화 중…' : '↻ 모델 동기화'}
            </button>
            <button
              type="button"
              className="kv2-btn kv2-btn--outline kv2-btn--small"
              onClick={toggleAllModels}
            >
              {allKnownIds.every(id => enabledModelIds.has(id)) ? '전체 해제' : '전체 선택'}
            </button>
          </div>
        </div>

        <div className="settings-model-search-row">
          <input
            type="search"
            className="kv2-input settings-model-search"
            value={modelQuery}
            onChange={(event) => setModelQuery(event.target.value)}
            placeholder="모델 이름, ID, provider 검색"
            aria-label="Search visible models"
          />
          <span className="settings-model-selection-count">
            {enabledModelIds.size} / {allKnownIds.length}개 표시
          </span>
        </div>

        {(syncedAt || outcome) && (
          <p className="settings-model-sync-status">
            {outcome?.error
              ? `Sync failed: ${outcome.error}`
              : outcome
                ? `Synced — ${outcome.added} new model${outcome.added === 1 ? '' : 's'} added`
                : syncedAt
                  ? `Last synced ${timeAgo(syncedAt)}`
                  : ''}
          </p>
        )}

        <div className="settings-model-groups">
          {modelGroups.map((group) => {
            const open = modelQuery.trim().length > 0 || expandedModelGroups.has(group.key);
            const selectedCount = group.items.filter((item) => enabledModelIds.has(item.id)).length;
            return (
              <section key={group.key} className="settings-model-group">
                <button
                  type="button"
                  className="settings-model-group-toggle"
                  onClick={() => toggleModelGroup(group.key)}
                  aria-expanded={open}
                  aria-controls={`settings-model-group-${group.key}`}
                >
                  <span>{group.label}</span>
                  <span className="settings-model-group-count">
                    {selectedCount}/{group.items.length} 표시 {open ? '▴' : '▾'}
                  </span>
                </button>
                {open && (
                  <div className="settings-model-list" id={`settings-model-group-${group.key}`}>
                    {group.visibleItems.length > 0 ? group.visibleItems.map((model) => (
                      <label key={model.id} className="settings-model-item">
                        <input
                          type="checkbox"
                          className="settings-model-checkbox"
                          checked={enabledModelIds.has(model.id)}
                          onChange={() => toggleModel(model.id)}
                        />
                        <span className="settings-model-name">{model.name}</span>
                        <span className="settings-model-provider">{model.provider}</span>
                      </label>
                    )) : (
                      <p className="settings-model-empty">검색 결과가 없습니다.</p>
                    )}
                  </div>
                )}
              </section>
            );
          })}
        </div>
      </div>

      {/* Appearance */}
      <div className="settings-model-filter">
        <div className="settings-model-filter-header">
          <div className="settings-model-filter-info">
            <h3 className="settings-network-title">Appearance</h3>
            <p className="settings-network-desc">
              테마와 전체 UI 글자 크기를 한곳에서 조정합니다.
            </p>
          </div>
        </div>
        <div className="settings-appearance-grid">
          <div className="settings-appearance-section">
            <span className="settings-appearance-label">Theme</span>
            <div className="settings-theme-control" role="group" aria-label="Theme">
              {(['light', 'dark', 'system'] as const).map((opt) => {
                const labels: Record<ThemePreference, string> = {
                  light: '☀ Light',
                  dark: '🌙 Dark',
                  system: '💻 System',
                };
                const active = theme.preference === opt;
                return (
                  <button
                    key={opt}
                    type="button"
                    className={`kv2-btn kv2-btn--small ${active ? 'kv2-btn--primary' : 'kv2-btn--outline'}`}
                    aria-pressed={active}
                    onClick={() => theme.setPreference(opt)}
                  >
                    {labels[opt]}
                  </button>
                );
              })}
            </div>
          </div>
          <div className="settings-appearance-section">
            <div className="settings-appearance-section-header">
              <span className="settings-appearance-label">Font Size</span>
              {fontScale.scale !== 1 && (
                <button
                  type="button"
                  className="kv2-btn kv2-btn--outline kv2-btn--small"
                  onClick={() => fontScale.setScale(1)}
                >
                  Reset
                </button>
              )}
            </div>
            <div className="settings-font-scale-control">
              <span className="settings-font-scale-label">A</span>
              <input
                type="range"
                className="settings-font-scale-slider"
                min={fontScale.min}
                max={fontScale.max}
                step={0.05}
                value={fontScale.scale}
                onChange={(e) => fontScale.setScale(Number(e.target.value))}
                aria-label="Font size scale"
              />
              <span className="settings-font-scale-label settings-font-scale-label--lg">A</span>
              <span className="settings-font-scale-value">{Math.round(fontScale.scale * 100)}%</span>
            </div>
          </div>
        </div>
      </div>

      {error && (
        <ErrorAlert
          className="error-banner"
          title={error.title}
          message={error.message}
          actionLabel={error.actionLabel}
          onAction={() => {
            void onRefresh();
          }}
          onDismiss={onClearError}
        />
      )}

      {loading && entries.length === 0 ? (
        <div className="loading-spinner" role="status" aria-live="polite" />
      ) : entries.length === 0 ? (
        <div className="settings-empty">
          아직 사용자 설정이 없습니다. 스크립트에서 사용할 secret이나 설정값을 추가하세요.
        </div>
      ) : (
        <div className="settings-list">
          {sortedEntries.map((entry) => (
            <div
              key={entry.id}
              className="settings-item settings-item--clickable"
              onClick={() => setEditEntry(entry)}
              onKeyDown={(event) => {
                if (event.target !== event.currentTarget) return;
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  setEditEntry(entry);
                }
              }}
              role="button"
              tabIndex={0}
              aria-label={`Edit setting ${entry.key}`}
            >
              <div className="settings-item-header">
                <div className="settings-item-info">
                  <h3 className="settings-item-key">{entry.key}</h3>
                  {entry.description && (
                    <p className="settings-item-desc">{entry.description}</p>
                  )}
                </div>
                <div className="settings-item-actions">
                  <button
                    type="button"
                    className="kv2-btn kv2-btn--outline kv2-btn--small"
                    onClick={(e) => { e.stopPropagation(); setEditEntry(entry); }}
                  >
                    ✎ Edit
                  </button>
                  <button
                    type="button"
                    className="kv2-btn kv2-btn--subtle-danger kv2-btn--small"
                    onClick={(e) => { e.stopPropagation(); handleDelete(entry); }}
                  >
                    ✕ Delete
                  </button>
                </div>
              </div>

              <div className="settings-item-value">
                <span className="settings-item-value-text">
                  {entry.masked !== false && !revealedIds.has(entry.id)
                    ? maskValue(entry.value)
                    : (revealedValues[entry.id] ?? entry.value)
                  }
                </span>
                {entry.masked !== false && (
                  <button
                    type="button"
                    className="settings-reveal-btn"
                    onClick={(e) => { e.stopPropagation(); void toggleReveal(entry.id); }}
                  >
                    {revealedIds.has(entry.id) ? 'HIDE' : 'SHOW'}
                  </button>
                )}
              </div>

              <div className="settings-item-meta">
                {entry.category && (
                  <span className="kv2-badge settings-badge--category">
                    {entry.category}
                  </span>
                )}
                {entry.masked !== false && (
                  <span className="kv2-badge settings-badge--masked">
                    🔒 masked
                  </span>
                )}
                <span>Updated {timeAgo(entry.updatedAt)}</span>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Create Modal */}
      {showCreateModal && (
        <SettingsEntryModal
          onClose={() => setShowCreateModal(false)}
          onSave={handleCreate}
        />
      )}

      {/* Edit Modal */}
      {editEntry && (
        <SettingsEntryModal
          onClose={() => setEditEntry(null)}
          onSave={handleCreate}
          onUpdate={handleUpdate}
          editEntry={editEntry}
        />
      )}
    </div>
  );
};
