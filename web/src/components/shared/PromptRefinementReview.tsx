import { useId, useMemo, useState } from 'react';
import type { PromptProposalKind, PromptSlot } from '../../../../src/core/prompt-proposal';
import { PROMPT_SLOTS } from '../../../../src/core/prompt-proposal';
import {
  isBlocked, KIND_LABELS, sectionText, SLOT_LABELS, type RefinementPreview, type RefinementSection,
} from '../../utils/prompt-refinement';

type Patch = Partial<Pick<RefinementSection, 'body' | 'choice' | 'answer'>>;
interface Props {
  preview: RefinementPreview;
  selected: string[];
  readOnly: boolean;
  /** One line under the panes: which source produced these proposals (model or local frame). */
  sourceLabel: string;
  onInclude: (id: string, include: boolean) => void;
  onPatch: (id: string, patch: Patch) => void;
}
type Filter = 'all' | PromptProposalKind;
type Tab = 'source' | 'suggest' | 'result';
const KIND_ORDER: PromptProposalKind[] = ['decision', 'question', 'suggestion', 'extracted'];

/** Exact, non-overlapping occurrences of quoted (extracted) sections inside the source. */
function highlights(source: string, sections: RefinementSection[]): { text: string; mark: boolean }[] {
  const ranges: [number, number][] = [];
  for (const s of sections) {
    if (s.kind !== 'extracted' || !s.body.trim()) continue;
    const at = source.indexOf(s.body);
    if (at >= 0 && !ranges.some(([a, b]) => at < b && at + s.body.length > a)) ranges.push([at, at + s.body.length]);
  }
  ranges.sort((a, b) => a[0] - b[0]);
  const parts: { text: string; mark: boolean }[] = [];
  let cursor = 0;
  for (const [a, b] of ranges) {
    if (a > cursor) parts.push({ text: source.slice(cursor, a), mark: false });
    parts.push({ text: source.slice(a, b), mark: true });
    cursor = b;
  }
  if (cursor < source.length) parts.push({ text: source.slice(cursor), mark: false });
  return parts;
}

/**
 * Split review: left = original + exactly what will be appended, right = proposals grouped by
 * slot with a "what do I need to do" filter. Narrow containers switch to 원문/제안/결과 tabs.
 * Nothing here is sent anywhere; choices/answers are user input merged into the applied text.
 */
export function PromptRefinementReview({ preview, selected, readOnly, sourceLabel, onInclude, onPatch }: Props) {
  const id = useId();
  const [filter, setFilter] = useState<Filter>('all');
  const [tab, setTab] = useState<Tab>('suggest');
  const [editing, setEditing] = useState<Set<string>>(new Set());
  const sections = preview.sections;
  const kindOf = (s: RefinementSection): PromptProposalKind => s.kind ?? 'suggestion';
  const counts = useMemo(() => ({
    decision: sections.filter(isBlocked).length,
    question: sections.filter(s => kindOf(s) === 'question').length,
    suggestion: sections.filter(s => kindOf(s) === 'suggestion').length,
    extracted: sections.filter(s => kindOf(s) === 'extracted').length,
  }), [sections]);
  const included = sections.filter(s => selected.includes(s.id) && !isBlocked(s));
  const visible = sections.filter(s => filter === 'all' || kindOf(s) === filter);
  const groups = (PROMPT_SLOTS as readonly PromptSlot[])
    .map(slot => ({ slot, items: visible.filter(s => (s.slot ?? 'other') === slot) }))
    .filter(g => g.items.length);
  const parts = highlights(preview.source, sections);
  const toggleEdit = (sid: string) => setEditing(prev => {
    const next = new Set(prev); if (next.has(sid)) next.delete(sid); else next.add(sid); return next;
  });

  return <div className="kv2-refine-split" data-tab={tab}>
    <div className="kv2-refine-tabs" role="tablist" aria-label="다듬기 보기">
      {([['source', '원문'], ['suggest', '제안'], ['result', '결과']] as const).map(([key, label]) =>
        <button key={key} type="button" role="tab" id={`${id}-tab-${key}`} aria-selected={tab === key}
          aria-controls={`${id}-pane-${key}`} onClick={() => setTab(key)}>
          {label}{key === 'suggest' && counts.decision ? <span className="kv2-refine-badge" data-kind="decision"> {counts.decision}</span> : null}
        </button>)}
    </div>

    <section className="kv2-refine-pane kv2-refine-pane--source" id={`${id}-pane-source`} aria-label="원문">
      <h3 className="kv2-refine-pane-title">원문 <small>그대로 유지 · 아래에 덧붙임</small></h3>
      <pre className="kv2-refine-source" data-testid="refine-source">{parts.map((p, i) =>
        p.mark ? <mark key={i}>{p.text}</mark> : <span key={i}>{p.text}</span>)}</pre>
    </section>

    <section className="kv2-refine-pane kv2-refine-pane--result" id={`${id}-pane-result`} aria-label="적용될 결과">
      <h3 className="kv2-refine-pane-title">본문에 추가될 섹션 <small>{included.length}개</small></h3>
      {included.length
        ? <pre className="kv2-refine-result" data-testid="refine-result">{included.map(sectionText).join('\n\n')}</pre>
        : <p className="kv2-prompt-refinement-hint">아직 넣은 제안이 없습니다. ‘본문에 넣기’를 누르세요.</p>}
    </section>

    <section className="kv2-refine-pane kv2-refine-pane--suggest" id={`${id}-pane-suggest`} aria-label="제안">
      <div className="kv2-refine-triage" role="group" aria-label="제안 분류">
        <button type="button" aria-pressed={filter === 'all'} onClick={() => setFilter('all')}>전체 <b>{sections.length}</b></button>
        {KIND_ORDER.map(kind => <button key={kind} type="button" data-kind={kind} aria-pressed={filter === kind}
          onClick={() => setFilter(kind)}>{KIND_LABELS[kind]} <b>{counts[kind as keyof typeof counts]}</b></button>)}
      </div>
      <p className="kv2-prompt-refinement-hint" data-testid="refine-review-source">{sourceLabel}</p>
      {groups.length ? groups.map(group => <div key={group.slot} className="kv2-refine-group">
        <h4 className="kv2-refine-group-title">{SLOT_LABELS[group.slot]}</h4>
        {group.items.map(section => {
          const kind = kindOf(section);
          const isIn = selected.includes(section.id) && !isBlocked(section);
          const isEditing = editing.has(section.id);
          return <article key={section.id} className="kv2-refine-card" data-kind={kind} data-in={isIn}
            aria-label={section.title}>
            <header>
              <span className="kv2-refine-badge" data-kind={kind}>{kind === 'decision' && !section.choice ? '결정 필요' : KIND_LABELS[kind]}</span>
              <strong>{section.title}</strong>
            </header>
            {isEditing
              ? <textarea className="kv2-textarea" aria-label={section.title} value={section.body} rows={4} disabled={readOnly}
                  onChange={event => onPatch(section.id, { body: event.target.value })}/>
              : <p className="kv2-refine-card-body">{section.body}</p>}
            {kind === 'decision' && section.options?.length ? <div className="kv2-refine-options" role="radiogroup" aria-label={`${section.title} 선택지`}>
              {section.options.map(option => <label key={option} data-on={section.choice === option}>
                <input type="radio" name={`${id}-${section.id}`} checked={section.choice === option} disabled={readOnly}
                  onChange={() => { onPatch(section.id, { choice: option }); onInclude(section.id, true); }}/>{option}
              </label>)}
            </div> : null}
            {kind === 'question' && <input className="kv2-input kv2-refine-answer" aria-label={`${section.title} 답변`}
              placeholder="답변 (비우면 ‘확인 필요’ 그대로)" value={section.answer ?? ''} disabled={readOnly} maxLength={2000}
              onChange={event => onPatch(section.id, { answer: event.target.value })}/>}
            <footer>
              <button type="button" className={'kv2-btn kv2-btn--small ' + (isIn ? 'kv2-btn--ghost' : 'kv2-btn--outline')}
                aria-label={`${section.title}: ${isIn ? '본문에서 빼기' : '본문에 넣기'}`} aria-pressed={isIn}
                disabled={readOnly || isBlocked(section)} onClick={() => onInclude(section.id, !isIn)}>
                {isIn ? '본문에서 빼기' : '본문에 넣기'}</button>
              <button type="button" className="kv2-btn kv2-btn--ghost kv2-btn--small" disabled={readOnly}
                aria-label={`${section.title}: ${isEditing ? '편집 완료' : '편집'}`} onClick={() => toggleEdit(section.id)}>
                {isEditing ? '편집 완료' : '편집'}</button>
              <span className="kv2-refine-card-state">{isBlocked(section) ? '선택지를 고르면 넣을 수 있음' : isIn ? '본문에 들어감' : '빠져 있음'}</span>
            </footer>
          </article>;
        })}
      </div>) : <p className="kv2-prompt-refinement-hint">이 분류에 해당하는 제안이 없습니다.</p>}
    </section>
  </div>;
}
