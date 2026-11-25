import { useEffect, useState } from 'react';
import type { CardSemanticStatus } from '../../../../src/core/card-semantic';
import { fetchCardSemanticStatus, retryCardSemanticIndex, saveCardSemanticConfig } from '../../hooks/useCardSemanticSearch';

const stateText: Record<CardSemanticStatus['state'], string> = {
  unavailable: '이 앱에서 SQLite 의미 검색을 사용할 수 없습니다.',
  off: '꺼짐',
  preparing: '색인 준비 중',
  ready: '검색 가능',
  failed: '초기화 또는 색인 실패',
};

export function CardSemanticPanel() {
  const [status, setStatus] = useState<CardSemanticStatus | null>(null);
  const [draft, setDraft] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    const refresh = () => {
      void fetchCardSemanticStatus(controller.signal).then(next => {
        if (!controller.signal.aborted) setStatus(next);
      }).catch(() => undefined);
    };
    refresh();
    const timer = setInterval(() => refresh(), 3000);
    return () => { controller.abort(); clearInterval(timer); };
  }, []);
  if (!status) return null;
  const directories = (draft ?? status.directories.join('\n')).split('\n').filter(line => line.trim());
  const disabled = busy || status.state === 'unavailable';
  const apply = (operation: () => Promise<CardSemanticStatus>) => {
    setBusy(true);
    setMessage('');
    void operation().then(next => {
      setStatus(next);
      setDraft(undefined);
    }).catch(() => setMessage('설정을 적용하지 못했습니다. 디렉터리와 로컬 모델을 확인해 주세요.'))
      .finally(() => setBusy(false));
  };
  return <section className="kv2-section">
    <h3>카드 의미 검색</h3>
    <label>
      색인을 허용할 비민감 프로젝트 절대 경로 (한 줄에 하나)
      <textarea className="kv2-input" value={draft ?? status.directories.join('\n')}
        rows={2} disabled={disabled} onChange={event => setDraft(event.target.value)} />
    </label>
    <div>
      <button className="kv2-btn kv2-btn--primary" type="button" disabled={disabled || (!status.enabled && !directories.length)}
        onClick={() => apply(() => saveCardSemanticConfig({ enabled: true, directories }))}>
        {status.enabled ? '허용 범위 저장' : '켜기'}
      </button>
      {status.enabled && <button className="kv2-btn kv2-btn--outline" type="button" disabled={disabled}
        onClick={() => apply(() => saveCardSemanticConfig({ enabled: false, directories: status.directories }))}>끄기</button>}
      {(status.failed > 0 || status.state === 'failed') &&
        <button className="kv2-btn kv2-btn--outline" type="button" disabled={disabled}
          onClick={() => apply(retryCardSemanticIndex)}>재시도</button>}
    </div>
    <p role="status">{stateText[status.state]} · 대기 {status.pending}건 · 실패 {status.failed}건</p>
    {message && <p role="alert">{message}</p>}
  </section>;
}
