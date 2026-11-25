import {useState} from 'react';
import '../shared/PromptRefinement.css';
import {formatModelRef,refinementErrorMessage,usePromptRefinementCatalog} from '../../hooks/usePromptRefinementCatalog';
import {PromptRefinementRequestError} from '../../hooks/usePromptProposalProvider';
import {isSelectableModel,sameModelRef,type PromptModelRef} from '../../../../src/core/prompt-proposal';

/**
 * Refinement default + connection status. Same server catalog as the modal picker.
 * Saving is explicit and server-validated; card Model Visibility below is separate
 * and never read or written here.
 */
export function PromptRefinementModelsPanel() {
  const {catalog,status,reload,saveDefault} = usePromptRefinementCatalog();
  const [draft,setDraft] = useState<PromptModelRef | null>(null);
  const [saving,setSaving] = useState(false);
  const [message,setMessage] = useState('');
  const saved = catalog?.savedDefault ?? null;
  const current = draft && isSelectableModel(catalog,draft) ? draft : catalog?.effectiveDefault ?? null;
  const canSave = !saving && !!draft && isSelectableModel(catalog,draft) && !(saved?.valid && sameModelRef(draft,saved));
  const selectableCount = catalog?.providers.reduce((n,p)=>n+p.models.filter(m=>m.selectable).length,0) ?? 0;
  const run = async (ref:PromptModelRef | null) => {
    setSaving(true); setMessage('');
    try {
      await saveDefault(ref); setDraft(null);
      setMessage(ref ? `기본값을 ${formatModelRef(ref)}(으)로 저장했습니다. 서버를 다시 시작해도 유지됩니다.` : '저장된 기본값을 지웠습니다. 서버 기본값을 사용합니다.');
    } catch (error) {
      const code = error instanceof PromptRefinementRequestError ? error.code : 'save_failed';
      setMessage(refinementErrorMessage(code) + (error instanceof PromptRefinementRequestError && error.reason ? ` (${error.reason})` : ''));
    } finally { setSaving(false); }
  };
  return <section className="settings-model-filter kv2-refine-settings" aria-labelledby="prompt-refinement-models-heading">
    <div className="settings-model-filter-header">
      <div className="settings-model-filter-info">
        <h3 id="prompt-refinement-models-heading" className="settings-network-title">다듬기 모델</h3>
        <p className="settings-network-desc">프롬프트 다듬기 모달이 처음 선택하는 기본 모델과 제공자 연결 상태입니다. 모달에서 고른 모델은 그 생성에만 쓰이고 이 기본값은 바뀌지 않습니다. 카드 실행 모델은 아래 Model Visibility에서 따로 관리하며 저장값도 분리돼 있습니다.</p>
      </div>
      <div className="settings-model-filter-actions">
        <button type="button" className="kv2-btn kv2-btn--outline kv2-btn--small" onClick={reload} disabled={status==='loading'}>
          {status==='loading'?'확인 중…':'연결 상태 다시 확인'}</button>
      </div>
    </div>
    <p className="settings-network-desc">상태 확인은 모델을 호출하지 않고 서버 설정, 전용 로그인 파일 존재, 허용 목록만 봅니다.</p>
    {status==='error' && !catalog && <p role="alert" className="settings-network-desc">다듬기 모델 상태를 불러오지 못했습니다. 기본 틀 추가(AI 호출 없음)는 계속 사용할 수 있습니다.</p>}
    {catalog && <>
      <p className="settings-network-desc" data-testid="refine-default-status">
        {saved?.valid ? `저장된 기본값: ${formatModelRef(saved)} · 서버 데이터 폴더에 저장돼 재시작 후에도 유지`
          : `저장된 기본값 없음 · 서버 기본값 ${formatModelRef(catalog.serverDefault)} 사용`}</p>
      {saved && !saved.valid && <p role="alert" className="settings-network-desc">
        저장된 기본값 {formatModelRef(saved)}을(를) 지금 쓸 수 없습니다: {saved.reason}. {catalog.serverDefault ? `서버 기본값 ${formatModelRef(catalog.serverDefault)}로 시작합니다.` : '기본 틀 추가만 사용할 수 있습니다.'}</p>}
      {selectableCount===0 && <p className="settings-network-desc">선택 가능한 다듬기 모델이 없습니다. 기본 틀 추가(AI 호출 없음)는 사용할 수 있습니다.</p>}
      <div className="kv2-refine-settings-groups">
        {catalog.providers.map(group=><details key={group.provider} className="settings-model-group kv2-refine-settings-group"
          open={group.ready || undefined} data-provider={group.provider}>
          <summary><strong>{group.provider}</strong> <span className="settings-model-group-count">{group.summary}</span></summary>
          <ul className="kv2-refine-checks" aria-label={group.provider+' 연결 점검'}>
            {group.checks.map(check=><li key={check.key} data-ok={check.ok}>
              <span aria-hidden="true">{check.ok?'✓':'✕'}</span> {check.label}: {check.detail}</li>)}
          </ul>
          <p className="settings-network-desc">비용: {group.billing} · 설정 위치: {group.settingsHint}</p>
          {group.models.length ? <fieldset className="kv2-refine-settings-models">
            <legend>{group.provider} 모델 ({group.models.filter(m=>m.selectable).length}/{group.models.length} 선택 가능)</legend>
            {group.models.map(model=>{
              const ref={provider:group.provider,model:model.id};
              const reasonId=`refine-reason-${group.provider}-${model.id}`.replace(/[^A-Za-z0-9_-]/g,'-');
              return <div key={model.id} className="kv2-refine-settings-model" data-selectable={model.selectable}>
                <label>
                  <input type="radio" name="prompt-refinement-default" aria-label={`${group.provider} / ${model.id}`}
                    checked={sameModelRef(ref,current)} disabled={!model.selectable || saving}
                    aria-describedby={model.selectable?undefined:reasonId}
                    onChange={()=>{ if(model.selectable){setDraft(ref);setMessage('');} }}/>
                  <span>{model.id}</span>{model.label!==model.id && <small> · {model.label}</small>}
                  {model.serverDefault && <small className="kv2-refine-tag">서버 기본</small>}
                  {saved?.valid && sameModelRef(ref,saved) && <small className="kv2-refine-tag">저장된 기본값</small>}
                </label>
                {!model.selectable && <small id={reasonId} className="kv2-refine-model-reason">
                  선택 불가 — {model.reason}{model.settingsHint?` · 설정 위치: ${model.settingsHint}`:''}</small>}
              </div>;
            })}
          </fieldset> : <p className="settings-network-desc">표시할 모델이 없습니다.</p>}
        </details>)}
      </div>
      <div className="kv2-refine-settings-actions">
        <button type="button" className="kv2-btn kv2-btn--primary kv2-btn--small" disabled={!canSave}
          onClick={()=>void run(draft)}>기본값 저장</button>
        {saved && <button type="button" className="kv2-btn kv2-btn--ghost kv2-btn--small" disabled={saving}
          onClick={()=>void run(null)}>저장값 지우기 (서버 기본값 사용)</button>}
      </div>
    </>}
    <p role="status" className="settings-network-desc">{message}</p>
  </section>;
}
