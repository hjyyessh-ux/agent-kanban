import React, { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { PromptModelPicker } from './PromptModelPicker';
import './PromptRefinement.css';
import { DialogSkeleton } from '../Card/DialogSkeleton';
import { usePromptProposalProvider } from '../../hooks/usePromptProposalProvider';
import { usePromptProposal } from '../../hooks/usePromptProposal';
import { providerModels, type PromptProposalProvider } from '../../utils/prompt-refinement-provider';
import {
  applyPromptPreview, LOOP_ROUNDS, normalizeRounds, previewLoopPrompt, previewPrompt, undoPromptApplication,
  type PromptLoopOptions, type RefinementPreview,
} from '../../utils/prompt-refinement';

export interface PromptRefinementProps { value: string; onChange: (value: string) => void; disabled?: boolean; aiProvider?: PromptProposalProvider }
type RefinementMode = 'local' | 'ai';

/** A separate modal above the editor; only a selected proposal changes the draft. */
export function PromptRefinement({value, onChange, disabled, aiProvider: injected}: PromptRefinementProps) {
  const id = useId();
  const layer = useRef<HTMLDivElement>(null);
  const step = useRef<HTMLParagraphElement>(null);
  const [stage,setStage] = useState<'options' | 'review'>('options');
  const trigger = useRef<HTMLButtonElement>(null);
  // User edits/selection belong to this local draft, not to the latest generated
  // template. Refreshing goal/limits must not silently discard them.
  const localEdits = useRef(new Map<string,string>());
  const localExcluded = useRef(new Set<string>());
  const aiProvider = usePromptProposalProvider(injected);
  const models = useMemo(() => providerModels(aiProvider), [aiProvider]);
  const [mode,setMode] = useState<RefinementMode>('local');
  const [model,setModel] = useState('');
  const [loopOn,setLoopOn] = useState(false);
  const [goal,setGoal] = useState('');
  const [doneWhen,setDoneWhen] = useState('');
  const [maxRounds,setMaxRounds] = useState<number>(LOOP_ROUNDS.default);
  const selectedModel = models.includes(model) ? model :
    aiProvider && models.includes(aiProvider.model) ? aiProvider.model : models[0] ?? '';
  const loop: PromptLoopOptions | undefined = useMemo(
    () => loopOn ? {goal, doneWhen, maxRounds: normalizeRounds(maxRounds)} : undefined, [loopOn, goal, doneWhen, maxRounds]);
  const ai = usePromptProposal(value, aiProvider, {model: selectedModel, loop});
  const [isOpen,setIsOpen] = useState(false);
  const [preview,setPreview] = useState<RefinementPreview | null>(null);
  const [selected,setSelected] = useState<string[]>([]);
  const [history,setHistory] = useState<{original:string; applied:string} | null>(null);
  const [notice,setNotice] = useState('');
  const [modalError,setModalError] = useState('');
  const stale = preview !== null && preview.source !== value;
  const readOnly = disabled || stale;
  const setResult = (result: RefinementPreview) => {
    setPreview(result); setSelected(result.sections.map(s => s.id));
  };
  // Local template follows option changes instantly (no network). AI results are dropped on any
  // option change so an older reply can never stand for the new settings.
  useEffect(() => {
    if (!isOpen) return;
    if (mode === 'ai') { setPreview(null); setSelected([]); return; }
    if (!value.trim()) { setPreview(null); return; }
    try {
      const next=loop ? previewLoopPrompt(value, loop) : previewPrompt(value);
      setPreview({...next,sections:next.sections.map(section=>localEdits.current.has(section.id)
        ? {...section,body:localEdits.current.get(section.id)!} : section)});
      setSelected(next.sections.map(section=>section.id).filter(sectionId=>!localExcluded.current.has(sectionId)));
      setModalError('');
    }
    catch (error) { setPreview(null); setModalError(error instanceof Error ? error.message : '미리보기를 만들지 못했습니다.'); }
    // `value` is deliberately not a dependency: an outside edit marks the preview stale instead of rebuilding it.
  }, [isOpen, mode, loop, selectedModel]);
  useLayoutEffect(() => {
    const currentLayer = layer.current;
    const restoredTrigger = trigger.current;
    if (!isOpen || !currentLayer) return;
    const background = Array.from(document.body.children).filter(
      (item): item is HTMLElement => item instanceof HTMLElement && item !== currentLayer && !item.inert,
    );
    // Move focus before making its current owner inert (which can trigger a blur).
    currentLayer.querySelector<HTMLElement>('[role="dialog"]')?.focus();
    const previousHidden = background.map(item => item.getAttribute('aria-hidden'));
    background.forEach(item => {
      item.inert = true;
      item.setAttribute('aria-hidden', 'true');
    });
    return () => {
      background.forEach((item,index) => {
        item.inert = false;
        const previous = previousHidden[index];
        if (previous === null) item.removeAttribute('aria-hidden');
        else item.setAttribute('aria-hidden', previous);
      });
      requestAnimationFrame(() => {
        if (document.activeElement === document.body && restoredTrigger?.isConnected) restoredTrigger.focus();
      });
    };
  }, [isOpen]);
  const close = () => {
    ai.cancel(); setPreview(null); setModalError(''); setIsOpen(false);
  };
  const open = () => {
    if (disabled || isOpen) return;
    trigger.current?.focus();
    localEdits.current.clear(); localExcluded.current.clear();
    setNotice(''); setModalError(''); setPreview(null); setStage('options'); setIsOpen(true);
  };
  const moveStage = (next:'options'|'review') => {
    setStage(next);
    requestAnimationFrame(()=>step.current?.focus());
  };
  const apply = (ids: string[]) => {
    if (!preview || disabled) return;
    try {
      const next = applyPromptPreview(preview, value, ids);
      setHistory({original:value, applied:next}); onChange(next); close();
      setNotice('입력칸에 적용했습니다. 아직 저장·실행하지 않았습니다.');
    } catch (error) { setModalError(error instanceof Error ? error.message : '적용하지 못했습니다.'); }
  };
  const isAi = mode === 'ai';
  const hasAi = Boolean(aiProvider && selectedModel);
  const workbench = isOpen && createPortal(
    <div ref={layer} data-prompt-refinement>
      <DialogSkeleton title="프롬프트 다듬기" dialogId={id} onClose={close}
        width="620px" className="kv2-dialog--refinement" overlayClassName="kv2-dialog-overlay--refinement">
        <div className="kv2-refine-scroll">
          <p ref={step} tabIndex={-1} className="kv2-refine-kicker">
            {stage==='review'?'2 · 제안 검토':'1 · 다듬기 설정'}
          </p>
          {stage==='options' ? <>
            <p className="kv2-prompt-refinement-hint">원문은 그대로 둡니다. 적용해도 카드를 저장하거나 실행하지 않습니다.</p>
            <fieldset className="kv2-refine-mode"><legend>다듬기 방식</legend>
              <label><input type="radio" name={id+'-mode'} checked={!isAi} disabled={disabled}
                onChange={()=>{ai.cancel();setMode('local');}} /> 로컬 템플릿</label>
              <label><input type="radio" name={id+'-mode'} checked={isAi} disabled={disabled || !hasAi}
                onChange={()=>setMode('ai')} /> AI 맞춤</label>
            </fieldset>
            {isAi && aiProvider ? <>
              <PromptModelPicker provider={aiProvider.provider} models={models} selected={selectedModel}
                defaultModel={aiProvider.model} disabled={disabled || ai.loading} onSelect={setModel}/>
              <p className="kv2-prompt-refinement-hint">카드 실행 모델과 별개입니다. 제안 생성을 누를 때만 원문과 선택 입력값이 모델에 전송됩니다. {aiProvider.provider === 'Codex CLI' ? 'Mac의 Codex로 실행하지만 원문은 OpenAI로 전송되며 구독 한도와 데이터 정책이 적용될 수 있습니다.' : 'API 사용료와 제공자 데이터 정책이 적용될 수 있습니다.'}</p>
            </> : <p className="kv2-prompt-refinement-hint">{hasAi?'로컬 템플릿에서는 외부로 보내지 않습니다.':'연결된 다듬기 모델이 없습니다. 로컬 템플릿은 외부 전송 없이 사용할 수 있습니다.'}</p>}
            <div className="kv2-refine-loop">
              <label className="kv2-prompt-refinement-loop"><input type="checkbox" checked={loopOn} disabled={disabled || ai.loading}
                aria-controls={id+'-loop'} onChange={event=>setLoopOn(event.target.checked)}/> 완료 조건까지 반복</label>
              <p className="kv2-prompt-refinement-hint">반복 지시를 프롬프트에 추가합니다. 반복을 직접 실행하지는 않습니다.</p>
              {loopOn && <div id={id+'-loop'} className="kv2-prompt-refinement-loop-fields">
                <label className="kv2-prompt-refinement-field">목표 (선택)
                  <input className="kv2-input" value={goal} maxLength={2000} disabled={disabled || ai.loading}
                    placeholder="비워 두면 확인 필요" onChange={event=>setGoal(event.target.value)}/></label>
                <label className="kv2-prompt-refinement-field">완료 조건 (선택, 줄마다 하나)
                  <textarea className="kv2-textarea" rows={2} value={doneWhen} maxLength={2000} disabled={disabled || ai.loading}
                    placeholder="비워 두면 확인 필요" onChange={event=>setDoneWhen(event.target.value)}/></label>
                <label className="kv2-prompt-refinement-field kv2-prompt-refinement-rounds">반복 한도 (회)
                  <input className="kv2-input" type="number" min={LOOP_ROUNDS.min} max={LOOP_ROUNDS.max} step={1}
                    value={maxRounds} disabled={disabled || ai.loading} onChange={event=>setMaxRounds(normalizeRounds(Number(event.target.value)))}/></label>
              </div>}
            </div>
            {!value.trim() && <p className="kv2-prompt-refinement-hint">먼저 입력칸에 요청을 작성해 주세요.</p>}
          </> : <>
            <p className="kv2-prompt-refinement-hint">{isAi?`${aiProvider?.provider} / ${selectedModel} · 제안, 사실 확인 필요`:'로컬 템플릿 · 외부 전송 없음'}</p>
            <details className="kv2-refine-original"><summary>변경 전 원문</summary><pre>{preview?.source ?? value}</pre></details>
            <div className="kv2-refine-review-header"><strong>적용할 제안</strong><span>{selected.length}개 선택</span></div>
            {preview?.sections.map((section,index)=><div key={section.id} className="kv2-refine-proposal" data-selected={selected.includes(section.id)}>
              <input type="checkbox" checked={selected.includes(section.id)} disabled={readOnly}
                aria-label={section.title} onChange={event=>{
                  const checked=event.target.checked;
                  if(!isAi){if(checked)localExcluded.current.delete(section.id);else localExcluded.current.add(section.id);}
                  setSelected(ids=>checked?[...ids,section.id]:ids.filter(item=>item!==section.id));
                }}/>
              <details open={index===0?true:undefined}>
                <summary>{section.title}</summary>
                <div className="kv2-refine-proposal-body">
                  <textarea className="kv2-textarea" aria-label={section.title} value={section.body} rows={3} disabled={readOnly}
                    onChange={event=>{
                      const body=event.target.value;
                      if(!isAi)localEdits.current.set(section.id,body);
                      setPreview({...preview,sections:preview.sections.map(s=>s.id===section.id?{...s,body}:s)});
                    }}/>
                </div>
              </details>
            </div>)}
            <p className="kv2-prompt-refinement-hint">선택한 제안은 원문 아래에 추가됩니다.</p>
          </>}
          {modalError && <p role="alert" className="kv2-refine-error">{modalError}</p>}
          {history && value!==history.applied && <details><summary>적용 전 원문 보기 · 복사</summary><pre>{history.original}</pre></details>}
          {stale && <p role="alert" className="kv2-refine-error">원문이 변경되었습니다. 창을 닫고 다시 열어 주세요.</p>}
        </div>
        <footer className="kv2-refine-footer kv2-actions-split">
          <button type="button" className="kv2-btn kv2-btn--ghost kv2-action-cancel" onClick={close}>취소</button>
          <div className="kv2-actions-primary">{stage==='review' ? <>
            <button type="button" className="kv2-btn kv2-btn--ghost" onClick={()=>moveStage('options')}>설정으로</button>
            <button type="button" className="kv2-btn kv2-btn--primary" disabled={readOnly || !selected.length || !preview}
              onClick={()=>apply(selected)}>선택 적용 ({selected.length})</button>
          </> : isAi
            ? <button type="button" className="kv2-btn kv2-btn--primary" disabled={disabled || !hasAi || !value.trim() || ai.loading}
              onClick={async()=>{
                setModalError('');
                try { const result=await ai.generate();if(result){setResult(result);moveStage('review');} }
                catch { setModalError('AI 제안을 받지 못했습니다. 원문은 변경하지 않았습니다.'); }
              }}>{ai.loading?'제안 생성 중…':`AI 제안 생성 · ${aiProvider?.provider} / ${selectedModel}`}</button>
            : <button type="button" className="kv2-btn kv2-btn--primary" disabled={readOnly || !preview}
              onClick={()=>moveStage('review')}>제안 검토</button>}</div>
        </footer>
      </DialogSkeleton>
    </div>, document.body);
  return <div className="kv2-prompt-refinement" data-prompt-refinement>
    <button ref={trigger} type="button" className="kv2-prompt-refinement-link" disabled={disabled}
      aria-haspopup="dialog" aria-expanded={isOpen} aria-controls={isOpen ? id : undefined} onClick={open}>프롬프트 다듬기</button>
    {history && <button type="button" className="kv2-prompt-refinement-link" disabled={disabled}
      onClick={()=>{
        try {onChange(undoPromptApplication(value,history.applied,history.original));setHistory(null);setNotice('적용 전 원문으로 되돌렸습니다.');trigger.current?.focus();}
        catch(error){open();setModalError(error instanceof Error?error.message:'되돌리지 못했습니다.');}
      }}>되돌리기</button>}
    <span className="kv2-prompt-refinement-status" role="status">{notice}</span>
    {workbench}
  </div>;
}
