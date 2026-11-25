/**
 * Extracts the real OFF/ON outputs for the requested sample input from the actual code paths.
 * Set PROMPT_REFINEMENT_DEMO_OUT=<dir> to write them as files; assertions run either way.
 * The AI path uses the SYNTHETIC upstream (no network, no key) — it is labelled as such.
 */
import { expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createPromptRefinementRoute } from '../server/prompt-refinement-route';
import { PROMPT_PROPOSAL_PATH } from '../core/prompt-proposal';
import { createSyntheticPromptUpstream, SYNTHETIC_LABEL } from './synthetic-prompt-provider';
import { applyPromptPreview, isBlocked, previewLoopPrompt, previewPrompt, type RefinementPreview } from '../../web/src/utils/prompt-refinement';
import { parsePromptProposal } from '../../web/src/utils/prompt-refinement-provider';

export const SAMPLE = '이거도 카드로 만들어서 진행하자 버튼누르면 모달이 뜨고 거기서 모델을 세팅할 수 있고 그 모델로 맥락을 판단해서 작업의 프롬프트를 다듬을 수 있게 특히 목표를 설정하거나 아니면 완료될 때까지 어떤 조건을 만날때까지 수정보완해 이런키워드를 넣을 수 있도록 그러니까 어떤 체크박스가 있고 그걸 체크하면 루프엔지니어링처럼 프롬프트가 생성되기 체크하지않으면 일반적인 방식으로 동작하도록 칸반으로 작업해. 완료되면 결과물 비여주고 테스트로 이 프롬프트를 인풋으로넣고 아웃풋을 보여줘';
const loop = { goal: '', doneWhen: '', maxRounds: 3 };
// Decisions without a choice are left out, exactly like the UI's default.
const full = (p: RefinementPreview) => applyPromptPreview(p, SAMPLE, p.sections.filter(s => !isBlocked(s)).map(s => s.id));
const out = process.env.PROMPT_REFINEMENT_DEMO_OUT;
const save = (name: string, header: string, text: string) => {
  if (!out) return;
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, name), `${header}\n----- 적용 결과 전체 (전체 적용 기준) -----\n${text}\n`);
};

test('local template OFF/ON with the identical sample input (no model, no network)', () => {
  const off = full(previewPrompt(SAMPLE));
  const on = full(previewLoopPrompt(SAMPLE, loop));
  expect(off.startsWith(SAMPLE)).toBe(true);
  expect(on.startsWith(SAMPLE)).toBe(true);
  expect(off).not.toContain('중단 조건');
  expect(on).toContain('중단 조건');
  save('local-off.txt', '# 로컬 템플릿 · 체크 OFF · 모델 없음(네트워크 전송 없음)', off);
  save('local-on.txt', '# 로컬 템플릿 · 체크 ON(목표/완료 조건 미입력, 반복 한도 3) · 모델 없음(네트워크 전송 없음)', on);
});

test('AI mode OFF/ON through the real route with the SYNTHETIC provider and a non-default selected model', async () => {
  const { upstream, calls } = createSyntheticPromptUpstream();
  const route = createPromptRefinementRoute({ apiKey: 'synthetic-key', model: 'synthetic-default', models: ['synthetic-default', 'synthetic-alt'] }, upstream);
  const ask = async (withLoop: boolean) => {
    const res = await route(new Request('http://localhost' + PROMPT_PROPOSAL_PATH, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source: SAMPLE, provider: 'OpenAI', model: 'synthetic-alt', consent: true, ...(withLoop ? { loop } : {}) }) }));
    expect(res.status).toBe(200);
    return full(parsePromptProposal(SAMPLE, await res.json(), withLoop ? loop : undefined));
  };
  const off = await ask(false);
  const on = await ask(true);
  expect(calls.map(c => c.model)).toEqual(['synthetic-alt', 'synthetic-alt']);
  expect(off).toContain(SYNTHETIC_LABEL);
  expect(on).toContain('loop=on');
  const header = (flag: string) => `# AI 맞춤 · 체크 ${flag} · 선택 모델 synthetic-alt · ${SYNTHETIC_LABEL} (외부 전송 없음, 키 없음)`;
  save('synthetic-ai-off.txt', header('OFF'), off);
  save('synthetic-ai-on.txt', header('ON'), on);
});
