import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  applyCodexServerMutation,
  copyCodexMcp,
  discoverCodexMcpInventory,
  moveCodexMcp,
  previewCopyCodexMcp,
  readCodexMcpInventory,
  removeCodexMcp,
  safeMutateCodexConfig,
} from '../core/codex-mcp-config';
import { readMcpInventory } from '../core/mcp-config-store';
import { withTempDir } from './setup';

const FULL_CONFIG = `# user model comment
model = "gpt-5.4"
model_reasoning_effort = "high"

[hooks]
enabled = true # preserve hook comment

[mcp_servers."stdio server"]
command = "npx"
args = ["-y", "@example/mcp"]
env_vars = ["LOCAL_TOKEN", { name = "REMOTE_TOKEN", source = "remote" }]
enabled = true
enabled_tools = ["read", "search"]
disabled_tools = ["write"]

[mcp_servers."stdio server".env]
API_URL = "https://example.test"

[mcp_servers.remote]
url = "https://mcp.example.test/mcp"
bearer_token_env_var = "MCP_TOKEN"
http_headers = { "X-Region" = "seoul" }
env_http_headers = { Authorization = "AUTH_HEADER" }
required = true

[skills]
enabled = true
`;

describe('readCodexMcpInventory', () => {
  test('reads stdio/http, env/env_vars, headers, tool policy, and quoted names', async () => {
    await withTempDir(async (dir) => {
      const configPath = join(dir, 'config.toml');
      writeFileSync(configPath, FULL_CONFIG);

      const items = await readCodexMcpInventory([], configPath);
      expect(items).toHaveLength(2);

      const stdio = items.find((item) => item.name === 'stdio server');
      expect(stdio?.identity).toBe('codex:stdio server');
      expect(stdio?.runtime).toBe('codex');
      expect(stdio?.def.type).toBe('stdio');
      expect(stdio?.def.env).toEqual({ API_URL: 'https://example.test' });
      expect(stdio?.def.envVars).toEqual([
        'LOCAL_TOKEN',
        { name: 'REMOTE_TOKEN', source: 'remote' },
      ]);
      expect(stdio?.def.enabledTools).toEqual(['read', 'search']);
      expect(stdio?.def.disabledTools).toEqual(['write']);

      const http = items.find((item) => item.name === 'remote');
      expect(http?.def.type).toBe('http');
      expect(http?.def.headers).toEqual({ 'X-Region': 'seoul' });
      expect(http?.def.envHttpHeaders).toEqual({ Authorization: 'AUTH_HEADER' });
      expect(http?.def.bearerTokenEnvVar).toBe('MCP_TOKEN');
      expect(http?.def.required).toBe(true);
    });
  });

  test('reads directory-scoped .codex/config.toml', async () => {
    await withTempDir(async (dir) => {
      const projectDir = join(dir, 'repo');
      mkdirSync(join(projectDir, '.codex'), { recursive: true });
      writeFileSync(
        join(projectDir, '.codex', 'config.toml'),
        '[mcp_servers.local]\ncommand = "node"\nargs = ["server.js"]\n',
      );

      const items = await readCodexMcpInventory(
        [{ dir: projectDir, scope: 'project' }],
        join(dir, 'missing-user.toml'),
      );
      expect(items[0].placements[0]).toMatchObject({
        runtime: 'codex',
        scope: 'project',
        dir: projectDir,
        location: join(projectDir, '.codex', 'config.toml'),
      });
    });
  });

  test('keeps same-name Claude and Codex identities distinct', async () => {
    await withTempDir(async (dir) => {
      const claudePath = join(dir, 'claude.json');
      const codexPath = join(dir, 'config.toml');
      writeFileSync(claudePath, '{"mcpServers":{"shared":{"command":"claude-mcp"}}}');
      writeFileSync(codexPath, '[mcp_servers.shared]\ncommand = "codex-mcp"\n');

      const claude = await readMcpInventory([], claudePath);
      const codex = await readCodexMcpInventory([], codexPath);
      expect(claude[0].identity).toBe('claude:shared');
      expect(codex[0].identity).toBe('codex:shared');
      expect(new Set([...claude, ...codex].map((item) => item.identity)).size).toBe(2);
    });
  });

  test('models user → project → subdirectory precedence with nearest definition effective', async () => {
    await withTempDir(async (dir) => {
      const userConfig = join(dir, 'user.toml');
      const repo = join(dir, 'repo');
      const packages = join(repo, 'packages');
      const current = join(packages, 'app');
      mkdirSync(join(repo, '.git'), { recursive: true });
      mkdirSync(join(repo, '.codex'), { recursive: true });
      mkdirSync(join(packages, '.codex'), { recursive: true });
      mkdirSync(current, { recursive: true });
      writeFileSync(
        userConfig,
        '[mcp_servers.shared]\ncommand = "user"\n[mcp_servers.user_only]\ncommand = "user-only"\n',
      );
      writeFileSync(
        join(repo, '.codex', 'config.toml'),
        '[mcp_servers.shared]\ncommand = "project"\n[mcp_servers.project_only]\ncommand = "project-only"\n',
      );
      writeFileSync(
        join(packages, '.codex', 'config.toml'),
        '[mcp_servers.shared]\ncommand = "nearest"\n[mcp_servers.sub_only]\ncommand = "sub-only"\n',
      );

      const result = await discoverCodexMcpInventory([{ dir: current }], userConfig);
      const shared = result.items.find((item) => item.name === 'shared');
      expect(shared?.def.command).toBe('nearest');
      expect(shared?.placements).toHaveLength(3);
      expect(shared?.placements.map((placement) => placement.scope)).toEqual([
        'user', 'project', 'local',
      ]);
      expect(shared?.placements.every((placement) => placement.runtime === 'codex')).toBe(true);
      expect(shared?.placements.every((placement) => placement.appliesToDir === current)).toBe(true);
      expect(shared?.placements.map((placement) => placement.effective)).toEqual([false, false, true]);
      expect(shared?.placements[0].overriddenBy).toBe(join(repo, '.codex', 'config.toml'));
      expect(shared?.placements[1].overriddenBy).toBe(join(packages, '.codex', 'config.toml'));
      expect(shared?.placements[2].definition?.command).toBe('nearest');
      expect(shared?.placements[2].configLayer).toBe('subdirectory');
      expect(shared?.placements[2].projectTrust).toBe('required-status-unknown');
      expect(result.items.map((item) => item.name).sort()).toEqual([
        'project_only', 'shared', 'sub_only', 'user_only',
      ]);
      expect(result.diagnostics.projectTrust).toEqual({
        required: true,
        status: 'unknown',
        configPaths: [
          join(repo, '.codex', 'config.toml'),
          join(packages, '.codex', 'config.toml'),
        ],
      });
    });
  });

  test('discovers multiple registered directories with their actual config paths', async () => {
    await withTempDir(async (dir) => {
      const repo = join(dir, 'repo');
      const first = join(repo, 'first');
      const second = join(repo, 'second', 'nested');
      mkdirSync(join(repo, '.git'), { recursive: true });
      mkdirSync(join(first, '.codex'), { recursive: true });
      mkdirSync(join(second, '.codex'), { recursive: true });
      writeFileSync(join(first, '.codex', 'config.toml'), '[mcp_servers.first]\ncommand = "first"\n');
      writeFileSync(join(second, '.codex', 'config.toml'), '[mcp_servers.second]\ncommand = "second"\n');

      const result = await discoverCodexMcpInventory(
        [{ dir: second }, { dir: first }],
        join(dir, 'missing-user.toml'),
      );
      const firstItem = result.items.find((item) => item.name === 'first');
      const secondItem = result.items.find((item) => item.name === 'second');
      expect(firstItem?.placements[0]).toMatchObject({
        location: join(first, '.codex', 'config.toml'),
        dir: first,
        appliesToDir: first,
        runtime: 'codex',
      });
      expect(secondItem?.placements[0]).toMatchObject({
        location: join(second, '.codex', 'config.toml'),
        dir: second,
        appliesToDir: second,
        runtime: 'codex',
      });
    });
  });

  test('continues past malformed user and intermediate TOML layers', async () => {
    await withTempDir(async (dir) => {
      const userConfig = join(dir, 'user.toml');
      const repo = join(dir, 'repo');
      const badDir = join(repo, 'bad');
      const current = join(badDir, 'current');
      mkdirSync(join(repo, '.git'), { recursive: true });
      mkdirSync(join(repo, '.codex'), { recursive: true });
      mkdirSync(join(badDir, '.codex'), { recursive: true });
      mkdirSync(join(current, '.codex'), { recursive: true });
      writeFileSync(userConfig, '[mcp_servers.invalid\ncommand =');
      writeFileSync(join(repo, '.codex', 'config.toml'), '[mcp_servers.root]\ncommand = "root"\n');
      writeFileSync(join(badDir, '.codex', 'config.toml'), 'not = [valid');
      writeFileSync(join(current, '.codex', 'config.toml'), '[mcp_servers.nearest]\ncommand = "near"\n');

      const result = await discoverCodexMcpInventory([{ dir: current }], userConfig);
      expect(result.items.map((item) => item.name).sort()).toEqual(['nearest', 'root']);
      expect(result.diagnostics.issues).toHaveLength(2);
      expect(result.diagnostics.issues.every((issue) => issue.code === 'invalid-config')).toBe(true);
      expect(result.diagnostics.scannedConfigPaths).toContain(join(repo, '.codex', 'config.toml'));
      expect(result.diagnostics.scannedConfigPaths).toContain(join(current, '.codex', 'config.toml'));
    });
  });

  test('treats missing TOML layers as empty without creating scan errors', async () => {
    await withTempDir(async (dir) => {
      const target = join(dir, 'repo');
      mkdirSync(join(target, '.git'), { recursive: true });
      const result = await discoverCodexMcpInventory(
        [{ dir: target }],
        join(dir, 'missing-user.toml'),
      );
      expect(result.items).toEqual([]);
      expect(result.diagnostics.issues).toEqual([]);
      expect(result.diagnostics.candidateConfigPaths).toEqual([
        join(dir, 'missing-user.toml'),
        join(target, '.codex', 'config.toml'),
      ]);
    });
  });
});

describe('Codex TOML surgical writer', () => {
  test('changes one server while preserving non-MCP TOML comments and order', () => {
    const changed = applyCodexServerMutation(FULL_CONFIG, 'stdio server', {
      command: 'bunx',
      args: ['new-mcp'],
      env: { API_URL: 'https://new.example.test' },
      enabled: false,
      enabledTools: ['read'],
    });

    expect(changed).toContain('# user model comment\nmodel = "gpt-5.4"');
    expect(changed).toContain('[hooks]\nenabled = true # preserve hook comment');
    expect(changed).toContain('[skills]\nenabled = true');
    expect(changed.indexOf('[hooks]')).toBeLessThan(changed.indexOf('[mcp_servers."stdio server"]'));
    expect(changed.indexOf('[mcp_servers.remote]')).toBeLessThan(changed.indexOf('[skills]'));
    expect(changed).toContain('command = "bunx"');
    expect(changed).toContain('enabled = false');
    expect(Bun.TOML.parse(changed)).toBeDefined();
  });

  test('removes only the selected server and its child tables', () => {
    const changed = applyCodexServerMutation(FULL_CONFIG, 'stdio server', null);
    const parsed = Bun.TOML.parse(changed) as {
      mcp_servers: Record<string, unknown>;
      skills: { enabled: boolean };
    };
    expect(parsed.mcp_servers['stdio server']).toBeUndefined();
    expect(parsed.mcp_servers.remote).toBeDefined();
    expect(parsed.skills.enabled).toBe(true);
  });

  test('copies to a directory config without rewriting existing non-MCP content', async () => {
    await withTempDir(async (dir) => {
      const projectDir = join(dir, 'repo');
      const configPath = join(projectDir, '.codex', 'config.toml');
      mkdirSync(join(projectDir, '.codex'), { recursive: true });
      writeFileSync(configPath, 'model = "gpt-5.4" # keep\n\n[features]\napps = true\n');

      await copyCodexMcp(
        'quoted.name',
        { url: 'https://example.test/mcp', type: 'http', headers: { Authorization: 'env:MCP' } },
        'project',
        { ts: 'copy', backupDir: join(dir, 'backups'), projectDir },
        true,
      );

      const written = readFileSync(configPath, 'utf8');
      expect(written).toStartWith('model = "gpt-5.4" # keep\n\n[features]\napps = true\n');
      expect(written).toContain('[mcp_servers."quoted.name"]');
      expect(Bun.TOML.parse(written)).toBeDefined();
    });
  });

  test('previews an empty mcp_servers table without writing and preserves non-MCP TOML', async () => {
    await withTempDir(async (dir) => {
      const projectDir = join(dir, 'repo');
      const configPath = join(projectDir, '.codex', 'config.toml');
      mkdirSync(join(projectDir, '.codex'), { recursive: true });
      const before = '# keep\nmodel = "gpt-5.4"\n\n[mcp_servers]\n\n[features]\napps = true\n';
      writeFileSync(configPath, before);

      const [change] = previewCopyCodexMcp(
        'quoted server',
        { command: 'node', args: ['server.js'] },
        'project',
        { ts: 'preview', backupDir: join(dir, 'backups'), projectDir },
      );

      expect(readFileSync(configPath, 'utf8')).toBe(before);
      expect(change.before).toBe(before);
      expect(change.after).toContain('[mcp_servers."quoted server"]');
      expect(change.after).toContain('[features]\napps = true');
      expect(Bun.TOML.parse(change.after)).toBeDefined();
    });
  });

  test('moves user to directory config and keeps distinct backups for both files', async () => {
    await withTempDir(async (dir) => {
      const userConfig = join(dir, 'user-config.toml');
      const projectDir = join(dir, 'repo');
      const projectConfig = join(projectDir, '.codex', 'config.toml');
      const backupDir = join(dir, 'backups');
      mkdirSync(join(projectDir, '.codex'), { recursive: true });
      writeFileSync(userConfig, 'model = "user"\n\n[mcp_servers.move_me]\ncommand = "node"\n');
      writeFileSync(projectConfig, 'model = "project"\n');

      await moveCodexMcp(
        'move_me',
        { command: 'node', type: 'stdio' },
        'user',
        undefined,
        'project',
        { ts: 'move', backupDir, configPath: userConfig, projectDir },
      );

      expect(readFileSync(userConfig, 'utf8')).toBe('model = "user"\n\n');
      expect(readFileSync(projectConfig, 'utf8')).toContain('model = "project"\n');
      expect(readFileSync(projectConfig, 'utf8')).toContain('[mcp_servers."move_me"]');
      expect(readFileSync(join(backupDir, 'config.toml.move.bak'), 'utf8')).toBe('model = "project"\n');
      expect(readFileSync(join(backupDir, 'config.toml.move.source.bak'), 'utf8'))
        .toContain('[mcp_servers.move_me]');
    });
  });

  test('rolls back the destination when source removal fails', async () => {
    await withTempDir(async (dir) => {
      const userConfig = join(dir, 'user-config.toml');
      const projectDir = join(dir, 'repo');
      const projectConfig = join(projectDir, '.codex', 'config.toml');
      mkdirSync(join(projectDir, '.codex'), { recursive: true });
      writeFileSync(userConfig, 'not = [valid');
      writeFileSync(projectConfig, 'model = "project"\n');

      await expect(moveCodexMcp(
        'move_me', { command: 'node' }, 'user', undefined, 'project',
        { ts: 'rollback', backupDir: join(dir, 'backups'), configPath: userConfig, projectDir },
      )).rejects.toThrow('Invalid TOML');
      expect(readFileSync(projectConfig, 'utf8')).toBe('model = "project"\n');
    });
  });
});

describe('safeMutateCodexConfig', () => {
  test('creates a backup and writes atomically', async () => {
    await withTempDir(async (dir) => {
      const configPath = join(dir, 'config.toml');
      const backupDir = join(dir, 'backups');
      writeFileSync(configPath, FULL_CONFIG);

      await safeMutateCodexConfig('remote', (current) => ({
        ...current!,
        enabled: false,
      }), { ts: 'backup-ts', backupDir, configPath });

      expect(readFileSync(join(backupDir, 'config.toml.backup-ts.bak'), 'utf8')).toBe(FULL_CONFIG);
      expect(existsSync(`${configPath}.tmp`)).toBe(false);
      const item = (await readCodexMcpInventory([], configPath)).find((entry) => entry.name === 'remote');
      expect(item?.def.enabled).toBe(false);
    });
  });

  test('detects a concurrent write and reapplies on the latest TOML', async () => {
    await withTempDir(async (dir) => {
      const configPath = join(dir, 'config.toml');
      const backupDir = join(dir, 'backups');
      writeFileSync(configPath, '[mcp_servers.ours]\ncommand = "old"\n');
      let calls = 0;

      const result = await safeMutateCodexConfig('ours', (current) => {
        calls++;
        if (calls === 1) {
          writeFileSync(
            configPath,
            'model = "external"\n\n[mcp_servers.ours]\ncommand = "old"\n',
          );
        }
        return { ...current!, command: 'new' };
      }, { ts: 'retry', backupDir, configPath, maxRetries: 3 });

      expect(calls).toBeGreaterThan(1);
      expect(result.after).toContain('model = "external"');
      expect(result.after).toContain('command = "new"');
    });
  });

  test('throws CONFLICT_409 when the file never stabilizes', async () => {
    await withTempDir(async (dir) => {
      const configPath = join(dir, 'config.toml');
      writeFileSync(configPath, '[mcp_servers.ours]\ncommand = "old"\n');
      let writeNo = 0;
      let error: unknown;
      try {
        await safeMutateCodexConfig('ours', (current) => {
          writeNo++;
          writeFileSync(configPath, `external = ${writeNo}\n[mcp_servers.ours]\ncommand = "old"\n`);
          return current;
        }, { ts: 'conflict', backupDir: join(dir, 'backups'), configPath, maxRetries: 1 });
      } catch (caught) {
        error = caught;
      }
      expect((error as { code?: string }).code).toBe('CONFLICT_409');
    });
  });

  test('remove keeps a backup and all unrelated tables', async () => {
    await withTempDir(async (dir) => {
      const configPath = join(dir, 'config.toml');
      const backupDir = join(dir, 'backups');
      writeFileSync(configPath, FULL_CONFIG);
      await removeCodexMcp('remote', 'user', { ts: 'remove', backupDir, configPath });
      expect(readFileSync(configPath, 'utf8')).toContain('[skills]\nenabled = true');
      expect(readFileSync(join(backupDir, 'config.toml.remove.bak'), 'utf8')).toBe(FULL_CONFIG);
    });
  });
});
