import React, { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { PromptModelPicker } from './PromptModelPicker';
import { PromptRefinementReview } from './PromptRefinementReview';
import './PromptRefinement.css';
import { DialogSkeleton } from '../Card/DialogSkeleton';
import { serverProposer, PromptRefinementRequestError } from '../../hooks/usePromptProposalProvider';
import { formatModelRef, refinementErrorMessage, usePromptRefinementCatalog } from '../../hooks/usePromptRefinementCatalog';
import { usePromptProposal } from '../../hooks/usePromptProposal';
import { isSelectableModel, type PromptModelRef } from '../../../../src/core/prompt-proposal';
import {
  applyPromptPreview, isBlocked, LOOP_ROUNDS, normalizeRounds, previewLoopPrompt, previewPrompt, undoPromptApplication,
  type PromptLoopOptions, type RefinementPreview, type RefinementSection,
} from '../../utils/prompt-refinement';

export interface PromptRefinementProps { value: string; onChange: (value: string) => void; disabled?: boolean }
type RefinementMode = 'local' | 'ai';

/** A separate modal above the editor; only a selected proposal changes the draft. */
export function PromptRefinement({value, onChange, disabled}: PromptRefinementProps) {
  const id = useId();
  const layer = useRef<HTMLDivElement>(null);
  const step = useRef<HTMLParagraphElement>(null);
  const [stage,setStage] = useState<'options' | 'review'>('options');
  const trigger = useRef<HTMLButtonElement>(null);
  // User edits/selection belong to this local draft, not to the latest generated
  // template. Refreshing goal/limits must not silently discard them.
  const localEdits = useRef(new Map<string,Partial<Pick<RefinementSection,'body'|'choice'|'answer'>>>());
  const localExcluded = useRef(new Set<string>());
  const [isOpen,setIsOpen] = useState(false);
  // Catalog is (re)loaded only while the modal is open; GET never calls a model.
  const refinement = usePromptRefinementCatalog(isOpen);
  const {catalog} = refinement;
  const [mode,setMode] = useState<RefinementMode>('local');
  // `choice` is this modal session's pick only. It is never persisted; the saved
  // default changes only from Settings with an explicit save.
  const [choice,setChoice] = useState<PromptModelRef | null>(null);
  const [loopOn,setLoopOn] = useState(false);
  const [goal,setGoal] = useState('');
  const [doneWhen,setDoneWhen] = useState('');
  const [maxRounds,setMaxRounds] = useState<number>(LOOP_ROUNDS.default);
  const startRef = catalog?.effectiveDefault ?? null;
  const choiceValid = isSelectableModel(catalog, choice);
  const selectedRef: PromptModelRef | null = choiceValid ? choice : startRef;
  const selectedKey = selectedRef ? selectedRef.provider + '\u0000' + selectedRef.model : '';
  const proposer = useMemo(() => selectedRef ? serverProposer(selectedRef) : undefined,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [selectedKey]);
  const selectedProvider = catalog?.providers.find(p => p.provider === selectedRef?.provider);
  const loop: PromptLoopOptions | undefined = useMemo(
    () => loopOn ? {goal, doneWhen, maxRounds: normalizeRounds(maxRounds)} : undefined, [loopOn, goal, doneWhen, maxRounds]);
  const ai = usePromptProposal(value, proposer, {model: selectedRef?.model ?? '', loop});
  const [preview,setPreview] = useState<RefinementPreview | null>(null);
  const [selected,setSelected] = useState<string[]>([]);
  const [history,setHistory] = useState<{original:string; applied:string} | null>(null);
  const [notice,setNotice] = useState('');
  const [modalError,setModalError] = useState('');
  type Session = {source:string; stage:'options'|'review'; preview:RefinementPreview|null; selected:string[]};
  const sessionRef = useRef<Session | null>(null);
  const restoreRef = useRef<{preview:RefinementPreview; selected:string[]} | null>(null);
  const [resumed,setResumed] = useState(false);
  const stale = preview !== null && preview.source !== value;
  const readOnly = disabled || stale;
  const setResult = (result: RefinementPreview) => {
    // Decisions start out of the draft until the user picks an option.
    setPreview(result); setSelected(result.sections.filter(s => !isBlocked(s)).map(s => s.id));
  };
  // Local template follows option changes instantly (no network). AI results are dropped on any
  // option change so an older reply can never stand for the new settings.
  useEffect(() => {
    if (!isOpen) return;
    // Reopening over the same source restores the previous session (incl. an AI result) once.
    const restored = restoreRef.current; restoreRef.current = null;
    if (restored) { setPreview(restored.preview); setSelected(restored.selected); return; }
    if (mode === 'ai') { setPreview(null); setSelected([]); return; }
    if (!value.trim()) { setPreview(null); return; }
    try {
      const next=loop ? previewLoopPrompt(value, loop) : previewPrompt(value);
      const merged={...next,sections:next.sections.map(section=>({...section,...localEdits.current.get(section.id)}))};
      setPreview(merged);
      setSelected(merged.sections.filter(section=>!isBlocked(section)).map(section=>section.id)
        .filter(sectionId=>!localExcluded.current.has(sectionId)));
      setModalError('');
    }
    catch (error) { setPreview(null); setModalError(error instanceof Error ? error.message : '미리보기를 만들지 못했습니다.'); }
    // `value` is deliberately not a dependency: an outside edit marks the preview stale instead of rebuilding it.
  }, [isOpen, mode, loop, selectedKey]);
  // A model that stops being available (catalog reload) can never stay selected.
  useEffect(() => { if (mode === 'ai' && !selectedRef) setMode('local'); }, [mode, selectedRef]);
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
  // Closing (×, Escape, 취소) keeps this session: mode, model choice, loop fields, local edits,
  // deselections and the reviewed proposal. It is restored only while the source text is unchanged.
  const close = (keep = true) => {
    ai.cancel();
    sessionRef.current = keep && preview ? {source:value, stage, preview, selected} : keep ? {source:value, stage:'options', preview:null, selected:[]} : null;
    setPreview(null); setModalError(''); setIsOpen(false);
  };
  /** `full` (the "새로 시작" button) also resets mode and loop fields; after apply / a changed source they are kept. */
  const resetSession = (full = false) => {
    localEdits.current.clear(); localExcluded.current.clear(); sessionRef.current = null; restoreRef.current = null;
    setChoice(null); // a fresh session starts from the saved/server default
    if (full) { setMode('local'); setLoopOn(false); setGoal(''); setDoneWhen(''); setMaxRounds(LOOP_ROUNDS.default); }
    setModalError(''); setPreview(null); setSelected([]); setStage('options');
  };
  const open = () => {
    if (disabled || isOpen) return;
    trigger.current?.focus();
    const saved = sessionRef.current;
    setNotice(''); setModalError('');
    if (saved && saved.source === value) {
      restoreRef.current = saved.preview && saved.preview.source === value ? {preview:saved.preview, selected:saved.selected} : null;
      setStage(restoreRef.current ? saved.stage : 'options'); setResumed(true);
    } else { resetSession(); setResumed(false); }
    setIsOpen(true);
  };
  const moveStage = (next:'options'|'review') => {
    setStage(next);
    requestAnimationFrame(()=>step.current?.focus());
  };
  const applicable = preview ? preview.sections.filter(s => selected.includes(s.id) && !isBlocked(s)).map(s => s.id) : [];
  const pendingDecisions = preview ? preview.sections.filter(isBlocked).length : 0;
  const apply = (ids: string[]) => {
    if (!preview || disabled) return;
    try {
      const next = applyPromptPreview(preview, value, ids);
      setHistory({original:value, applied:next}); onChange(next); close(false); resetSession();
      setNotice('입력칸에 적용했습니다. 아직 저장·실행하지 않았습니다. ‘되돌리기’로 적용 전 원문으로 돌아갑니다.');
    } catch (error) { setModalError(error instanceof Error ? error.message : '적용하지 못했습니다.'); }
  };
  const isAi = mode === 'ai';
  const hasAi = Boolean(selectedRef);
  const noAiReason = refinement.status === 'loading' && !catalog ? '다듬기 모델 연결 상태를 확인하는 중입니다.'
    : refinement.status === 'error' ? '다듬기 모델 상태를 불러오지 못했습니다. 설정 › 다듬기 모델에서 확인하세요.'
    : '선택 가능한 다듬기 모델이 없습니다. 아래 ‘모델 연결 상태’에서 이유와 설정 위치를 확인하세요.';
  const generate = async () => {
    setModalError('');
    try { const result=await ai.generate();if(result){setResult(result);moveStage('review');} }
    catch (error) {
      const code = error instanceof PromptRefinementRequestError ? error.code : 'proposal_unavailable';
      if (['provider_changed','model_not_allowed','provider_not_ready'].includes(code)) refinement.reload();
      setModalError(refinementErrorMessage(code) + ' 원문은 변경하지 않았습니다.');
    }
  };
  const workbench = isOpen && createPortal(
    <div ref={layer} data-prompt-refinement>
      <DialogSkeleton title="프롬프트 다듬기" dialogId={id} onClose={()=>close()} closeOnBackdrop={false}
        persistSizeKey="kanban-dialog-size-refinement" defaultSize={{width:1120,height:780}}
        width="620px" className="kv2-dialog--refinement" overlayClassName="kv2-dialog-overlay--refinement">
        <div className="kv2-refine-scroll" data-stage={stage}>
          <p ref={step} tabIndex={-1} className="kv2-refine-kicker">
            {stage==='review'?'2 · 제안 검토':'1 · 다듬기 설정'}
          </p>
          {resumed && <p className="kv2-refine-resumed" role="status">
            이전 작업을 이어서 표시합니다. 창 밖 클릭으로는 닫히지 않으며, 닫아도 원문이 같으면 유지됩니다.{' '}
            <button type="button" className="kv2-prompt-refinement-link" disabled={ai.loading}
              onClick={()=>{resetSession(true);setResumed(false);}}>새로 시작</button></p>}
          {stage==='options' ? <>
            <p className="kv2-prompt-refinement-hint">원문은 그대로 둡니다. 적용해도 카드를 저장하거나 실행하지 않습니다.</p>
            <fieldset className="kv2-refine-mode"><legend>다듬기 방식</legend>
              <label><input type="radio" name={id+'-mode'} checked={!isAi} disabled={disabled}
                onChange={()=>{ai.cancel();setMode('local');}} /> 기본 틀 추가 · AI 호출 없음</label>
              <label><input type="radio" name={id+'-mode'} checked={isAi} disabled={disabled || !hasAi}
                onChange={()=>setMode('ai')} /> AI 맞춤 제안 · 모델 호출</label>
            </fieldset>
            {isAi && catalog && selectedRef ? <>
              <PromptModelPicker catalog={catalog} selected={selectedRef} defaultRef={startRef}
                disabled={disabled || ai.loading} onSelect={setChoice}/>
              <p className="kv2-prompt-refinement-hint" data-testid="refine-choice-scope">
                {choice && choiceValid && startRef && (choice.provider!==startRef.provider || choice.model!==startRef.model)
                  ? `이번 생성에만 ${formatModelRef(choice)}을(를) 씁니다. 기본값(${formatModelRef(startRef)})은 바뀌지 않습니다.`
                  : `기본값 ${formatModelRef(startRef)}으로 시작합니다. 여기서 바꾸면 이번 생성에만 적용됩니다.`}
                {' '}기본값은 설정 › 다듬기 모델에서 저장합니다. 카드 실행 모델(Model Visibility)과 별개입니다.</p>
              <p className="kv2-prompt-refinement-hint">‘AI 제안 생성’을 누를 때만 원문과 선택 입력값이 {selectedRef.provider}로 1회 전송됩니다. {selectedProvider?.billing}</p>
              {choice && !choiceValid && <p role="status" className="kv2-prompt-refinement-hint">이번에 고른 모델을 지금 쓸 수 없어 기본값으로 돌아갔습니다.</p>}
            </> : <>
              {!hasAi && <p className="kv2-prompt-refinement-hint">{noAiReason}</p>}
              <div className="kv2-refine-local-info" role="note" aria-label="기본 틀 안내">
                <p><strong>기본 틀 추가 · AI 호출 없음 · 네트워크 전송 없음</strong></p>
                <p>코드에 정해 둔 목표·맥락·실행 계획·검증 틀을 원문 아래에 덧붙입니다. 원문을 분석하거나 AI로 추론하지 않습니다.</p>
                <ul>
                  <li>예: <code>## 목표 · 완료 조건 (제안)</code> 아래에 “위 원문의 요구를 충족하는 결과물을 만든다…” 같은 고정 문장</li>
                  <li>편집 범위: 다음 단계에서 항목별 본문을 고치거나 선택을 해제할 수 있습니다. 원문은 바뀌지 않습니다.</li>
                  <li>반복 옵션의 목표·완료 조건은 입력한 값만 그대로 넣고, 비우면 ‘확인 필요’로 남깁니다. 금지·제외 문장은 정해진 표현(금지, 하지 않는다 등)이 있는 원문 문장만 그대로 인용합니다.</li>
                  <li>적용 후 ‘되돌리기’로 적용 직전 원문으로 정확히 돌아갑니다. 적용 뒤 직접 고친 경우에는 자동으로 되돌리지 않습니다.</li>
                </ul>
              </div>
            </>}
            {catalog && <details className="kv2-refine-status">
              <summary>모델 연결 상태 (선택 가능 {catalog.providers.reduce((n,p)=>n+p.models.filter(m=>m.selectable).length,0)}개)</summary>
              <ul>{catalog.providers.map(p=><li key={p.provider}><strong>{p.provider}</strong> — {p.summary}
                {!p.ready && <small> · 설정 위치: {p.settingsHint}</small>}</li>)}</ul>
            </details>}
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
            {preview && <PromptRefinementReview preview={preview} selected={selected} readOnly={readOnly}
              sourceLabel={isAi?`${formatModelRef(selectedRef)} · 이번 생성만 · AI 제안은 사실 확인 필요`:'기본 틀 · AI 호출 없음 · 네트워크 전송 없음 · 넣기/빼기·편집 가능'}
              onInclude={(sectionId,include)=>{
                if(!isAi){if(include)localExcluded.current.delete(sectionId);else localExcluded.current.add(sectionId);}
                setSelected(ids=>include?[...new Set([...ids,sectionId])]:ids.filter(item=>item!==sectionId));
              }}
              onPatch={(sectionId,patch)=>{
                if(!isAi)localEdits.current.set(sectionId,{...localEdits.current.get(sectionId),...patch});
                setPreview(current=>current&&{...current,sections:current.sections.map(s=>s.id===sectionId?{...s,...patch}:s)});
              }}/>}
          </>}
          {modalError && <p role="alert" className="kv2-refine-error">{modalError}</p>}
          {history && value!==history.applied && <details><summary>적용 전 원문 보기 · 복사</summary><pre>{history.original}</pre></details>}
          {stale && <p role="alert" className="kv2-refine-error">원문이 변경되었습니다. 창을 닫고 다시 열어 주세요.</p>}
        </div>
        <footer className="kv2-refine-footer kv2-actions-split">
          <button type="button" className="kv2-btn kv2-btn--ghost kv2-action-cancel" onClick={()=>close()}>닫기 · 작업 유지</button>
          <div className="kv2-actions-primary">{stage==='review' ? <>
            <button type="button" className="kv2-btn kv2-btn--ghost" onClick={()=>moveStage('options')}>설정으로</button>
            {pendingDecisions>0 && <span className="kv2-refine-pending" role="status">결정 필요 {pendingDecisions}개는 빼고 적용됩니다</span>}
            <button type="button" className="kv2-btn kv2-btn--primary" disabled={readOnly || !applicable.length || !preview}
              onClick={()=>apply(applicable)}>본문에 적용 ({applicable.length})</button>
          </> : isAi
            ? <button type="button" className="kv2-btn kv2-btn--primary" disabled={disabled || !hasAi || !value.trim() || ai.loading}
              onClick={()=>void generate()}>{ai.loading?'제안 생성 중…':`AI 제안 생성 · ${formatModelRef(selectedRef)}`}</button>
            : <button type="button" className="kv2-btn kv2-btn--primary" disabled={readOnly || !preview}
              onClick={()=>moveStage('review')}>기본 틀 미리보기</button>}</div>
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
