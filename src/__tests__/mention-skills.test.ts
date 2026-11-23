import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  parseMentionTokens,
  parseReferenceBlock,
  renderReferenceBlock,
  type MentionResolveResponse,
  type ResolvedReference,
} from '../core/mention-reference';
import { applySkillLaunch, parseSkillLaunch, removeSkillLaunch } from '../core/mention-skills';
import type { MentionSearchResponse } from '../core/mention-search';
import { KanbanStore } from '../core/store';
import {
  buildSkillMentionPool,
  clearMentionSkillCache,
  discoverMentionSkills,
  parseCodexEnabledPlugins,
} from '../server/mention-skill-discovery';
import { createRouteHandler } from '../server/routes';
import { createServer } from '../server/index';
import { withTempDir } from './setup';

/**
 * `@skill:` 멘션. 규칙의 근거는 실측(docs/mockups/mention-skills-capabilities.html ⑥):
 * claude는 `.claude/skills`, codex는 `.codex/skills`·`.agents/skills`만 보고,
 * claude `disable-model-invocation`은 첫 줄 slash로만, codex `allow_implicit_invocation:
 * false`는 `$name` 명시로만 호출된다.
 */

let root = '';
let home = '';
let projectA = '';
let projectB = '';
const originalHome = process.env.HOME;

function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function skill(dir: string, name: string, extra = '', description = `${name} probe skill`): void {
  write(join(dir, name, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n${extra}---\nbody\n`);
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'mention-skills-'));
  home = join(root, 'home');
  projectA = join(root, 'projA');
  projectB = join(root, 'projB');

  // claude — user / project / plugin(user scope) / plugin(project scope, projB only) / synced
  skill(join(home, '.claude', 'skills'), 'consensus');
  skill(join(projectA, '.claude', 'skills'), 'api-test');
  skill(join(projectB, '.claude', 'skills'), 'b-only');
  const egm = join(home, '.claude', 'plugins', 'cache', 'egm', 'egm', '0.1.1');
  skill(join(egm, 'skills'), 'egm-review', 'disable-model-invocation: true\n');
  const scoped = join(home, '.claude', 'plugins', 'cache', 'mk', 'scoped', '1.0.0');
  skill(join(scoped, 'skills'), 'scoped-skill');
  write(join(home, '.claude', 'plugins', 'installed_plugins.json'), JSON.stringify({
    version: 2,
    plugins: {
      'egm@egm': [{ scope: 'user', installPath: egm }],
      'scoped@mk': [{ scope: 'project', projectPath: projectB, installPath: scoped }],
      'disabled@mk': [{ scope: 'user', installPath: scoped }],
    },
  }));
  write(join(home, '.claude', 'settings.json'), JSON.stringify({ enabledPlugins: { 'egm@egm': true } }));
  write(join(projectB, '.claude', 'settings.json'), JSON.stringify({ enabledPlugins: { 'scoped@mk': true } }));
  skill(join(home, '.claude', 'plugins', 'synced', 'org-bucket', 'design', 'skills'), 'critique');

  // codex — project(.codex/.agents) / user / system / plugin / implicit-off policy
  skill(join(projectA, '.codex', 'skills'), 'daily-health');
  skill(join(projectA, '.agents', 'skills'), 'agents-proj');
  skill(join(home, '.codex', 'skills'), 'codex-consensus');
  skill(join(home, '.agents', 'skills'), 'diffity-review');
  skill(join(home, '.codex', 'skills', '.system'), 'review-agent');
  write(join(home, '.codex', 'skills', '.system', 'review-agent', 'agents', 'openai.yaml'),
    'policy:\n  allow_implicit_invocation: false\n');
  // claude 플래그는 codex가 무시한다(C0b) — model로 분류돼야 한다.
  skill(join(home, '.codex', 'skills'), 'claude-flagged', 'disable-model-invocation: true\n');
  skill(join(home, '.codex', 'plugins', 'cache', 'openai-primary-runtime', 'pdf', '26.1', 'skills'), 'pdf');
  write(join(home, '.codex', 'config.toml'), [
    'model = "x"',
    '[plugins."pdf@openai-primary-runtime"]',
    'enabled = true',
    '[plugins."off@openai-bundled"]',
    'enabled = false',
  ].join('\n'));

  process.env.HOME = home;
});

afterAll(() => {
  process.env.HOME = originalHome;
  clearMentionSkillCache();
  rmSync(root, { recursive: true, force: true });
});

beforeEach(() => clearMentionSkillCache());

const names = (entries: { name: string }[]) => entries.map((entry) => entry.name).sort();

describe('skill tokens', () => {
  test('a namespaced plugin skill keeps its inner colon', () => {
    const [token] = parseMentionTokens('리뷰 @skill:egm:egm-review 부탁');
    expect(token).toMatchObject({ kind: 'skill', id: 'egm:egm-review', raw: '@skill:egm:egm-review' });
  });

  test('a trailing colon or period is punctuation, not part of the id', () => {
    const tokens = parseMentionTokens('@skill:consensus: 로 검증. 그리고 @skill:pdf:pdf.');
    expect(tokens.map((token) => token.id)).toEqual(['consensus', 'pdf:pdf']);
    expect(tokens[1].raw).toBe('@skill:pdf:pdf');
  });

  test('doc ids still keep their extension', () => {
    const [token] = parseMentionTokens('@doc:notes/a.md');
    expect(token.id).toBe('notes/a.md');
  });
});

describe('first-line launch helpers', () => {
  test('parse only a bare `/name` on the first non-blank line', () => {
    expect(parseSkillLaunch('\n/egm:egm-review\nbody')).toEqual({ name: 'egm:egm-review' });
    expect(parseSkillLaunch('/review some args')).toBeNull();
    expect(parseSkillLaunch('body\n/egm:egm-review')).toBeNull();
  });

  test('apply replaces an existing launch line — one launch per prompt', () => {
    const once = applySkillLaunch('리뷰해줘', 'egm:egm-review');
    expect(once).toBe('/egm:egm-review\n리뷰해줘');
    expect(applySkillLaunch(once, 'egm:egm-draft')).toBe('/egm:egm-draft\n리뷰해줘');
    expect(removeSkillLaunch(once)).toBe('리뷰해줘');
    expect(applySkillLaunch('', 'x')).toBe('/x\n');
  });
});

describe('reference block', () => {
  const claudeSkill: ResolvedReference = {
    kind: 'skill', id: 'consensus', raw: '@skill:consensus', title: 'consensus',
    skillRuntime: 'claude', skillScope: 'user', skillInvocation: 'model',
  };
  const codexSkill: ResolvedReference = {
    kind: 'skill', id: 'pdf:pdf', raw: '@skill:pdf:pdf', title: 'pdf:pdf',
    skillRuntime: 'codex', skillScope: 'plugin', skillPlugin: 'pdf', skillInvocation: 'model',
  };

  test('claude skills are a Skill-tool instruction, codex skills carry `$name`', () => {
    const block = renderReferenceBlock([claudeSkill, codexSkill]);
    expect(block).toContain('`Skill` 도구로 `consensus` 스킬을 호출');
    expect(block).toContain('`$pdf:pdf`');
    expect(block).toContain('scope: plugin(pdf)');
    expect(block).toContain('**`kind: skill` 항목은 읽을 파일이 아니라 사용할 스킬입니다**');
  });

  test('a block without skills is unchanged — no skill note in the header', () => {
    const block = renderReferenceBlock([{ kind: 'doc', id: 'a.md', raw: '@doc:a.md', title: 'a', docPath: 'a.md' }]);
    expect(block).not.toContain('kind: skill');
  });

  test('unavailable and missing skills tell the agent not to substitute', () => {
    const block = renderReferenceBlock([
      { ...claudeSkill, id: 'egm:egm-review', raw: '@skill:egm:egm-review', unresolved: 'unavailable', skillUnavailable: 'launch_only' },
      { kind: 'skill', id: 'ghost', raw: '@skill:ghost', title: 'ghost', unresolved: 'not_found' },
    ]);
    expect(block).toContain('첫 줄 실행 전용 스킬이라 참조로는 호출되지 않습니다');
    expect(block).toContain('비슷한 이름의 다른 스킬로 대신하지');
    const entries = parseReferenceBlock(block);
    expect(entries.map((entry) => [entry.key, entry.unresolved])).toEqual([
      ['skill:egm:egm-review', 'unavailable'],
      ['skill:ghost', 'not_found'],
    ]);
  });
});

describe('discovery', () => {
  test('claude sees user + its own project + enabled plugins + synced, never .agents', () => {
    const entries = discoverMentionSkills('claude', projectA, { homeDir: home });
    expect(names(entries)).toEqual(['api-test', 'consensus', 'design:critique', 'egm:egm-review']);
    expect(entries.find((entry) => entry.name === 'egm:egm-review')).toMatchObject({
      scope: 'plugin', plugin: 'egm', invocation: 'launch',
    });
    expect(entries.find((entry) => entry.name === 'api-test')).toMatchObject({ scope: 'project', projectDir: projectA });
  });

  test('a project-scope plugin loads only in its own project', () => {
    expect(names(discoverMentionSkills('claude', projectB, { homeDir: home }))).toContain('scoped:scoped-skill');
    expect(names(discoverMentionSkills('claude', projectA, { homeDir: home }))).not.toContain('scoped:scoped-skill');
  });

  test('codex sees .codex/.agents project dirs, user, system and enabled plugins — not .claude', () => {
    const entries = discoverMentionSkills('codex', projectA, { homeDir: home });
    expect(names(entries)).toEqual([
      'agents-proj', 'claude-flagged', 'codex-consensus', 'daily-health', 'diffity-review', 'pdf:pdf', 'review-agent',
    ]);
    expect(entries.find((entry) => entry.name === 'review-agent')).toMatchObject({ scope: 'system', invocation: 'explicit' });
    expect(entries.find((entry) => entry.name === 'claude-flagged')?.invocation).toBe('model');
  });

  test('codex config parsing keeps only enabled plugin sections', () => {
    expect(parseCodexEnabledPlugins('[plugins."a@m"]\nenabled = true\n[plugins."b@m"]\nenabled = false\n[other]\nenabled = true'))
      .toEqual(['a@m']);
  });
});

describe('pool', () => {
  test('other-runtime and other-project skills stay in the pool with a reason', () => {
    const pool = buildSkillMentionPool({ runtime: 'claude', projectDir: projectA, knownProjectDirs: [projectA, projectB] }, { homeDir: home });
    const reason = (name: string) => pool.find((entry) => entry.name === name)?.unavailable;
    expect(reason('api-test')).toBeUndefined();
    expect(reason('daily-health')).toBe('runtime_mismatch');
    expect(reason('b-only')).toBe('other_project');
  });

  test('opencode cards get nothing selectable', () => {
    const pool = buildSkillMentionPool({ runtime: 'opencode', projectDir: projectA }, { homeDir: home });
    expect(pool.length).toBeGreaterThan(0);
    expect(pool.every((entry) => entry.unavailable === 'runtime_unsupported')).toBe(true);
  });
});

describe('routes', () => {
  const token = 'synthetic-local-mention-token';
  function routes(store: KanbanStore) {
    const args: Parameters<typeof createRouteHandler> = [store];
    args[11] = () => token;
    return createRouteHandler(...args).handleRequest;
  }
  function handler(store: KanbanStore) {
    const handleRequest = routes(store);
    return (req: Request) => {
      req.headers.set('Authorization', `Bearer ${token}`);
      return handleRequest(req, { clientAddress: '127.0.0.1' });
    };
  }

  async function getJson<T>(handleRequest: (req: Request) => Promise<Response>, path: string): Promise<T> {
    const res = await handleRequest(new Request(`http://localhost${path}`));
    expect(res.status).toBe(200);
    return await res.json() as T;
  }

  test('remote and unauthenticated calls do not scan or return skill metadata', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const card = await store.createCard({ title: 'Visible session', description: 'Visible session', projectDir: projectA });
      await store.updateCard(card.id, { sessionId: 'visible-session' });
      const handle = routes(store);
      const path = `/api/mentions?kind=skill&projectDir=${encodeURIComponent(projectA)}`;
      const query = `/api/mentions?projectDir=${encodeURIComponent(projectA)}`;
      const launch = '/api/mentions/resolve?launch=consensus';
      const mixed = '/api/mentions/resolve?token=@session:visible-session&token=@skill:consensus';
      const auth = { Authorization: `Bearer ${token}` };
      const local = { clientAddress: '127.0.0.1' };
      const remote = { clientAddress: '192.0.2.5' };

      expect((await handle(new Request('http://localhost' + path), local)).status).toBe(401);
      expect((await handle(new Request('http://localhost' + launch), local)).status).toBe(401);
      expect((await handle(new Request('http://localhost' + path, { headers: auth }))).status).toBe(403);
      expect((await handle(new Request('http://localhost' + path, { headers: auth }), remote)).status).toBe(403);
      expect((await handle(new Request('http://localhost' + launch, { headers: auth }), remote)).status).toBe(403);

      for (const [headers, address] of [[{}, local], [auth, remote]] as const) {
        const res = await handle(new Request('http://localhost' + query, { headers }), address);
        expect(res.status).toBe(200);
        expect(res.headers.get('Cache-Control')).toBe('no-store');
        const found = await res.json() as MentionSearchResponse;
        expect(found.groups.sessions).toHaveLength(1);
        expect(found.groups.skills).toEqual([]);
        expect(found.totals.skills).toBe(0);
        const references = await handle(new Request('http://localhost' + mixed, { headers }), address);
        expect(references.status).toBe(200);
        const body = await references.json() as MentionResolveResponse;
        expect(body.references[0]).toMatchObject({ kind: 'session', sessionId: 'visible-session' });
        expect(body.references[1]).toMatchObject({ kind: 'skill', unresolved: 'not_found' });
        expect(body.references[1].skillPath).toBeUndefined();
        expect(body.references[1].skillRuntime).toBeUndefined();
      }
    });
  });

  test('browser same-origin bootstrap token discovers skill over the daemon HTTP socket', async () => {
    await withTempDir(async (dir) => {
      const args: Parameters<typeof createServer> = [new KanbanStore(dir), 0];
      args[7] = '127.0.0.1';
      args[14] = () => token;
      const server = createServer(...args);
      const origin = `http://127.0.0.1:${server.port}`;
      try {
        const bootstrap = await fetch(origin + '/api/auth/token', { headers: { Origin: origin } });
        expect(bootstrap.status).toBe(200);
        const issued = await bootstrap.json() as { token: string };
        expect(issued.token).toBe(token);
        const response = await fetch(
          `${origin}/api/mentions?kind=skill&runtime=claude&projectDir=${encodeURIComponent(projectA)}`,
          { headers: { Origin: origin, Authorization: `Bearer ${issued.token}` } },
        );
        expect(response.status).toBe(200);
        expect(response.headers.get('Cache-Control')).toBe('no-store');
        const skills = (await response.json() as MentionSearchResponse).groups.skills;
        expect(skills.map((candidate) => candidate.id)).toContain('api-test');
      } finally {
        server.stop();
      }
    });
  });

  test('GET /api/mentions?kind=skill groups skills for the card runtime × directory', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      await store.createCard({ title: 'b', description: 'b', projectDir: projectB });
      const handleRequest = handler(store);

      const claude = await getJson<MentionSearchResponse>(
        handleRequest, `/api/mentions?kind=skill&limit=50&runtime=claude&projectDir=${encodeURIComponent(projectA)}`,
      );
      const byId = new Map(claude.groups.skills.map((candidate) => [candidate.id, candidate]));
      expect(byId.get('api-test')?.disabledReason).toBeUndefined();
      expect(byId.get('egm:egm-review')?.skill?.invocation).toBe('launch');
      expect(byId.get('b-only')?.disabledReason).toBe('other_project');
      expect(claude.totals.skills).toBe(claude.groups.skills.length);
      // 고를 수 있는 것이 먼저 온다.
      const firstDisabled = claude.groups.skills.findIndex((candidate) => candidate.disabledReason);
      expect(claude.groups.skills.slice(firstDisabled).every((candidate) => candidate.disabledReason)).toBe(true);

      const codex = await getJson<MentionSearchResponse>(
        handleRequest, `/api/mentions?kind=skill&limit=50&runtime=codex&projectDir=${encodeURIComponent(projectA)}`,
      );
      const codexIds = new Map(codex.groups.skills.map((candidate) => [candidate.id, candidate]));
      expect(codexIds.get('daily-health')?.disabledReason).toBeUndefined();
      expect(codexIds.get('api-test')?.disabledReason).toBe('runtime_mismatch');
    });
  });

  test('resolve: available, launch-only and wrong-runtime skill tokens', async () => {
    await withTempDir(async (dir) => {
      const handleRequest = handler(new KanbanStore(dir));
      const tokens = ['@skill:consensus', '@skill:egm:egm-review', '@skill:daily-health', '@skill:ghost']
        .map((token) => `token=${encodeURIComponent(token)}`).join('&');
      const body = await getJson<MentionResolveResponse>(
        handleRequest, `/api/mentions/resolve?${tokens}&runtime=claude&projectDir=${encodeURIComponent(projectA)}`,
      );
      const [consensus, egm, daily, ghost] = body.references;
      expect(consensus).toMatchObject({ kind: 'skill', skillRuntime: 'claude', skillScope: 'user', skillInvocation: 'model' });
      expect(consensus.unresolved).toBeUndefined();
      expect(egm).toMatchObject({ unresolved: 'unavailable', skillUnavailable: 'launch_only' });
      expect(daily).toMatchObject({ unresolved: 'unavailable', skillUnavailable: 'runtime_mismatch' });
      expect(ghost.unresolved).toBe('not_found');
    });
  });

  test('resolve: the launch line is checked against runtime and directory', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      await store.createCard({ title: 'b', description: 'b', projectDir: projectB });
      const handleRequest = handler(store);
      const launch = async (name: string, runtime: string, projectDir: string) => (await getJson<MentionResolveResponse>(
        handleRequest,
        `/api/mentions/resolve?launch=${encodeURIComponent(name)}&runtime=${runtime}&projectDir=${encodeURIComponent(projectDir)}`,
      )).launch;

      expect(await launch('egm:egm-review', 'claude', projectA)).toMatchObject({ ok: true, invocation: 'launch' });
      expect(await launch('ghost', 'claude', projectA)).toMatchObject({ ok: false, reason: 'not_found' });
      expect(await launch('b-only', 'claude', projectA)).toMatchObject({ ok: false, reason: 'other_project', projectDir: projectB });
      // 첫 줄 slash는 claude 문법 — codex에서는 주입되지 않는다(C9).
      expect(await launch('codex-consensus', 'codex', projectA)).toMatchObject({ ok: false, reason: 'runtime_mismatch' });
    });
  });
});
