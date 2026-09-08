import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { WorksConfigDto } from '../../../../src/core/types';
import { CLAUDE_MODELS, CODEX_MODELS } from '../../../../src/core/runtime-config';
import { WorksConfigPanel, formOf, resyncForm, sameForm } from './WorksConfigPanel';

function config(overrides: Partial<WorksConfigDto> = {}): WorksConfigDto {
  return {
    summaryModel: 'claude-sonnet-5',
    summaryLines: 3,
    assignPreferSameDir: true,
    assignSuggestResumeChain: true,
    doneConfirm: true,
    staleDays: 5,
    route: 'claude',
    ...overrides,
  } as WorksConfigDto;
}

function markup(dto: WorksConfigDto = config()): string {
  return renderToStaticMarkup(
    <WorksConfigPanel config={dto} busy={false} onSave={async () => {}} />,
  );
}

describe('resyncForm', () => {
  const base = formOf(config());

  test('a clean form takes the newly arrived config', () => {
    const next = formOf(config({ staleDays: 10 }));
    expect(resyncForm(base, base, next)).toEqual(next);
  });

  test('a dirty form keeps its edits when the poll delivers a new config object', () => {
    // The Works tab polls every 10s and hands over a *fresh* WorksConfigDto
    // each time. The old `useEffect([config]) → setState(config)` therefore
    // reset the whole form on a timer, mid-edit.
    const edited = { ...base, summaryLines: 5, preferSameDir: false };
    const unchangedButNew = formOf(config());
    expect(resyncForm(edited, base, unchangedButNew)).toEqual(edited);
  });

  test('a dirty form keeps its edits even when the server value really changed', () => {
    // Discarding a pending edit is the worse failure of the two; the edit
    // survives and the next clean render picks the server value up.
    const edited = { ...base, staleDays: 14 };
    const next = formOf(config({ summaryLines: 4 }));
    expect(resyncForm(edited, base, next)).toEqual(edited);
  });

  test('sameForm compares every field the form can change', () => {
    const fields = Object.keys(base) as (keyof typeof base)[];
    expect(fields.length).toBeGreaterThan(0);
    for (const field of fields) {
      const flipped = typeof base[field] === 'boolean'
        ? { ...base, [field]: !base[field] }
        : typeof base[field] === 'number'
          ? { ...base, [field]: (base[field] as number) + 1 }
          : { ...base, [field]: `${base[field]}-changed` };
      expect(sameForm(base, flipped), `sameForm ignores ${field}`).toBe(false);
    }
  });
});

describe('WorksConfigPanel copy', () => {
  /**
   * The panel's labels used to be the storage: `works.summary_model`,
   * `works.summary_lines`, `works.stale_days`, `projectDir`, `resumeSessionId`.
   * Those name the setting key and the wire field, not the behaviour, and mean
   * nothing to a reader who has not opened the source. `docs/works.md` keeps the
   * key table; the screen does not.
   */
  const INTERNAL_IDENTIFIERS = [
    'works.summary_model',
    'works.summary_lines',
    'works.stale_days',
    'works.assign_prefer_same_dir',
    'works.assign_suggest_resume_chain',
    'works.done_confirm',
    'projectDir',
    'resumeSessionId',
    'relatedSessionIds',
  ];

  test('names no setting key or wire field', () => {
    const html = markup();
    for (const identifier of INTERNAL_IDENTIFIERS) {
      expect(html, `settings copy still says "${identifier}"`).not.toContain(identifier);
    }
  });

  test('describes the lineage toggle as all three chains it actually covers', () => {
    // The label said "resume 체인(resumeSessionId)", naming one of the three:
    // the lineage `buildSessionChainMap` computes is a resumed session, a
    // subagent's parent, *or* a queue chain.
    const html = markup();
    expect(html).toContain('이어하기');
    expect(html).toContain('하위 에이전트');
    expect(html).toContain('큐');
  });

  test('offers the runtime catalog models, not a local copy of them', () => {
    // CLAUDE_MODELS / CODEX_MODELS in src/core/runtime-config.ts are the single
    // source (CLAUDE.md: never hardcode models elsewhere). The old literal here
    // had drifted from it.
    const claudeHtml = markup();
    for (const model of CLAUDE_MODELS) {
      expect(claudeHtml, `${model.id} missing from the model select`)
        .toContain(`value="${model.id}"`);
    }
    const codexHtml = markup(config({ summaryModel: 'gpt-5.6-sol', route: 'codex' }));
    for (const model of CODEX_MODELS) {
      expect(codexHtml, `${model.id} missing from the model select`)
        .toContain(`value="${model.id}"`);
    }
  });

  test('keeps a model saved before it left the catalog selectable', () => {
    const html = markup(config({ summaryModel: 'claude-opus-4-1-retired' }));
    expect(html).toContain('claude-opus-4-1-retired');
    expect(html).toContain('직접 지정한 모델');
  });

  test('uses the shared split footer so 되돌리기 and 저장 sit where they do elsewhere', () => {
    const html = markup();
    expect(html).toContain('kv2-actions-split');
    expect(html).toContain('되돌리기');
  });
});
