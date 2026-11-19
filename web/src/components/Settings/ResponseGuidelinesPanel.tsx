import React, { useEffect, useState } from 'react';
import type { SettingsEntry } from '../../../../src/core/types';
import {
  RESPONSE_GUIDELINES_MAX_LENGTH,
  RESPONSE_GUIDELINES_SETTING_KEY,
  RESPONSE_GUIDELINES_SUGGESTION,
  normalizeResponseGuidelines,
} from '../../../../src/core/response-guidelines';
import { upsertSettingByKey } from '../../hooks/useSettingsApi';
import { RESPONSE_GUIDELINES_COPY as COPY } from '../../constants/copy';

interface ResponseGuidelinesPanelProps {
  entry: SettingsEntry | undefined;
  onSaved: () => Promise<void>;
}

/**
 * Common response guidelines editor. Blank = feature off. The text is sent
 * to Claude/Codex runs as instructions, never shown inside user turns.
 */
export const ResponseGuidelinesPanel: React.FC<ResponseGuidelinesPanelProps> = ({ entry, onSaved }) => {
  const saved = normalizeResponseGuidelines(entry?.value);
  const [draft, setDraft] = useState(saved);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    if (!dirty) setDraft(saved);
  }, [saved, dirty]);

  const enabled = saved.length > 0;
  const tooLong = draft.trim().length > RESPONSE_GUIDELINES_MAX_LENGTH;

  const save = async (value: string) => {
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      await upsertSettingByKey(RESPONSE_GUIDELINES_SETTING_KEY, value);
      setDirty(false);
      await onSaved();
      setNotice(normalizeResponseGuidelines(value) ? COPY.savedOn : COPY.savedOff);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : COPY.saveFailed);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="settings-model-filter settings-guidelines">
      <div className="settings-model-filter-header">
        <div className="settings-model-filter-info">
          <h3 className="settings-network-title">
            {COPY.title}{' '}
            <span className={`kv2-badge ${enabled ? 'kv2-badge--saved' : ''}`}>
              {enabled ? COPY.on : COPY.off}
            </span>
          </h3>
          <p className="settings-network-desc">{COPY.description}</p>
        </div>
      </div>
      <textarea
        className="kv2-textarea settings-guidelines-textarea"
        aria-label={COPY.title}
        rows={4}
        value={draft}
        placeholder={`${COPY.placeholderPrefix}${RESPONSE_GUIDELINES_SUGGESTION}`}
        onChange={(e) => { setDraft(e.target.value); setDirty(true); setNotice(null); }}
        disabled={saving}
      />
      <div className="settings-guidelines-footer">
        <span className={`settings-guidelines-count ${tooLong ? 'settings-guidelines-count--over' : ''}`}>
          {draft.trim().length} / {RESPONSE_GUIDELINES_MAX_LENGTH}
        </span>
        <div className="settings-model-filter-actions">
          <button
            type="button"
            className="kv2-btn kv2-btn--outline kv2-btn--small"
            onClick={() => { setDraft(RESPONSE_GUIDELINES_SUGGESTION); setDirty(true); setNotice(null); }}
            disabled={saving}
          >
            {COPY.useSuggestion}
          </button>
          <button
            type="button"
            className="kv2-btn kv2-btn--outline kv2-btn--small"
            onClick={() => { setDraft(''); setDirty(true); setNotice(null); }}
            disabled={saving || draft.length === 0}
          >
            {COPY.clear}
          </button>
          <button
            type="button"
            className="kv2-btn kv2-btn--primary kv2-btn--small"
            onClick={() => void save(draft)}
            disabled={saving || tooLong || normalizeResponseGuidelines(draft) === saved}
          >
            {saving ? COPY.saving : COPY.save}
          </button>
        </div>
      </div>
      {error && <p className="settings-guidelines-error" role="alert">{error}</p>}
      {notice && <p className="settings-network-desc" role="status">{notice}</p>}
    </div>
  );
};
