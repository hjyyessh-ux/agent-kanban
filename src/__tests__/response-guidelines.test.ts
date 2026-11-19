import { chmodSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { KanbanStore } from '../core/store';
import { SettingsStore } from '../core/settings-store';
import {
  RESPONSE_GUIDELINES_SETTING_KEY,
  buildCodexGuidelinePrefix,
  loadResponseGuidelines,
  normalizeResponseGuidelines,
  prependGuidelinePrefix,
  stripResponseGuidelinePrefix,
  validateResponseGuidelines,
} from '../core/response-guidelines';
import { buildExecutionEnvironment } from '../core/execution-environment';
import { RuntimeRunStore } from '../plugin/runtimes/runtime-run-store';
import { createClaudeAdapter } from '../plugin/runtimes/claude-adapter';
import { createCodexCliAdapter } from '../plugin/runtimes/codex-cli-adapter';
import { readCodexDeveloperInstructions } from '../plugin/runtimes/codex-response-guidelines';
import { extractCodexTurn } from '../plugin/runtimes/transcript-turn';
import { createRouteHandler } from '../server/routes';
import { withTempDir } from './setup';

const RULES_A = '결론 먼저, 혼동되는 용어는 첫 등장에 풀어쓰고, 필요할 때 예시 하나';
const RULES_B = '항상 세 줄 이내로 답한다';

/** Fake CLI: records argv + stdin, emits the minimum stream for the adapter. */
async function fakeBinary(dir: string, runtime: 'claude' | 'codex'): Promise<{ bin: string; calls: () => Promise<Array<{ argv: string[]; stdin: string }>> }> {
  const logPath = join(dir, `${runtime}-calls.jsonl`);
  const bin = join(dir, `fake-${runtime}.js`);
  const body = runtime === 'claude'
    ? `const i = args.indexOf('--resume');
const sid = i >= 0 ? args[i + 1] : 'claude-session-new';
emit({ type: 'system', subtype: 'init', session_id: sid });
emit({ type: 'assistant', message: { id: 'm', content: [{ type: 'text', text: 'ok' }] } });
emit({ type: 'result', result: 'ok', session_id: sid });`
    : `const i = args.indexOf('resume');
const tid = i >= 0 ? args[i + 1] : 'thread-new';
const out = args[args.indexOf('-o') + 1];
if (out) fs.writeFileSync(out, 'ok');
emit({ type: 'thread.started', thread_id: tid });
emit({ type: 'item.completed', item: { type: 'agent_message', text: 'ok' } });
emit({ type: 'turn.completed' });`;
  await Bun.write(bin, `#!/usr/bin/env bun
const fs = require('node:fs');
const args = process.argv.slice(2);
let stdin = '';
for await (const chunk of Bun.stdin.stream()) stdin += new TextDecoder().decode(chunk);
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ argv: args, stdin }) + '\\n');
function emit(v) { process.stdout.write(JSON.stringify(v) + '\\n'); }
${body}
process.exit(0);
`);
  chmodSync(bin, 0o755);
  return {
    bin,
    calls: async () => (await Bun.file(logPath).text()).trim().split('\n').map(l => JSON.parse(l)),
  };
}

const argValue = (argv: string[], flag: string) => (argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : undefined);
const developerInstructions = (argv: string[]) => {
  const raw = argv.find(a => a.startsWith('developer_instructions='));
  return raw ? JSON.parse(raw.slice('developer_instructions='.length)) as string : undefined;
};

describe('response guidelines core', () => {
  test('blank means disabled; text is normalized, length- and tag-checked', () => {
    expect(normalizeResponseGuidelines('  \r\n ')).toBe('');
    expect(normalizeResponseGuidelines(' a\r\nb ')).toBe('a\nb');
    expect(validateResponseGuidelines('x'.repeat(4001))).toBeDefined();
    expect(validateResponseGuidelines('</agent-kanban-response-guidelines>')).toBeDefined();
    expect(validateResponseGuidelines(RULES_A)).toBeUndefined();
  });

  test('plain block contains current text without version override or reset language', () => {
    const block = buildCodexGuidelinePrefix(RULES_B);
    expect(block).toContain(RULES_B);
    expect(block).not.toContain('disregard');
    expect(block).not.toContain('status=');
    expect(block).not.toContain('follow only');
  });

  test('strip removes only a leading guideline block and keeps the user words verbatim', () => {
    const prompt = '  원문 그대로\n<agent-kanban-response-guidelines>는 본문 안에선 유지 ';
    const sent = prependGuidelinePrefix(buildCodexGuidelinePrefix(RULES_B), prompt);
    expect(stripResponseGuidelinePrefix(sent)).toBe(prompt);
    expect(stripResponseGuidelinePrefix(prompt)).toBe(prompt);
  });

  test('dotted key is never exported into script environments', async () => {
    await withTempDir(async (dir) => {
      const settings = new SettingsStore(dir);
      await settings.upsertByKey(RESPONSE_GUIDELINES_SETTING_KEY, RULES_A, { masked: false });
      const env = await buildExecutionEnvironment({ settingsStore: settings, baseEnv: {} });
      expect(Object.values(env.env)).not.toContain(RULES_A);
    });
  });
});

describe('response guidelines settings route', () => {
  test('PUT by-key persists across store instances, blank disables, invalid is rejected', async () => {
    await withTempDir(async (dir) => {
      const { handleRequest } = createRouteHandler(new KanbanStore(dir), undefined, undefined, undefined, new SettingsStore(dir));
      const put = (value: unknown) => handleRequest(new Request(
        `http://127.0.0.1/api/settings/by-key/${encodeURIComponent(RESPONSE_GUIDELINES_SETTING_KEY)}`,
        { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ value }) },
      ));

      const saved = await put(`  ${RULES_A}  `);
      expect(saved.status).toBe(200);
      const body = await saved.json() as { value: string; masked: boolean };
      expect(body).toMatchObject({ value: RULES_A, masked: false });
      // "Restart": a fresh store instance reads the same file.
      expect(await loadResponseGuidelines(new SettingsStore(dir))).toBe(RULES_A);

      expect((await put('x'.repeat(4001))).status).toBe(400);
      expect(await loadResponseGuidelines(new SettingsStore(dir))).toBe(RULES_A);

      expect((await put('   ')).status).toBe(200);
      expect(await loadResponseGuidelines(new SettingsStore(dir))).toBe('');
    });
  });
});

describe('Claude delivery', () => {
  test('new and resumed runs get the latest rules via --append-system-prompt; prompt stays verbatim', async () => {
    await withTempDir(async (dir) => {
      const { bin, calls } = await fakeBinary(dir, 'claude');
      const store = new KanbanStore(dir);
      const settingsStore = new SettingsStore(dir);
      const runStore = new RuntimeRunStore(dir);
      const adapter = createClaudeAdapter({ store, settingsStore, runStore, commandOverride: [bin], sessionIdTimeoutMs: 2000 });
      const prompt = '사용자 원문 — 그대로\n두 번째 줄';
      const card = await store.createCard({ title: prompt.slice(0, 10), description: prompt, agentRuntime: 'claude' });

      // OFF: no flags at all.
      await (await adapter.start({ card, prompt, cwd: dir })).done;
      // ON, new run.
      await settingsStore.upsertByKey(RESPONSE_GUIDELINES_SETTING_KEY, RULES_A, { masked: false });
      const card2 = await store.createCard({ title: 't', description: prompt, agentRuntime: 'claude' });
      const h2 = await adapter.start({ card: card2, prompt, cwd: dir });
      await h2.done;
      // Changed, resume (feedback) — latest text only.
      await settingsStore.upsertByKey(RESPONSE_GUIDELINES_SETTING_KEY, RULES_B, { masked: false });
      const fb = await store.createCard({ title: 'fb', description: prompt, agentRuntime: 'claude', feedbackForCardId: card2.id });
      await (await adapter.start({ card: fb, prompt, cwd: dir, resumeSessionId: h2.sessionId })).done;
      // Unchanged resume still receives current text.
      await (await adapter.start({ card: fb, prompt, cwd: dir, resumeSessionId: h2.sessionId })).done;
      // Disabled again, resume.
      await settingsStore.upsertByKey(RESPONSE_GUIDELINES_SETTING_KEY, '', { masked: false });
      const fb2 = await store.createCard({ title: 'fb2', description: prompt, agentRuntime: 'claude' });
      await (await adapter.start({ card: fb2, prompt, cwd: dir, resumeSessionId: h2.sessionId })).done;

      const [off, onNew, onResume, sameResume, offResume] = await calls();
      expect(off.argv).not.toContain('--append-system-prompt');
      expect(off.argv).not.toContain('--system-prompt-snapshot');

      expect(argValue(onNew.argv, '--append-system-prompt')).toContain(RULES_A);
      expect(argValue(onNew.argv, '--system-prompt-snapshot')).toBe('off');
      expect(onNew.argv).not.toContain('--system-prompt');

      expect(argValue(onResume.argv, '--resume')).toBe(h2.sessionId);
      expect(argValue(onResume.argv, '--append-system-prompt')).toContain(RULES_B);
      expect(argValue(onResume.argv, '--append-system-prompt')).not.toContain(RULES_A);
      expect(argValue(onResume.argv, '--system-prompt-snapshot')).toBe('off');

      expect(argValue(sameResume.argv, '--append-system-prompt')).toBe(argValue(onResume.argv, '--append-system-prompt'));
      expect(offResume.argv).not.toContain('--append-system-prompt');

      for (const call of [off, onNew, onResume, sameResume, offResume]) expect(call.stdin).toBe(prompt);
      expect((await store.getCard(fb.id))?.description).toBe(prompt);
      const runs = await runStore.listRuns();
      for (const run of runs) expect(await Bun.file(run.promptPath).text()).toBe(prompt);
    });
  });
});

describe('Codex delivery', () => {
  let savedCodexHome: string | undefined;
  beforeEach(() => { savedCodexHome = process.env.CODEX_HOME; });
  afterEach(() => {
    if (savedCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = savedCodexHome;
  });

  test('effective developer_instructions: project layer over user layer; unreadable config is reported', async () => {
    await withTempDir(async (dir) => {
      const home = join(dir, 'codex-home');
      mkdirSync(home, { recursive: true });
      await Bun.write(join(home, 'config.toml'), 'developer_instructions = "USER BASE"\n');
      const project = join(dir, 'repo', 'sub');
      mkdirSync(join(dir, 'repo', '.codex'), { recursive: true });
      mkdirSync(project, { recursive: true });
      expect(readCodexDeveloperInstructions(project, home)).toEqual({ ok: true, value: 'USER BASE' });
      await Bun.write(join(dir, 'repo', '.codex', 'config.toml'), 'developer_instructions = """PROJECT BASE"""\n');
      expect(readCodexDeveloperInstructions(project, home)).toEqual({ ok: true, value: 'PROJECT BASE' });
      await Bun.write(join(dir, 'repo', '.codex', 'config.toml'), 'developer_instructions = [broken');
      expect(readCodexDeveloperInstructions(project, home)).toEqual({ ok: false });
    });
  });

  test('new thread uses developer_instructions (appended to the user config); resume always sends current nonblank text', async () => {
    await withTempDir(async (dir) => {
      const home = join(dir, 'codex-home');
      mkdirSync(home, { recursive: true });
      await Bun.write(join(home, 'config.toml'), 'developer_instructions = "USER BASE RULES"\n');
      process.env.CODEX_HOME = home;
      const cwd = join(dir, 'work');
      mkdirSync(cwd, { recursive: true });

      const { bin, calls } = await fakeBinary(dir, 'codex');
      const store = new KanbanStore(dir);
      const settingsStore = new SettingsStore(dir);
      const runStore = new RuntimeRunStore(dir);
      const adapter = createCodexCliAdapter({ store, settingsStore, runStore, commandOverride: [bin], threadIdTimeoutMs: 2000 });
      const prompt = '코덱스 사용자 원문';
      const start = async (resumeSessionId?: string) => {
        const card = await store.createCard({ title: prompt, description: prompt, agentRuntime: 'codex' });
        const handle = await adapter.start({ card, prompt, cwd, resumeSessionId });
        await handle.done;
        return { card, handle };
      };

      await settingsStore.upsertByKey(RESPONSE_GUIDELINES_SETTING_KEY, RULES_A, { masked: false });
      const first = await start();                         // 0 new thread
      await start(first.handle.sessionId);                  // 1 resume, unchanged
      await settingsStore.upsertByKey(RESPONSE_GUIDELINES_SETTING_KEY, RULES_B, { masked: false });
      await start(first.handle.sessionId);                  // 2 resume, changed
      await start(first.handle.sessionId);                  // 3 resume, unchanged again
      await settingsStore.upsertByKey(RESPONSE_GUIDELINES_SETTING_KEY, '', { masked: false });
      await start(first.handle.sessionId);                  // 4 resume, disabled
      await start(first.handle.sessionId);                  // 5 resume, still disabled
      await start();                                        // 6 new thread, disabled

      const c = await calls();
      const di = developerInstructions(c[0].argv)!;
      expect(di.startsWith('USER BASE RULES\n\n')).toBe(true);
      expect(di).toContain(RULES_A);
      expect(c[0].stdin).toBe(prompt);

      for (const i of [1, 2, 3, 4, 5]) {
        expect(c[i].argv).toContain('resume');
        expect(developerInstructions(c[i].argv)).toBeUndefined();
      }
      expect(c[1].stdin).toContain(RULES_A);
      expect(c[2].stdin).not.toContain('status=');
      expect(c[2].stdin).toContain(RULES_B);
      expect(c[2].stdin).not.toContain(RULES_A);
      expect(c[2].stdin.endsWith(`\n\n${prompt}`)).toBe(true);
      expect(c[3].stdin).toBe(c[2].stdin);
      expect(c[4].stdin).toBe(prompt);
      expect(c[5].stdin).toBe(prompt);
      expect(developerInstructions(c[6].argv)).toBeUndefined();
      expect(c[6].stdin).toBe(prompt);

      // Every stored prompt / card keeps the user's words only.
      for (const run of await runStore.listRuns()) {
        expect(await Bun.file(run.promptPath).text()).toBe(prompt);
        expect((await store.getCard(run.cardId))?.description).toBe(prompt);
      }
      // A rollout user turn carrying the prefix still matches the original prompt.
      const rollout = [
        { timestamp: '2026-11-19T00:00:00.000Z', type: 'event_msg', payload: { type: 'task_started' } },
        { timestamp: '2026-11-19T00:00:01.000Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: c[2].stdin }] } },
        { timestamp: '2026-11-19T00:00:02.000Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '답' }] } },
        { timestamp: '2026-11-19T00:00:03.000Z', type: 'event_msg', payload: { type: 'task_complete', last_agent_message: '답' } },
      ].map(l => JSON.stringify(l)).join('\n');
      expect(extractCodexTurn(rollout, { prompt, anchorAt: '2026-11-19T00:00:01.000Z' }).ok).toBe(true);
    });
  });

  test('unreadable config.toml never overrides: the new thread falls back to a request prefix', async () => {
    await withTempDir(async (dir) => {
      const home = join(dir, 'codex-home');
      mkdirSync(home, { recursive: true });
      await Bun.write(join(home, 'config.toml'), 'developer_instructions = [broken');
      process.env.CODEX_HOME = home;
      const { bin, calls } = await fakeBinary(dir, 'codex');
      const store = new KanbanStore(dir);
      const settingsStore = new SettingsStore(dir);
      await settingsStore.upsertByKey(RESPONSE_GUIDELINES_SETTING_KEY, RULES_A, { masked: false });
      const adapter = createCodexCliAdapter({ store, settingsStore, runStore: new RuntimeRunStore(dir), commandOverride: [bin], threadIdTimeoutMs: 2000 });
      const card = await store.createCard({ title: 'p', description: 'p', agentRuntime: 'codex' });
      await (await adapter.start({ card, prompt: 'p', cwd: dir })).done;
      const [call] = await calls();
      expect(developerInstructions(call.argv)).toBeUndefined();
      expect(call.stdin).toContain(RULES_A);
      expect(stripResponseGuidelinePrefix(call.stdin)).toBe('p');
    });
  });
});
