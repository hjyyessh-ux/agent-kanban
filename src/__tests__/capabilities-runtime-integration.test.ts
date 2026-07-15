import { describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PlacementTargetsStore } from '../core/placement-targets-store';
import { readAllMcpInventoryWithDiagnostics } from '../core/mcp-runtime-adapter';
import { SkillRootsStore } from '../core/skill-roots-store';
import { SkillStore } from '../core/skill-store';
import { withTempDir } from './setup';

describe('Capabilities isolated HOME/KANBAN_DATA_DIR integration', () => {
  test('merges Claude/Codex MCP and every Skill runtime without reading real user files', async () => {
    await withTempDir(async (fixture) => {
      const home = join(fixture, 'home');
      const dataDir = join(fixture, 'kanban-data');
      const repo = join(home, 'repo');
      const current = join(repo, 'packages', 'app');
      const claudeJson = join(home, '.claude.json');
      const codexUser = join(home, '.codex', 'config.toml');
      mkdirSync(join(home, '.codex'), { recursive: true });
      mkdirSync(join(repo, '.git'), { recursive: true });
      mkdirSync(join(repo, '.codex'), { recursive: true });
      mkdirSync(join(current, '.codex'), { recursive: true });
      mkdirSync(dataDir, { recursive: true });
      writeFileSync(claudeJson, JSON.stringify({
        mcpServers: { shared: { command: 'claude', alwaysLoad: true } },
      }));
      writeFileSync(codexUser, '[mcp_servers.shared]\ncommand = "codex-user"\n');
      writeFileSync(join(repo, '.codex', 'config.toml'), '[mcp_servers.shared]\ncommand = "codex-project"\n');
      writeFileSync(join(current, '.codex', 'config.toml'), '[mcp_servers.shared]\ncommand = "codex-nearest"\n');

      const roots = ['claude', 'codex', 'opencode'].map((runtime) => {
        const root = join(home, 'skills', runtime);
        const skillDir = join(root, `${runtime}-fixture`);
        mkdirSync(skillDir, { recursive: true });
        writeFileSync(join(skillDir, 'SKILL.md'), `---\nname: ${runtime}-fixture\ndescription: ${runtime}\n---\n`);
        return {
          id: runtime, dir: root, agent: runtime as 'claude' | 'codex' | 'opencode',
          source: `${runtime}-user`, enabled: true,
        };
      });
      writeFileSync(join(dataDir, 'skill-roots.json'), JSON.stringify({
        version: 1, roots, lastModified: new Date().toISOString(),
      }));

      const targets = new PlacementTargetsStore(dataDir);
      await targets.addTarget({
        label: 'Codex current', dir: current, kind: 'local', runtime: 'codex', teamShared: false,
      });
      const inventory = await readAllMcpInventoryWithDiagnostics(await targets.getTargets(), {
        claudeJsonPath: claudeJson,
        codexUserConfigPath: codexUser,
      });
      const skillRoots = new SkillRootsStore(dataDir);
      const skills = new SkillStore(dataDir);
      await skills.sync(await skillRoots.getRoots());
      const discoveredSkills = await skills.getSkills();

      expect(inventory.items.filter((item) => item.name === 'shared').map((item) => item.identity).sort())
        .toEqual(['claude:shared', 'codex:shared']);
      expect(inventory.items.find((item) => item.identity === 'codex:shared')?.def.command)
        .toBe('codex-nearest');
      expect(inventory.items.find((item) => item.identity === 'codex:shared')?.placements)
        .toHaveLength(3);
      expect(discoveredSkills.map((skill) => skill.runtime).sort())
        .toEqual(['claude', 'codex', 'opencode']);
      expect(inventory.diagnostics.codex.projectTrust.status).toBe('unknown');
    });
  });
});
