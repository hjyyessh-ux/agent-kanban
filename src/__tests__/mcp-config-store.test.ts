import { describe, test, expect } from 'bun:test';
import { join } from 'node:path';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import {
  readMcpInventory,
  detectPlaintextSecret,
  safeMutateClaudeJson,
  copyMcp,
  moveMcp,
  removeMcp,
} from '../core/mcp-config-store';
import { withTempDir } from './setup';

// ── detectPlaintextSecret ────────────────────────────────────────

describe('detectPlaintextSecret', () => {
  test('returns false for clean stdio definition', () => {
    expect(detectPlaintextSecret({ command: 'npx', args: ['-y', 'my-server'] })).toBe(false);
  });

  test('detects sk- prefix in env value', () => {
    expect(detectPlaintextSecret({ env: { API_KEY: 'sk-abc123def456789012345678901234567890' } })).toBe(true);
  });

  test('detects AKIA prefix (AWS key) in env value', () => {
    expect(detectPlaintextSecret({ env: { AWS_ACCESS_KEY_ID: 'AKIAIOSFODNN7EXAMPLE' } })).toBe(true);
  });

  test('detects long token (40+ chars) in env value', () => {
    expect(
      detectPlaintextSecret({ env: { TOKEN: 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEF' } }),
    ).toBe(true);
  });

  test('ignores short env values', () => {
    expect(detectPlaintextSecret({ env: { PORT: '3000', HOST: 'localhost' } })).toBe(false);
  });

  test('detects embedded URL credentials', () => {
    expect(detectPlaintextSecret({ url: 'https://user:password@example.com/api' })).toBe(true);
  });

  test('ignores URL without credentials', () => {
    expect(detectPlaintextSecret({ url: 'https://example.com/api' })).toBe(false);
  });

  test('detects auth header with token', () => {
    expect(
      detectPlaintextSecret({ headers: { Authorization: 'Bearer sk-abc123def456789012345678901234567890' } }),
    ).toBe(true);
  });

  test('ignores non-auth header with long value', () => {
    expect(
      detectPlaintextSecret({ headers: { 'Content-Type': 'application/json; charset=utf-8 boundary=something-long' } }),
    ).toBe(false);
  });
});

// ── readMcpInventory ─────────────────────────────────────────────

describe('readMcpInventory', () => {
  test('returns [] when claude.json does not exist', async () => {
    await withTempDir(async (dir) => {
      const claudeJsonPath = join(dir, 'nonexistent.json');
      const items = await readMcpInventory([], claudeJsonPath);
      expect(items).toEqual([]);
    });
  });

  test('parses user-scope mcpServers from claude.json', async () => {
    await withTempDir(async (dir) => {
      const claudeJsonPath = join(dir, 'claude.json');
      writeFileSync(
        claudeJsonPath,
        JSON.stringify({
          mcpServers: {
            'my-server': { command: 'npx', args: ['-y', 'my-server'] },
          },
        }),
      );

      const items = await readMcpInventory([], claudeJsonPath);
      expect(items).toHaveLength(1);
      expect(items[0].name).toBe('my-server');
      expect(items[0].placements).toHaveLength(1);
      expect(items[0].placements[0].scope).toBe('user');
      expect(items[0].placements[0].location).toBe(claudeJsonPath);
      expect(items[0].placements[0].alwaysLoad).toBe(false);
      expect(items[0].placements[0].managed).toBe(false);
    });
  });

  test('parses local-scope from claude.json projects[dir].mcpServers', async () => {
    await withTempDir(async (dir) => {
      const claudeJsonPath = join(dir, 'claude.json');
      writeFileSync(
        claudeJsonPath,
        JSON.stringify({
          projects: {
            '/my/project': {
              mcpServers: {
                'local-server': { command: 'node', args: ['server.js'] },
              },
            },
          },
        }),
      );

      const items = await readMcpInventory([], claudeJsonPath);
      expect(items).toHaveLength(1);
      expect(items[0].name).toBe('local-server');
      expect(items[0].placements[0].scope).toBe('local');
      // dir must carry the projects[dir] key so move/remove/freeze can target the source.
      expect(items[0].placements[0].dir).toBe('/my/project');
    });
  });

  test('parses project-scope from .mcp.json in project dirs', async () => {
    await withTempDir(async (dir) => {
      const claudeJsonPath = join(dir, 'claude.json');
      writeFileSync(claudeJsonPath, JSON.stringify({}));

      const projectDir = join(dir, 'myrepo');
      mkdirSync(projectDir);
      writeFileSync(
        join(projectDir, '.mcp.json'),
        JSON.stringify({
          mcpServers: {
            'repo-server': { command: 'npx', args: ['repo-mcp'] },
          },
        }),
      );

      const items = await readMcpInventory([projectDir], claudeJsonPath);
      expect(items).toHaveLength(1);
      expect(items[0].name).toBe('repo-server');
      expect(items[0].placements[0].scope).toBe('project');
      expect(items[0].placements[0].location).toBe(join(projectDir, '.mcp.json'));
      expect(items[0].placements[0].dir).toBe(projectDir);
    });
  });

  test('merges placements across scopes for same server name', async () => {
    await withTempDir(async (dir) => {
      const claudeJsonPath = join(dir, 'claude.json');
      writeFileSync(
        claudeJsonPath,
        JSON.stringify({
          mcpServers: {
            'shared-server': { command: 'npx', args: ['shared'] },
          },
        }),
      );

      const projectDir = join(dir, 'myrepo');
      mkdirSync(projectDir);
      writeFileSync(
        join(projectDir, '.mcp.json'),
        JSON.stringify({
          mcpServers: {
            'shared-server': { command: 'npx', args: ['shared'] },
          },
        }),
      );

      const items = await readMcpInventory([projectDir], claudeJsonPath);
      expect(items).toHaveLength(1);
      expect(items[0].name).toBe('shared-server');
      expect(items[0].placements).toHaveLength(2);
      const scopes = items[0].placements.map((p) => p.scope).sort();
      expect(scopes).toEqual(['project', 'user']);
    });
  });

  test('sets alwaysLoad flag and preloadReason', async () => {
    await withTempDir(async (dir) => {
      const claudeJsonPath = join(dir, 'claude.json');
      writeFileSync(
        claudeJsonPath,
        JSON.stringify({
          mcpServers: {
            'always-server': { command: 'npx', args: ['always'], alwaysLoad: true },
          },
        }),
      );

      const items = await readMcpInventory([], claudeJsonPath);
      expect(items[0].placements[0].alwaysLoad).toBe(true);
      expect(items[0].preloadReason).toBe('alwaysLoad');
    });
  });

  test('detects plaintext secret in server definition', async () => {
    await withTempDir(async (dir) => {
      const claudeJsonPath = join(dir, 'claude.json');
      writeFileSync(
        claudeJsonPath,
        JSON.stringify({
          mcpServers: {
            'secret-server': {
              command: 'npx',
              args: ['secret-mcp'],
              env: { API_KEY: 'sk-abc123def456789012345678901234567890' },
            },
          },
        }),
      );

      const items = await readMcpInventory([], claudeJsonPath);
      expect(items[0].placements[0].hasPlaintextSecret).toBe(true);
    });
  });

  test('gracefully handles malformed claude.json', async () => {
    await withTempDir(async (dir) => {
      const claudeJsonPath = join(dir, 'claude.json');
      writeFileSync(claudeJsonPath, '{ invalid json }');
      const items = await readMcpInventory([], claudeJsonPath);
      expect(items).toEqual([]);
    });
  });

  test('gracefully ignores missing .mcp.json in project dir', async () => {
    await withTempDir(async (dir) => {
      const claudeJsonPath = join(dir, 'claude.json');
      writeFileSync(claudeJsonPath, JSON.stringify({}));
      const items = await readMcpInventory(['/nonexistent/dir'], claudeJsonPath);
      expect(items).toEqual([]);
    });
  });
});

// ── safeMutateClaudeJson (CAS engine) ────────────────────────────

describe('safeMutateClaudeJson', () => {
  test('applies mutator and returns before/after content', async () => {
    await withTempDir(async (dir) => {
      const claudeJsonPath = join(dir, 'claude.json');
      const backupDir = join(dir, 'backups');
      writeFileSync(claudeJsonPath, JSON.stringify({ mcpServers: { a: { command: 'a' } } }));

      const result = await safeMutateClaudeJson(
        (obj) => ({ ...obj, mcpServers: { ...(obj.mcpServers ?? {}), b: { command: 'b' } } }),
        { ts: 'test-ts', backupDir, claudeJsonPath },
      );

      const after = JSON.parse(result.after) as { mcpServers: Record<string, unknown> };
      expect(after.mcpServers.a).toBeDefined();
      expect(after.mcpServers.b).toBeDefined();
    });
  });

  test('preserves unrelated top-level keys in claude.json', async () => {
    await withTempDir(async (dir) => {
      const claudeJsonPath = join(dir, 'claude.json');
      const backupDir = join(dir, 'backups');
      const initial = {
        mcpServers: { a: { command: 'a' } },
        oauthAccount: { email: 'user@example.com' },
        theme: 'dark',
      };
      writeFileSync(claudeJsonPath, JSON.stringify(initial));

      const result = await safeMutateClaudeJson(
        (obj) => ({ ...obj, mcpServers: { ...(obj.mcpServers ?? {}), b: { command: 'b' } } }),
        { ts: 'test-ts', backupDir, claudeJsonPath },
      );

      const after = JSON.parse(result.after) as typeof initial & { mcpServers: Record<string, unknown> };
      expect(after.oauthAccount).toEqual({ email: 'user@example.com' });
      expect(after.theme).toBe('dark');
      expect(after.mcpServers.b).toBeDefined();
    });
  });

  test('creates backup file before writing', async () => {
    await withTempDir(async (dir) => {
      const claudeJsonPath = join(dir, 'claude.json');
      const backupDir = join(dir, 'backups');
      writeFileSync(claudeJsonPath, JSON.stringify({ mcpServers: {} }));

      await safeMutateClaudeJson(
        (obj) => ({ ...obj, mcpServers: { ...(obj.mcpServers ?? {}), x: { command: 'x' } } }),
        { ts: 'backup-ts', backupDir, claudeJsonPath },
      );

      expect(existsSync(join(backupDir, 'claude.json.backup-ts.bak'))).toBe(true);
    });
  });

  test('merge-retry: detects external write and re-applies mutator on updated content', async () => {
    await withTempDir(async (dir) => {
      const claudeJsonPath = join(dir, 'claude.json');
      const backupDir = join(dir, 'backups');
      writeFileSync(
        claudeJsonPath,
        JSON.stringify({ mcpServers: { a: { command: 'a' } } }),
      );

      let callCount = 0;
      const result = await safeMutateClaudeJson(
        (obj) => {
          callCount++;
          if (callCount === 1) {
            // Simulate external writer modifying the file between our read and write
            writeFileSync(
              claudeJsonPath,
              JSON.stringify({ mcpServers: { a: { command: 'a' }, external: { command: 'ext' } } }),
            );
          }
          return { ...obj, mcpServers: { ...(obj.mcpServers ?? {}), ours: { command: 'ours' } } };
        },
        { ts: 'retry-ts', backupDir, claudeJsonPath, maxRetries: 3 },
      );

      // Mutator was called more than once (retry happened)
      expect(callCount).toBeGreaterThan(1);
      // Final result includes both external key and our addition
      const after = JSON.parse(result.after) as { mcpServers: Record<string, unknown> };
      expect(after.mcpServers.ours).toBeDefined();
      // external key from second-attempt read should be preserved
      expect(after.mcpServers.external).toBeDefined();
    });
  });

  test('throws CONFLICT_409 code when etag never stabilizes (maxRetries exceeded)', async () => {
    await withTempDir(async (dir) => {
      const claudeJsonPath = join(dir, 'claude.json');
      const backupDir = join(dir, 'backups');
      writeFileSync(claudeJsonPath, JSON.stringify({ mcpServers: {} }));

      let err: unknown;
      try {
        await safeMutateClaudeJson(
          (obj) => {
            // Always modify the file so etag always mismatches
            writeFileSync(
              claudeJsonPath,
              JSON.stringify({ mcpServers: { [String(Date.now())]: { command: 'x' } } }),
            );
            return obj;
          },
          { ts: 'conflict-ts', backupDir, claudeJsonPath, maxRetries: 2 },
        );
      } catch (e) {
        err = e;
      }

      expect(err).toBeDefined();
      expect((err as { code?: string }).code).toBe('CONFLICT_409');
    });
  });

  test('backup file can be used to restore on rollback', async () => {
    await withTempDir(async (dir) => {
      const claudeJsonPath = join(dir, 'claude.json');
      const backupDir = join(dir, 'backups');
      const originalContent = JSON.stringify({ mcpServers: { original: { command: 'orig' } } });
      writeFileSync(claudeJsonPath, originalContent);

      await safeMutateClaudeJson(
        (obj) => ({ ...obj, mcpServers: { ...(obj.mcpServers ?? {}), added: { command: 'add' } } }),
        { ts: 'rollback-ts', backupDir, claudeJsonPath },
      );

      const backup = readFileSync(join(backupDir, 'claude.json.rollback-ts.bak'), 'utf8');
      const backupObj = JSON.parse(backup) as { mcpServers: Record<string, unknown> };
      expect(backupObj.mcpServers.original).toBeDefined();
      expect(backupObj.mcpServers.added).toBeUndefined();
    });
  });
});

// ── copyMcp ──────────────────────────────────────────────────────

describe('copyMcp', () => {
  test('user→local: adds to projects[dir].mcpServers, original preserved', async () => {
    await withTempDir(async (dir) => {
      const claudeJsonPath = join(dir, 'claude.json');
      const backupDir = join(dir, 'backups');
      const targetDir = join(dir, 'myrepo');
      mkdirSync(targetDir);
      writeFileSync(
        claudeJsonPath,
        JSON.stringify({ mcpServers: { svc: { command: 'npx', args: ['svc'] } } }),
      );

      await copyMcp(
        'svc',
        { command: 'npx', args: ['svc'] },
        'local',
        { ts: 'copy-ts', backupDir, claudeJsonPath, targetDir },
      );

      const written = JSON.parse(readFileSync(claudeJsonPath, 'utf8')) as {
        mcpServers: Record<string, unknown>;
        projects: Record<string, { mcpServers?: Record<string, unknown> }>;
      };
      // Original user-scope preserved
      expect(written.mcpServers.svc).toBeDefined();
      // Added to local scope
      expect(written.projects[targetDir]?.mcpServers?.svc).toBeDefined();
    });
  });

  test('user→project: writes to .mcp.json', async () => {
    await withTempDir(async (dir) => {
      const claudeJsonPath = join(dir, 'claude.json');
      const backupDir = join(dir, 'backups');
      const projectDir = join(dir, 'repo');
      mkdirSync(projectDir);
      writeFileSync(claudeJsonPath, JSON.stringify({}));

      await copyMcp(
        'repo-svc',
        { command: 'node', args: ['server.js'] },
        'project',
        { ts: 'proj-ts', backupDir, claudeJsonPath, projectDir },
      );

      const mcpJson = JSON.parse(readFileSync(join(projectDir, '.mcp.json'), 'utf8')) as {
        mcpServers: Record<string, unknown>;
      };
      expect(mcpJson.mcpServers['repo-svc']).toBeDefined();
    });
  });

  test('blocks copy to project when def has plaintext secret (returns secretWarning)', async () => {
    await withTempDir(async (dir) => {
      const claudeJsonPath = join(dir, 'claude.json');
      const backupDir = join(dir, 'backups');
      const projectDir = join(dir, 'repo');
      mkdirSync(projectDir);
      writeFileSync(claudeJsonPath, JSON.stringify({}));

      const result = await copyMcp(
        'secret-svc',
        { command: 'npx', args: ['svc'], env: { API_KEY: 'sk-abc123def456789012345678901234567890' } },
        'project',
        { ts: 'secret-ts', backupDir, claudeJsonPath, projectDir },
        false, // forceSecret = false
      );

      expect(result.secretWarning).toBe(true);
      // .mcp.json should NOT have been written
      expect(existsSync(join(projectDir, '.mcp.json'))).toBe(false);
    });
  });

  test('allows copy to project with plaintext secret when forceSecret=true', async () => {
    await withTempDir(async (dir) => {
      const claudeJsonPath = join(dir, 'claude.json');
      const backupDir = join(dir, 'backups');
      const projectDir = join(dir, 'repo');
      mkdirSync(projectDir);
      writeFileSync(claudeJsonPath, JSON.stringify({}));

      const result = await copyMcp(
        'secret-svc',
        { command: 'npx', args: ['svc'], env: { API_KEY: 'sk-abc123def456789012345678901234567890' } },
        'project',
        { ts: 'force-ts', backupDir, claudeJsonPath, projectDir },
        true, // forceSecret = true
      );

      expect(result.secretWarning).toBeUndefined();
      expect(existsSync(join(projectDir, '.mcp.json'))).toBe(true);
    });
  });
});

// ── moveMcp ──────────────────────────────────────────────────────

describe('moveMcp', () => {
  test('user→local: atomic — original removed, target added in single write', async () => {
    await withTempDir(async (dir) => {
      const claudeJsonPath = join(dir, 'claude.json');
      const backupDir = join(dir, 'backups');
      const targetDir = join(dir, 'repo');
      mkdirSync(targetDir);
      writeFileSync(
        claudeJsonPath,
        JSON.stringify({ mcpServers: { svc: { command: 'npx', args: ['svc'] } } }),
      );

      await moveMcp(
        'svc',
        { command: 'npx', args: ['svc'] },
        'user',
        undefined,
        'local',
        { ts: 'move-ts', backupDir, claudeJsonPath, targetDir },
      );

      const written = JSON.parse(readFileSync(claudeJsonPath, 'utf8')) as {
        mcpServers?: Record<string, unknown>;
        projects: Record<string, { mcpServers?: Record<string, unknown> }>;
      };
      // Removed from user scope
      expect(written.mcpServers?.svc).toBeUndefined();
      // Added to local scope
      expect(written.projects[targetDir]?.mcpServers?.svc).toBeDefined();
    });
  });
});

// ── removeMcp ─────────────────────────────────────────────────────

describe('removeMcp', () => {
  test('removes server from user scope', async () => {
    await withTempDir(async (dir) => {
      const claudeJsonPath = join(dir, 'claude.json');
      const backupDir = join(dir, 'backups');
      writeFileSync(
        claudeJsonPath,
        JSON.stringify({ mcpServers: { toRemove: { command: 'r' }, keep: { command: 'k' } } }),
      );

      await removeMcp('toRemove', 'user', { ts: 'rm-ts', backupDir, claudeJsonPath });

      const written = JSON.parse(readFileSync(claudeJsonPath, 'utf8')) as {
        mcpServers: Record<string, unknown>;
      };
      expect(written.mcpServers.toRemove).toBeUndefined();
      expect(written.mcpServers.keep).toBeDefined();
    });
  });

  test('removes server from project .mcp.json, keeps other servers', async () => {
    await withTempDir(async (dir) => {
      const claudeJsonPath = join(dir, 'claude.json');
      const backupDir = join(dir, 'backups');
      const projectDir = join(dir, 'repo');
      mkdirSync(projectDir);
      writeFileSync(claudeJsonPath, JSON.stringify({}));
      writeFileSync(
        join(projectDir, '.mcp.json'),
        JSON.stringify({ mcpServers: { toRemove: { command: 'r' }, keep: { command: 'k' } } }),
      );

      await removeMcp('toRemove', 'project', { ts: 'rm-proj-ts', backupDir, claudeJsonPath, projectDir });

      const mcp = JSON.parse(readFileSync(join(projectDir, '.mcp.json'), 'utf8')) as {
        mcpServers: Record<string, unknown>;
      };
      expect(mcp.mcpServers.toRemove).toBeUndefined();
      expect(mcp.mcpServers.keep).toBeDefined();
    });
  });

  test('creates backup before removing from user scope', async () => {
    await withTempDir(async (dir) => {
      const claudeJsonPath = join(dir, 'claude.json');
      const backupDir = join(dir, 'backups');
      writeFileSync(claudeJsonPath, JSON.stringify({ mcpServers: { svc: { command: 'x' } } }));

      await removeMcp('svc', 'user', { ts: 'bkp-rm-ts', backupDir, claudeJsonPath });

      const backupFiles = readdirSync(backupDir);
      expect(backupFiles.some((f) => f.includes('bkp-rm-ts'))).toBe(true);
    });
  });
});
