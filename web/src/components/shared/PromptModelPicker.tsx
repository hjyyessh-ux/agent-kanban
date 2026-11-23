import {useId,useRef,useState} from 'react';
import type {KeyboardEvent} from 'react';

interface Props {
  provider: string;
  models: readonly string[];
  selected: string;
  defaultModel?: string;
  onSelect: (model:string)=>void;
  disabled?: boolean;
}

export function PromptModelPicker({provider,models,selected,defaultModel,onSelect,disabled}:Props) {
  const id=useId();
  const trigger=useRef<HTMLButtonElement>(null);
  const list=useRef<HTMLDivElement>(null);
  const [open,setOpen]=useState(false);
  const options=()=>[...list.current?.querySelectorAll<HTMLButtonElement>('[role=option]')??[]];
  const focus=(n:number)=>{
    const available=options()[n];
    if(available) available.focus();
    else requestAnimationFrame(()=>options()[n]?.focus());
  };
  const close=()=>{setOpen(false);trigger.current?.focus();};
  const keydown=(event:KeyboardEvent<HTMLElement>)=>{
    if (event.key==='Escape' && open) {
      event.preventDefault();event.stopPropagation();close();return;
    }
    if (!['ArrowDown','ArrowUp','Home','End'].includes(event.key)) return;
    event.preventDefault();event.stopPropagation();
    const current=options().indexOf(document.activeElement as HTMLButtonElement);
    if (!open) setOpen(true);
    const fallback=Math.max(0,models.indexOf(selected));
    const target=event.key==='Home'?0:event.key==='End'?models.length-1:
      current<0?fallback:Math.max(0,Math.min(models.length-1,current+(event.key==='ArrowDown'?1:-1)));
    focus(target);
  };
  return <div className="kv2-refine-model-picker" onKeyDown={keydown} onBlur={event=>{
    if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
  }}>
    <span className="kv2-refine-field-label" id={id+'-label'}>다듬기 모델</span>
    <button type="button" className="kv2-refine-model-trigger" ref={trigger}
      aria-labelledby={id+'-label '+id+'-value'} aria-haspopup="listbox" aria-controls={id}
      aria-expanded={open} disabled={disabled || models.length===0}
      onClick={()=>{ if(open) close(); else {setOpen(true);focus(Math.max(0,models.indexOf(selected)));} }}>
      <span id={id+'-value'}>{selected?provider+' / '+selected:'연결된 모델 없음'}</span><span aria-hidden="true">{open?'▴':'▾'}</span>
    </button>
    {open && <div ref={list} id={id} role="listbox" aria-labelledby={id+'-label'} className="kv2-refine-model-options">
      {models.map(model=><button type="button" key={model} role="option" aria-selected={model===selected}
        onClick={()=>{onSelect(model);close();}}>
        <span>{provider} / {model}</span>{model===defaultModel && <small>기본</small>}
        {model===selected && <span aria-hidden="true">✓</span>}
      </button>)}
    </div>}
  </div>;
}
