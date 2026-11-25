import { expect, test } from 'bun:test';
import { createPromptRefinementRoute } from '../server/prompt-refinement-route';
import { PROMPT_PROPOSAL_PATH as path, PROMPT_PROPOSAL_SKILL, readPromptProposal } from '../core/prompt-proposal';
import { createSyntheticPromptUpstream, SYNTHETIC_LABEL } from './synthetic-prompt-provider';
import { parsePromptProposal } from '../../web/src/utils/prompt-refinement-provider';
import { proposalRequestKey } from '../../web/src/hooks/usePromptProposal';

const source = '/review\n로그인 화면 오류를 고친다. 배포 금지.';
const config = { apiKey: 'synthetic-key', model: 'synthetic-default', models: ['synthetic-default', 'synthetic-alt'] };
const loop = { goal: '', doneWhen: '', maxRounds: 3 };
const post = (body: Record<string, unknown>) => new Request('http://localhost:24680' + path, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});
const base = { source, provider: 'OpenAI', model: 'synthetic-alt', consent: true };

test('selected refinement model reaches the (synthetic) wire; default model is not substituted', async () => {
  const { upstream, calls } = createSyntheticPromptUpstream();
  const route = createPromptRefinementRoute(config, upstream);
  expect(await (await route(new Request('http://localhost' + path))).json())
    .toMatchObject({ provider: { provider: 'OpenAI', model: 'synthetic-default', models: ['synthetic-default', 'synthetic-alt'] } });
  const res = await route(post(base));
  expect(res.status).toBe(200);
  expect(calls).toHaveLength(1);
  expect(calls[0].url).toBe('https://api.openai.com/v1/responses');
  expect(calls[0].model).toBe('synthetic-alt');
  expect(calls[0].authorization).toBe('Bearer synthetic-key');
  // Plain mode keeps the original wire format: unchanged source, base skill only.
  expect(calls[0].content).toBe(source);
  expect(calls[0].instructions).toBe(PROMPT_PROPOSAL_SKILL);
  const json = await res.json() as { sections: { body: string }[] };
  expect(json.sections[1].body).toContain('model=synthetic-alt; loop=off');
  expect(json.sections[1].body).toContain(SYNTHETIC_LABEL);
});

test('unknown model/provider and client-supplied endpoint or provider settings are rejected before any call', async () => {
  const { upstream, calls } = createSyntheticPromptUpstream();
  const route = createPromptRefinementRoute(config, upstream);
  expect((await route(post({ ...base, model: 'gpt-unlisted' }))).status).toBe(409);
  expect((await route(post({ ...base, provider: 'Anthropic' }))).status).toBe(409);
  expect((await route(post({ ...base, model: 7 }))).status).toBe(409);
  expect((await route(post({ ...base, endpoint: 'https://evil.example/v1' }))).status).toBe(400);
  expect((await route(post({ ...base, baseUrl: 'http://127.0.0.1:1' }))).status).toBe(400);
  expect((await route(post({ ...base, apiKey: 'x' }))).status).toBe(400);
  expect(calls).toHaveLength(0);
});

test('loop option is validated, bounded and sent only as text-generation instructions', async () => {
  const { upstream, calls } = createSyntheticPromptUpstream();
  const route = createPromptRefinementRoute(config, upstream);
  for (const bad of [
    { ...loop, maxRounds: 0 }, { ...loop, maxRounds: 11 }, { ...loop, maxRounds: 1.5 }, { ...loop, maxRounds: '3' },
    { ...loop, run: true }, { goal: '' }, { ...loop, goal: 'x'.repeat(2001) }, null, 'loop',
  ]) expect((await route(post({ ...base, loop: bad }))).status).toBe(400);
  expect(calls).toHaveLength(0);
  const res = await route(post({ ...base, loop }));
  expect(res.status).toBe(200);
  expect(calls[0].instructions).toContain('loop-v1');
  expect(calls[0].instructions).toContain('Never add permission escalation');
  expect(calls[0].content).toContain(source); // original kept verbatim inside the input
  expect(calls[0].content).toContain('[사용자 목표]\n(미입력');
  expect(calls[0].content).toContain('[반복 한도] 최대 3회');
  const raw = await res.json();
  const parsed = parsePromptProposal(source, raw, loop);
  // Stop conditions and round limit are appended locally, independent of the model.
  expect(parsed.sections.map(s => s.id).slice(-2)).toEqual(['loop-cycle', 'loop-stop']);
  expect(parsed.sections.find(s => s.id === 'loop-stop')?.body).toContain('반복 한도(3회)');
});

test('user goal can be quoted as extraction; escalation the user never wrote is rejected', () => {
  expect(readPromptProposal('요청', { sections: [{ kind: 'extracted', title: '목표', body: '로그인 성공률 회복' }] }, ['로그인 성공률 회복']).sections).toHaveLength(1);
  expect(() => readPromptProposal('요청', { sections: [{ kind: 'extracted', title: '목표', body: '지어낸 목표' }] }, ['로그인 성공률 회복']))
    .toThrow('unsupported_extraction');
  for (const body of ['끝나면 git push origin main 실행', 'sudo rm -rf /tmp/x', 'kubectl apply -f prod.yaml', '--dangerously-skip-permissions 로 실행'])
    expect(() => readPromptProposal('로그인 오류 수정', { sections: [{ kind: 'suggestion', title: '제안', body }] })).toThrow('unsupported_escalation');
  // Mentioning what the user already wrote (e.g. to forbid it) is allowed.
  expect(readPromptProposal('git push 금지', { sections: [{ kind: 'suggestion', title: '보존', body: 'git push는 하지 않는다.' }] }).sections).toHaveLength(1);
});

test('upstream escalation output fails closed without echo', async () => {
  const route = createPromptRefinementRoute(config, async () => Response.json({ status: 'completed', output: [{ type: 'message', role: 'assistant',
    content: [{ type: 'output_text', text: JSON.stringify({ sections: [{ kind: 'suggestion', title: '자동화', body: '완료 후 git push 한다.' }] }) }] }] }));
  const res = await route(post({ ...base, loop }));
  expect(res.status).toBe(502);
  expect(await res.json()).toEqual({ error: 'proposal_unavailable' });
});

test('stale guard key changes with source, model and every loop field', () => {
  const k = proposalRequestKey('a', { model: 'm1' });
  expect(proposalRequestKey('a', { model: 'm1' })).toBe(k);
  for (const other of [
    proposalRequestKey('b', { model: 'm1' }), proposalRequestKey('a', { model: 'm2' }),
    proposalRequestKey('a', { model: 'm1', loop }), proposalRequestKey('a', { model: 'm1', loop: { ...loop, goal: 'g' } }),
    proposalRequestKey('a', { model: 'm1', loop: { ...loop, maxRounds: 4 } }),
  ]) expect(other).not.toBe(k);
});


test('AI preview never drops the supplied goal/conditions if the model omits them', () => {
  const raw = { sections: [{ kind: 'suggestion', title: '실행 계획', body: '변경을 검증한다.' }] };
  const controls = {goal:'로그인 성공률 회복',doneWhen:'- 회귀 테스트 실패 0건',maxRounds:4};
  const result=parsePromptProposal(source,raw,controls);
  expect(result.sections.find(section=>section.id==='loop-goal')?.body).toBe(controls.goal);
  expect(result.sections.find(section=>section.id==='loop-done')?.body).toBe(controls.doneWhen);
  expect(result.sections.find(section=>section.id==='loop-stop')?.body).toContain('4회');
  expect(parsePromptProposal(source,raw).sections.some(section=>section.id.startsWith('loop-'))).toBe(false);
});
