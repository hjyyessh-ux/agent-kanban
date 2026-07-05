import { describe, test, expect } from 'bun:test';
import { ScriptStore } from '../core/script-store';
import { withTempDir } from './setup';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

function createScriptsDir(baseDir: string, files: Record<string, string>): string {
  const scriptsDir = join(baseDir, 'scripts');
  mkdirSync(scriptsDir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(scriptsDir, name), content);
  }
  return scriptsDir;
}

describe('ScriptStore', () => {
  describe('syncFromDirectory', () => {
    test('creates entries for script files', async () => {
      await withTempDir(async (dir) => {
        const store = new ScriptStore(dir);
        const scriptsDir = createScriptsDir(dir, {
          'deploy.sh': '#!/bin/bash\necho deploy',
          'build.ts': 'console.log("build")',
        });

        const result = await store.syncFromDirectory(scriptsDir);

        expect(result.created).toBe(2);
        expect(result.updated).toBe(0);

        const entries = await store.getEntries();
        expect(entries).toHaveLength(2);

        const deploy = entries.find(e => e.name === 'deploy');
        expect(deploy).toBeTruthy();
        expect(deploy!.content).toBe('#!/bin/bash\necho deploy');
        expect(deploy!.language).toBe('bash');
        expect(deploy!.description).toBe('Synced from data scripts/deploy.sh');

        const build = entries.find(e => e.name === 'build');
        expect(build).toBeTruthy();
        expect(build!.content).toBe('console.log("build")');
        expect(build!.language).toBe('typescript');
      });
    });

    test('updates content for existing entries with changed files', async () => {
      await withTempDir(async (dir) => {
        const store = new ScriptStore(dir);

        // First sync
        const scriptsDir = createScriptsDir(dir, {
          'deploy.sh': '#!/bin/bash\necho v1',
        });
        await store.syncFromDirectory(scriptsDir);

        // Modify the file
        writeFileSync(join(scriptsDir, 'deploy.sh'), '#!/bin/bash\necho v2');

        // Second sync
        const result = await store.syncFromDirectory(scriptsDir);
        expect(result.created).toBe(0);
        expect(result.updated).toBe(1);

        const entries = await store.getEntries();
        expect(entries).toHaveLength(1);
        expect(entries[0].content).toBe('#!/bin/bash\necho v2');
      });
    });

    test('skips entries with unchanged content', async () => {
      await withTempDir(async (dir) => {
        const store = new ScriptStore(dir);
        const scriptsDir = createScriptsDir(dir, {
          'deploy.sh': '#!/bin/bash\necho stable',
        });

        await store.syncFromDirectory(scriptsDir);
        const firstEntries = await store.getEntries();
        const firstUpdatedAt = firstEntries[0].updatedAt;

        // Wait a tick so timestamp would differ if updated
        await new Promise(r => setTimeout(r, 10));

        const result = await store.syncFromDirectory(scriptsDir);
        expect(result.created).toBe(0);
        expect(result.updated).toBe(0);

        const entries = await store.getEntries();
        expect(entries[0].updatedAt).toBe(firstUpdatedAt);
      });
    });

    test('does not remove entries without backing files', async () => {
      await withTempDir(async (dir) => {
        const store = new ScriptStore(dir);

        // Create a script via the store API (UI-created)
        await store.createEntry({
          name: 'ui-script',
          description: 'Created via UI',
          content: 'echo hello',
          language: 'bash',
        });

        // Sync from empty scripts dir (no backing file for ui-script)
        const scriptsDir = createScriptsDir(dir, {
          'other.sh': 'echo other',
        });
        const result = await store.syncFromDirectory(scriptsDir);
        expect(result.created).toBe(1);

        const entries = await store.getEntries();
        expect(entries).toHaveLength(2);
        expect(entries.find(e => e.name === 'ui-script')).toBeTruthy();
        expect(entries.find(e => e.name === 'other')).toBeTruthy();
      });
    });

    test('returns zero counts for nonexistent directory', async () => {
      await withTempDir(async (dir) => {
        const store = new ScriptStore(dir);
        const result = await store.syncFromDirectory(join(dir, 'nonexistent'));
        expect(result.created).toBe(0);
        expect(result.updated).toBe(0);
      });
    });

    test('ignores files with unrecognized extensions', async () => {
      await withTempDir(async (dir) => {
        const store = new ScriptStore(dir);
        const scriptsDir = createScriptsDir(dir, {
          'readme.md': '# Hello',
          'data.json': '{}',
          'actual.sh': 'echo yes',
        });

        const result = await store.syncFromDirectory(scriptsDir);
        expect(result.created).toBe(1);

        const entries = await store.getEntries();
        expect(entries).toHaveLength(1);
        expect(entries[0].name).toBe('actual');
      });
    });

    test('detects language from file extension', async () => {
      await withTempDir(async (dir) => {
        const store = new ScriptStore(dir);
        const scriptsDir = createScriptsDir(dir, {
          'a.sh': 'echo',
          'b.ts': 'log',
          'c.js': 'log',
          'd.py': 'print',
        });

        await store.syncFromDirectory(scriptsDir);
        const entries = await store.getEntries();

        const byName = Object.fromEntries(entries.map(e => [e.name, e.language]));
        expect(byName['a']).toBe('bash');
        expect(byName['b']).toBe('typescript');
        expect(byName['c']).toBe('javascript');
        expect(byName['d']).toBe('python');
      });
    });

    test('preserves history and run data on content update', async () => {
      await withTempDir(async (dir) => {
        const store = new ScriptStore(dir);
        const scriptsDir = createScriptsDir(dir, {
          'deploy.sh': '#!/bin/bash\necho v1',
        });

        await store.syncFromDirectory(scriptsDir);
        const entries = await store.getEntries();
        const scriptId = entries[0].id;

        // Add a run record
        await store.addRun(scriptId, {
          id: 'run-1',
          scriptId,
          startedAt: new Date().toISOString(),
          finishedAt: new Date().toISOString(),
          status: 'success',
          exitCode: 0,
          stdout: 'v1 output',
        });

        // Modify file and re-sync
        writeFileSync(join(scriptsDir, 'deploy.sh'), '#!/bin/bash\necho v2');
        await store.syncFromDirectory(scriptsDir);

        const updated = await store.getEntries();
        expect(updated).toHaveLength(1);
        expect(updated[0].content).toBe('#!/bin/bash\necho v2');
        expect(updated[0].history).toHaveLength(1);
        expect(updated[0].history[0].stdout).toBe('v1 output');
        expect(updated[0].id).toBe(scriptId); // same ID preserved
      });
    });
  });
});
