import {useId,useRef,useState} from 'react';
import type {KeyboardEvent} from 'react';
import {sameModelRef,type PromptModelRef,type PromptRefinementCatalog} from '../../../../src/core/prompt-proposal';

interface Props {
  catalog: PromptRefinementCatalog;
  selected: PromptModelRef | null;
  /** The saved/server default shown as "기본". */
  defaultRef?: PromptModelRef | null;
  onSelect: (ref:PromptModelRef)=>void;
  disabled?: boolean;
}

/**
 * Every catalog entry is listed, grouped by provider. Entries the server does not
 * allow stay visible with `aria-disabled`, their reason and where to change it;
 * they can be focused/read but never chosen.
 */
export function PromptModelPicker({catalog,selected,defaultRef,onSelect,disabled}:Props) {
  const id=useId();
  const trigger=useRef<HTMLButtonElement>(null);
  const list=useRef<HTMLDivElement>(null);
  const [open,setOpen]=useState(false);
  const total=catalog.providers.reduce((n,p)=>n+p.models.length,0);
  const options=()=>[...list.current?.querySelectorAll<HTMLButtonElement>('[role=option]')??[]];
  const focus=(pick:(all:HTMLButtonElement[])=>HTMLButtonElement|undefined)=>{
    const run=()=>{const all=options();(pick(all)??all[0])?.focus();};
    if(options().length) run(); else requestAnimationFrame(run);
  };
  const focusSelected=()=>focus(all=>all.find(o=>o.getAttribute('aria-selected')==='true'));
  const close=()=>{setOpen(false);trigger.current?.focus();};
  const keydown=(event:KeyboardEvent<HTMLElement>)=>{
    if (event.key==='Escape' && open) {
      event.preventDefault();event.stopPropagation();close();return;
    }
    if (!['ArrowDown','ArrowUp','Home','End'].includes(event.key)) return;
    event.preventDefault();event.stopPropagation();
    if (!open) { setOpen(true); focusSelected(); return; }
    focus(all=>{
      const current=all.indexOf(document.activeElement as HTMLButtonElement);
      const n=event.key==='Home'?0:event.key==='End'?all.length-1:
        current<0?0:Math.max(0,Math.min(all.length-1,current+(event.key==='ArrowDown'?1:-1)));
      return all[n];
    });
  };
  return <div className="kv2-refine-model-picker" onKeyDown={keydown} onBlur={event=>{
    if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
  }}>
    <span className="kv2-refine-field-label" id={id+'-label'}>다듬기 모델 · 이번 생성에만 적용</span>
    <button type="button" className="kv2-refine-model-trigger" ref={trigger}
      aria-labelledby={id+'-label '+id+'-value'} aria-haspopup="listbox" aria-controls={id}
      aria-expanded={open} disabled={disabled || total===0}
      onClick={()=>{ if(open) close(); else {setOpen(true);focusSelected();} }}>
      <span id={id+'-value'}>{selected?selected.provider+' / '+selected.model:'선택 가능한 모델 없음'}</span><span aria-hidden="true">{open?'▴':'▾'}</span>
    </button>
    {open && <div ref={list} id={id} role="listbox" aria-labelledby={id+'-label'} className="kv2-refine-model-options">
      {catalog.providers.filter(p=>p.models.length).map(group=><div key={group.provider} role="group"
        aria-label={group.provider} className="kv2-refine-model-group">
        <div className="kv2-refine-model-group-head" aria-hidden="true">
          <strong>{group.provider}</strong><span>{group.summary}</span>
        </div>
        {group.models.map(model=>{
          const ref={provider:group.provider,model:model.id};
          const isSelected=sameModelRef(ref,selected);
          return <button type="button" key={model.id} role="option" aria-selected={isSelected}
            aria-disabled={!model.selectable || undefined} data-provider={group.provider} data-model={model.id}
            onClick={()=>{ if(model.selectable){onSelect(ref);close();} }}>
            <span className="kv2-refine-model-name">
              <span>{group.provider} / {model.id}</span>
              {sameModelRef(ref,defaultRef) && <small>기본</small>}
              {!model.selectable && <small className="kv2-refine-model-off">선택 불가</small>}
              {isSelected && <span aria-hidden="true">✓</span>}
            </span>
            {!model.selectable && <small className="kv2-refine-model-reason">
              {model.reason}{model.settingsHint ? ' · 설정 위치: '+model.settingsHint : ''}
            </small>}
          </button>;
        })}
      </div>)}
    </div>}
  </div>;
}
