import { describe, expect, test } from 'bun:test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { KanbanStore } from '../core/store';
import { PlacementTargetsStore } from '../core/placement-targets-store';
import { SkillStore } from '../core/skill-store';
import { readAllMcpInventoryWithDiagnostics } from '../core/mcp-runtime-adapter';
import type {
  ContextDiagnostics,
  DiscoveredSkill,
  McpInventoryItem,
  PlacementTarget,
} from '../core/types';
import { createRouteHandler, type ScopeMcpInventoryFn } from '../server/routes';
import { withTempDir } from './setup';

function createInventoryHandler(
  store: KanbanStore,
  skillStore: SkillStore,
  placementTargetsStore: PlacementTargetsStore,
  scopeMcpInventoryFn: ScopeMcpInventoryFn,
) {
  return createRouteHandler(
    store,
    undefined, // dispatchFn
    undefined, // schedulerStore
    undefined, // schedulerEngine
    undefined, // settingsStore
    undefined, // onNetworkSettingChange
    undefined, // scriptStore
    undefined, // modelsFn
    undefined, // questionMonitor
    undefined, // aggregateSessionsFn
    undefined, // localPeerSessionsFn
    undefined, // peerTokenFn
    undefined, // runtimeCatalogFn
    undefined, // wikiWorker
    skillStore,
    undefined, // skillRootsStore
    placementTargetsStore,
    undefined, // runtimeRunStore
    scopeMcpInventoryFn,
  );
}

async function seedSkills(dataDir: string): Promise<DiscoveredSkill[]> {
  const skills: DiscoveredSkill[] = [
    {
      id: 'claude-skill', runtime: 'claude', kind: 'claude_skill',
      skillName: 'claude-skill', displayName: '/claude-skill', description: 'Claude',
      source: 'claude-user', directory: '/tmp/claude-skill', scope: 'user',
    },
    {
      id: 'skills:codex-skill', runtime: 'codex', kind: 'codex_skill',
      skillName: 'codex-skill', displayName: '$codex-skill', description: 'Codex',
      source: 'codex-user', directory: '/tmp/codex-skill', scope: 'user',
    },
    {
      id: 'open-skill', runtime: 'opencode', kind: 'opencode_skill',
      skillName: 'open-skill', displayName: '/open-skill', description: 'Opencode',
      source: 'opencode-user', directory: '/tmp/open-skill', scope: 'user',
    },
  ];
  await Bun.write(join(dataDir, 'skills.json'), JSON.stringify({
    version: 1,
    skills,
    lastSyncedAt: '2026-01-01T00:00:00.000Z',
  }));
  return skills;
}

describe('GET /api/scope/inventory runtime-aware discovery', () => {
  test('returns Claude and Codex MCP chains plus every existing Skill runtime', async () => {
    await withTempDir(async (dir) => {
      const dataDir = join(dir, 'data');
      const repo = join(dir, 'repo');
      const current = join(repo, 'packages', 'app');
      const claudePath = join(dir, 'claude.json');
      const codexUserPath = join(dir, 'codex-user.toml');
      mkdirSync(dataDir, { recursive: true });
      mkdirSync(join(repo, '.git'), { recursive: true });
      mkdirSync(join(repo, '.codex'), { recursive: true });
      mkdirSync(join(current, '.codex'), { recursive: true });
      writeFileSync(claudePath, JSON.stringify({
        mcpServers: {
          shared: { command: 'claude-shared' },
          'claude-only': { command: 'claude-only', alwaysLoad: true },
        },
      }));
      writeFileSync(codexUserPath, '[mcp_servers.shared]\ncommand = "codex-user"\n');
      writeFileSync(
        join(repo, '.codex', 'config.toml'),
        '[mcp_servers.root_only]\ncommand = "root"\n',
      );
      writeFileSync(
        join(current, '.codex', 'config.toml'),
        '[mcp_servers.shared]\ncommand = "codex-nearest"\n',
      );

      const store = new KanbanStore(dataDir);
      const skillStore = new SkillStore(dataDir);
      const targetsStore = new PlacementTargetsStore(dataDir);
      const seededSkills = await seedSkills(dataDir);
      const codexTarget = await targetsStore.addTarget({
        label: 'Codex current',
        dir: current,
        kind: 'local',
        runtime: 'codex',
        teamShared: false,
      });
      const inventoryFn: ScopeMcpInventoryFn = (targets) =>
        readAllMcpInventoryWithDiagnostics(targets, {
          claudeJsonPath: claudePath,
          codexUserConfigPath: codexUserPath,
        });
      const { handleRequest } = createInventoryHandler(
        store, skillStore, targetsStore, inventoryFn,
      );

      const response = await handleRequest(new Request('http://localhost/api/scope/inventory'));
      expect(response.status).toBe(200);
      const body = await response.json() as {
        mcp: McpInventoryItem[];
        skills: DiscoveredSkill[];
        diagnostics: ContextDiagnostics;
      };

      expect(body.mcp.filter((item) => item.name === 'shared').map((item) => item.identity).sort())
        .toEqual(['claude:shared', 'codex:shared']);
      const claudeShared = body.mcp.find((item) => item.identity === 'claude:shared');
      expect(claudeShared?.placements[0]).toMatchObject({
        runtime: 'claude', scope: 'user', location: claudePath,
      });
      const codexShared = body.mcp.find((item) => item.identity === 'codex:shared');
      expect(codexShared?.def.command).toBe('codex-nearest');
      expect(codexShared?.placements.find((placement) => placement.effective)).toMatchObject({
        runtime: 'codex',
        location: join(current, '.codex', 'config.toml'),
        dir: current,
        appliesToDir: current,
        configLayer: 'subdirectory',
        projectTrust: 'required-status-unknown',
      });
      expect(body.skills.map((skill) => skill.runtime)).toEqual(
        seededSkills.map((skill) => skill.runtime),
      );
      expect(body.skills.map((skill) => skill.id)).toEqual(seededSkills.map((skill) => skill.id));
      // These legacy diagnostics remain Claude-only even with Codex user MCP present.
      expect(body.diagnostics.userScopeMcpCount).toBe(2);
      expect(body.diagnostics.alwaysLoadCount).toBe(1);
      expect(body.diagnostics.mcpDiscovery?.codex.projectTrust).toMatchObject({
        required: true,
        status: 'unknown',
      });

      const targetsResponse = await handleRequest(new Request('http://localhost/api/scope/targets'));
      const targets = await targetsResponse.json() as PlacementTarget[];
      expect(targets.find((target) => target.id === codexTarget.id)).toMatchObject({
        runtime: 'codex', dir: current, kind: 'local',
      });

      const addedDir = join(repo, 'another-target');
      mkdirSync(addedDir, { recursive: true });
      const addTargetResponse = await handleRequest(new Request(
        'http://localhost/api/scope/targets',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            label: 'Codex project',
            dir: addedDir,
            kind: 'project',
            runtime: 'codex',
            teamShared: true,
          }),
        },
      ));
      expect(addTargetResponse.status).toBe(201);
      expect(await addTargetResponse.json()).toMatchObject({
        runtime: 'codex', dir: addedDir, kind: 'project', teamShared: true,
      });
    });
  });

  test('malformed Codex config does not hide Claude MCP or Skill inventory', async () => {
    await withTempDir(async (dir) => {
      const dataDir = join(dir, 'data');
      const repo = join(dir, 'repo');
      const claudePath = join(dir, 'claude.json');
      const codexUserPath = join(dir, 'codex-user.toml');
      mkdirSync(dataDir, { recursive: true });
      mkdirSync(join(repo, '.git'), { recursive: true });
      mkdirSync(join(repo, '.codex'), { recursive: true });
      writeFileSync(claudePath, JSON.stringify({
        mcpServers: { stable: { command: 'claude-stable', alwaysLoad: true } },
      }));
      writeFileSync(codexUserPath, '[mcp_servers.invalid\ncommand =');
      writeFileSync(join(repo, '.codex', 'config.toml'), 'invalid = [toml');

      const store = new KanbanStore(dataDir);
      const skillStore = new SkillStore(dataDir);
      const targetsStore = new PlacementTargetsStore(dataDir);
      const seededSkills = await seedSkills(dataDir);
      await targetsStore.addTarget({
        label: 'Broken Codex repo', dir: repo, kind: 'project',
        runtime: 'codex', teamShared: true,
      });
      const { handleRequest } = createInventoryHandler(
        store,
        skillStore,
        targetsStore,
        (targets) => readAllMcpInventoryWithDiagnostics(targets, {
          claudeJsonPath: claudePath,
          codexUserConfigPath: codexUserPath,
        }),
      );

      const response = await handleRequest(new Request('http://localhost/api/scope/inventory'));
      expect(response.status).toBe(200);
      const body = await response.json() as {
        mcp: McpInventoryItem[];
        skills: DiscoveredSkill[];
        diagnostics: ContextDiagnostics;
      };
      expect(body.mcp.map((item) => item.identity)).toEqual(['claude:stable']);
      expect(body.skills.map((skill) => skill.id)).toEqual(seededSkills.map((skill) => skill.id));
      expect(body.diagnostics.userScopeMcpCount).toBe(1);
      expect(body.diagnostics.alwaysLoadCount).toBe(1);
      expect(body.diagnostics.mcpDiscovery?.codex.issues).toHaveLength(2);
    });
  });
});

describe('runtime-aware MCP mutation routes', () => {
  test('Codex preview is read-only and apply changes only the selected runtime target', async () => {
    await withTempDir(async (dir) => {
      const dataDir = join(dir, 'data');
      const claudePath = join(dir, 'claude.json');
      const codexUserPath = join(dir, 'codex-user.toml');
      const sourceDir = join(dir, 'source');
      const targetDir = join(dir, 'target');
      mkdirSync(dataDir, { recursive: true });
      mkdirSync(join(sourceDir, '.codex'), { recursive: true });
      mkdirSync(join(targetDir, '.codex'), { recursive: true });
      writeFileSync(claudePath, '{"mcpServers":{"shared":{"command":"claude"}}}\n');
      writeFileSync(codexUserPath, 'model = "user"\n');
      writeFileSync(join(sourceDir, '.codex', 'config.toml'), '[mcp_servers.shared]\ncommand = "codex"\n\n[mcp_servers.shared.env]\nTOKEN = "sk-abcdefghijklmnopqrstuvwxyz1234567890abcdefgh"\n');
      const targetBefore = 'model = "target" # preserve\n';
      writeFileSync(join(targetDir, '.codex', 'config.toml'), targetBefore);

      const store = new KanbanStore(dataDir);
      const skillStore = new SkillStore(dataDir);
      const targetsStore = new PlacementTargetsStore(dataDir);
      await targetsStore.addTarget({
        label: 'Codex source', dir: sourceDir, kind: 'project', runtime: 'codex', teamShared: false,
      });
      const target = await targetsStore.addTarget({
        label: 'Codex target', dir: targetDir, kind: 'project', runtime: 'codex', teamShared: true,
      });
      const inventoryFn: ScopeMcpInventoryFn = (targets) => readAllMcpInventoryWithDiagnostics(targets, {
        claudeJsonPath: claudePath,
        codexUserConfigPath: codexUserPath,
      });
      const inventory = await inventoryFn(await targetsStore.getTargets());
      const codex = inventory.items.find((item) => item.identity === 'codex:shared')!;
      const sourcePlacement = codex.placements.find((placement) => placement.location.includes(sourceDir))!;
      const { handleRequest } = createInventoryHandler(store, skillStore, targetsStore, inventoryFn);
      const body = {
        runtime: 'codex',
        inventoryIdentity: codex.identity,
        sourcePlacementIdentity: sourcePlacement.identity,
        targetId: target.id,
        toScope: 'project',
      };

      const preview = await handleRequest(new Request('http://localhost/api/scope/mcp/shared/copy?preview=1', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      }));
      expect(preview.status).toBe(409);
      expect(await preview.json()).toMatchObject({ secretWarning: true });
      expect(readFileSync(join(targetDir, '.codex', 'config.toml'), 'utf8')).toBe(targetBefore);

      const confirmedBody = { ...body, forceSecret: true };
      const confirmedPreview = await handleRequest(new Request('http://localhost/api/scope/mcp/shared/copy?preview=1', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(confirmedBody),
      }));
      expect(confirmedPreview.status).toBe(200);
      expect(readFileSync(join(targetDir, '.codex', 'config.toml'), 'utf8')).toBe(targetBefore);
      expect(readFileSync(claudePath, 'utf8')).toContain('"command":"claude"');

      const apply = await handleRequest(new Request('http://localhost/api/scope/mcp/shared/copy', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(confirmedBody),
      }));
      expect(apply.status).toBe(200);
      expect(readFileSync(join(targetDir, '.codex', 'config.toml'), 'utf8')).toContain('command = "codex"');
      expect(readFileSync(join(targetDir, '.codex', 'config.toml'), 'utf8')).toContain('model = "target" # preserve');
      expect(readFileSync(claudePath, 'utf8')).toContain('"command":"claude"');
    });
  });
});
