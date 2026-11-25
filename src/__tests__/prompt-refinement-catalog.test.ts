import { expect, test } from 'bun:test';
import { buildPromptCatalog, type PromptTransportStatus } from '../server/prompt-refinement-catalog';
import { createPromptRefinementRoute, promptTransportIssues } from '../server/prompt-refinement-route';
import { CODEX_REFINEMENT, type CodexRefiner } from '../server/prompt-refinement-codex';
import { PromptRefinementPrefsStore } from '../core/prompt-refinement-prefs-store';
import { CLAUDE_MODELS, CODEX_MODELS } from '../core/runtime-config';
import {
  findCatalogModel, PROMPT_PROPOSAL_PATH, PROMPT_REFINEMENT_DEFAULT_PATH, readPromptCatalog,
  type PromptReadinessCheck, type PromptRefinementCatalog,
} from '../core/prompt-proposal';
import { createSyntheticPromptUpstream } from './synthetic-prompt-provider';
import { withTempDir } from './setup';

const ok: PromptReadinessCheck[] = [{ key: 'auth', label: '전용 로그인', ok: true, detail: 'fixture' }];
const noLogin: PromptReadinessCheck[] = [{ key: 'auth', label: '전용 로그인', ok: false, detail: '전용 로그인 없음' }];
const codex = (checks = ok, models = ['gpt-6.1-sol']): PromptTransportStatus =>
  ({ provider: 'Codex CLI', configured: true, defaultModel: models[0], models, checks });
const openai: PromptTransportStatus = { provider: 'OpenAI', configured: true, defaultModel: 'synthetic-default',
  models: ['synthetic-default', 'synthetic-alt'], checks: ok };
const selectable = (c: PromptRefinementCatalog) => c.providers.flatMap(p => p.models.filter(m => m.selectable).map(m => `${p.provider}/${m.id}`));

test('0 transports: every catalog model is listed per provider, none selectable, each with reason and settings location', () => {
  const c = buildPromptCatalog([], null);
  expect(c.providers.map(p => p.provider)).toEqual(['Codex CLI', 'OpenAI', 'Claude CLI']);
  expect(selectable(c)).toEqual([]);
  expect(c.serverDefault).toBeNull();
  expect(c.effectiveDefault).toBeNull();
  const codexGroup = c.providers[0];
  expect(codexGroup.models.map(m => m.id)).toEqual(CODEX_MODELS.map(m => m.id));
  expect(c.providers[2].models.map(m => m.id)).toEqual(CLAUDE_MODELS.map(m => m.id));
  for (const m of c.providers.flatMap(p => p.models)) {
    expect(m.reason).toBeTruthy();
    expect(m.settingsHint).toBeTruthy();
  }
});

test('1 model (current production shape): only the allow-listed Codex model is selectable; card-catalog-only entries say how to extend', () => {
  const c = buildPromptCatalog([codex()], null);
  expect(selectable(c)).toEqual(['Codex CLI/gpt-6.1-sol']);
  expect(c.serverDefault).toEqual({ provider: 'Codex CLI', model: 'gpt-6.1-sol' });
  const astra = findCatalogModel(c, { provider: 'Codex CLI', model: 'gpt-6-astra' })!;
  expect(astra.selectable).toBe(false);
  expect(astra.reason).toContain('허용 목록에 없음');
  expect(astra.settingsHint).toContain('KANBAN_PROMPT_CODEX_MODELS');
});

test('extended allow-list + two transports: both selectable, server default stays Codex, saved default wins only while valid', () => {
  const both = [codex(ok, ['gpt-6.1-sol', 'gpt-6-astra']), openai];
  const c = buildPromptCatalog(both, { provider: 'OpenAI', model: 'synthetic-alt' });
  expect(selectable(c)).toEqual(['Codex CLI/gpt-6.1-sol', 'Codex CLI/gpt-6-astra', 'OpenAI/synthetic-default', 'OpenAI/synthetic-alt']);
  expect(c.serverDefault).toEqual({ provider: 'Codex CLI', model: 'gpt-6.1-sol' });
  expect(c.savedDefault).toEqual({ provider: 'OpenAI', model: 'synthetic-alt', valid: true });
  expect(c.effectiveDefault).toEqual({ provider: 'OpenAI', model: 'synthetic-alt' });
  // Saved model removed from the allow-list → never faked as selectable; falls back to server default.
  const stale = buildPromptCatalog([codex()], { provider: 'OpenAI', model: 'synthetic-alt' });
  expect(stale.savedDefault).toMatchObject({ valid: false });
  expect(stale.effectiveDefault).toEqual({ provider: 'Codex CLI', model: 'gpt-6.1-sol' });
});

test('login missing: Codex models visible but not selectable with the failing check as reason; Claude is never selectable', () => {
  const c = buildPromptCatalog([codex(noLogin)], { provider: 'Claude CLI', model: 'claude-opus-5-5' });
  expect(selectable(c)).toEqual([]);
  expect(c.providers[0].ready).toBe(false);
  expect(findCatalogModel(c, { provider: 'Codex CLI', model: 'gpt-6.1-sol' })!.reason).toContain('전용 로그인');
  expect(c.savedDefault).toMatchObject({ valid: false });
  expect(c.effectiveDefault).toBeNull();
});

test('issues name env variables only, never values', () => {
  const secret = 'sk-should-never-appear';
  const issues = promptTransportIssues({ KANBAN_PROMPT_AI_ENABLED: 'true', KANBAN_PROMPT_OPENAI_API_KEY: secret });
  expect(JSON.stringify(issues)).not.toContain(secret);
  expect(issues.OpenAI).toContain('KANBAN_PROMPT_OPENAI_MODEL');
  const c = buildPromptCatalog([{ provider: 'OpenAI', configured: false, issue: issues.OpenAI, models: [], checks: [] }], null);
  expect(JSON.stringify(c)).not.toContain(secret);
});

test('client reader drops malformed entries and never trusts a non-selectable effective default', () => {
  const c = buildPromptCatalog([codex()], null);
  const forged = JSON.parse(JSON.stringify(c)) as Record<string, unknown>;
  forged.effectiveDefault = { provider: 'Claude CLI', model: 'claude-opus-5-5' };
  (forged.providers as unknown[]).push({ provider: 'Evil', models: [{ id: 'x', selectable: true }] });
  const read = readPromptCatalog(forged)!;
  expect(read.providers.map(p => p.provider)).toEqual(['Codex CLI', 'OpenAI', 'Claude CLI']);
  expect(read.effectiveDefault).toBeNull();
  expect(readPromptCatalog({ providers: 'nope' })).toBeNull();
});

const req = (path: string, init?: RequestInit) => new Request('http://127.0.0.1' + path, init);
const put = (body: unknown) => req(PROMPT_REFINEMENT_DEFAULT_PATH, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

test('default endpoint: server-validated save, survives a new route+store (restart), clear; GET/PUT never call a model', async () => withTempDir(async dir => {
  let proposeCalls = 0;
  const { upstream, calls } = createSyntheticPromptUpstream();
  const fakeCodex = (checks: PromptReadinessCheck[]): CodexRefiner => ({
    provider: CODEX_REFINEMENT, model: 'gpt-6.1-sol', models: ['gpt-6.1-sol'], probe: async () => checks,
    propose: async () => { proposeCalls++; throw Error('must not be called'); },
  });
  const transports = () => [fakeCodex(ok), { apiKey: 'synthetic-key', model: 'synthetic-default', models: ['synthetic-default', 'synthetic-alt'] }];
  const route = createPromptRefinementRoute(transports(), upstream, { prefs: new PromptRefinementPrefsStore(dir) });
  const initial = await (await route(req(PROMPT_PROPOSAL_PATH))).json() as { catalog: PromptRefinementCatalog };
  expect(initial.catalog.effectiveDefault).toEqual({ provider: 'Codex CLI', model: 'gpt-6.1-sol' });

  expect((await route(put({ provider: 'Claude CLI', model: 'claude-opus-5-5' }))).status).toBe(409);
  const notAllowed = await route(put({ provider: 'Codex CLI', model: 'gpt-6-astra' }));
  expect(notAllowed.status).toBe(409);
  expect(await notAllowed.json()).toMatchObject({ error: 'model_not_selectable' });
  expect((await route(put({ provider: 'OpenAI', model: 'synthetic-alt', endpoint: 'https://evil.example' }))).status).toBe(400);
  expect((await route(req(PROMPT_REFINEMENT_DEFAULT_PATH, { method: 'PUT', body: '{}' }))).status).toBe(400);

  const saved = await route(put({ provider: 'OpenAI', model: 'synthetic-alt' }));
  expect(saved.status).toBe(200);
  expect(((await saved.json()) as { catalog: PromptRefinementCatalog }).catalog.effectiveDefault).toEqual({ provider: 'OpenAI', model: 'synthetic-alt' });

  // "Restart": brand-new store and route over the same data dir.
  const restarted = createPromptRefinementRoute(transports(), upstream, { prefs: new PromptRefinementPrefsStore(dir) });
  const after = await (await restarted(req(PROMPT_REFINEMENT_DEFAULT_PATH))).json() as { catalog: PromptRefinementCatalog };
  expect(after.catalog.savedDefault).toEqual({ provider: 'OpenAI', model: 'synthetic-alt', valid: true });
  const file = await Bun.file(dir + '/prompt-refinement-prefs.json').text();
  expect(file).not.toContain('synthetic-key');

  expect((await restarted(req(PROMPT_REFINEMENT_DEFAULT_PATH, { method: 'DELETE' }))).status).toBe(200);
  const cleared = await (await restarted(req(PROMPT_REFINEMENT_DEFAULT_PATH))).json() as { catalog: PromptRefinementCatalog };
  expect(cleared.catalog.savedDefault).toBeNull();
  expect(cleared.catalog.effectiveDefault).toEqual({ provider: 'Codex CLI', model: 'gpt-6.1-sol' });
  expect(calls).toHaveLength(0);
  expect(proposeCalls).toBe(0);

  // Without a prefs store nothing is persisted.
  const noPrefs = createPromptRefinementRoute(transports(), upstream);
  expect((await noPrefs(put({ provider: 'OpenAI', model: 'synthetic-alt' }))).status).toBe(503);
}));

test('POST is pinned to the named provider: not-ready Codex is refused (503) and never re-routed to OpenAI', async () => {
  let proposeCalls = 0;
  const { upstream, calls } = createSyntheticPromptUpstream();
  const route = createPromptRefinementRoute([
    { provider: CODEX_REFINEMENT, model: 'gpt-6.1-sol', models: ['gpt-6.1-sol'], probe: async () => noLogin,
      propose: async () => { proposeCalls++; return {}; } },
    { apiKey: 'synthetic-key', model: 'synthetic-default', models: ['synthetic-default', 'synthetic-alt'] },
  ], upstream);
  const post = (provider: string, model: string) => route(req(PROMPT_PROPOSAL_PATH, { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ source: '요청', provider, model, consent: true }) }));
  const refused = await post('Codex CLI', 'gpt-6.1-sol');
  expect(refused.status).toBe(503);
  expect(await refused.json()).toEqual({ error: 'provider_not_ready' });
  expect((await post('OpenAI', 'gpt-6.1-sol')).status).toBe(409);
  expect((await post('Claude CLI', 'claude-opus-5-5')).status).toBe(409);
  expect(proposeCalls).toBe(0);
  expect(calls).toHaveLength(0);
  expect((await post('OpenAI', 'synthetic-alt')).status).toBe(200);
  expect(calls.map(c => c.model)).toEqual(['synthetic-alt']);
});

test('dynamic card models are visible but never grant refinement permission', () => {
  const catalog = buildPromptCatalog([], null, {
    'Codex CLI': [{id:'gpt-dynamic-test', label:'Codex live catalog'}],
    'Claude CLI': [{id:'claude-dynamic-test', label:'Claude live catalog'}],
    OpenCode: [{id:'github-copilot/opencode-test', label:'OpenCode card model'}],
  });
  for (const [name, id] of [['Codex CLI','gpt-dynamic-test'],['Claude CLI','claude-dynamic-test'],['OpenCode','github-copilot/opencode-test']]) {
    const item = catalog.providers.find(p => p.provider === name)?.models.find(m => m.id === id);
    expect(item?.selectable).toBe(false);
    expect(item?.reason).toBeTruthy();
  }
});
