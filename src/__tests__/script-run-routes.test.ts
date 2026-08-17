import { describe, expect, test } from 'bun:test';
import { KanbanStore } from '../core/store';
import { ScriptStore } from '../core/script-store';
import { SettingsStore } from '../core/settings-store';
import { ScriptExecutionService } from '../plugin/script-execution-service';
import { createRouteHandler } from '../server/routes';
import { withTempDir } from './setup';

describe('script run routes', () => {
  test('returns 202 before completion and tracks the legacy runner with the shared card contract', async () => {
    await withTempDir(async (dir) => {
      const cardStore = new KanbanStore(dir);
      const scriptStore = new ScriptStore(dir);
      const settingsStore = new SettingsStore(dir);
      let release!: (exitCode: number) => void;
      const exited = new Promise<number>((resolve) => { release = resolve; });
      const service = new ScriptExecutionService({
        cardStore,
        scriptStore,
        settingsStore,
        spawn: () => ({
          stdout: new Blob(['legacy complete']).stream(),
          stderr: new Blob([]).stream(),
          exited,
        }),
      });
      const script = await scriptStore.createEntry({
        name: 'legacy-deploy',
        description: 'Deploy through the scripts API',
        content: 'echo deploy',
        language: 'bash',
        projectDir: dir,
      });
      const { handleRequest } = createRouteHandler(
        cardStore,
        undefined,
        undefined,
        undefined,
        settingsStore,
        undefined,
        scriptStore,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        service,
      );

      const response = await handleRequest(new Request(
        `http://localhost/api/scripts/${script.id}/run`,
        { method: 'POST', headers: { Host: 'localhost' } },
      ));
      expect(response.status).toBe(202);
      const accepted = await response.json() as {
        cardId: string;
        runId: string;
        status: string;
      };
      expect(accepted.status).toBe('running');
      expect(await cardStore.getCard(accepted.cardId)).toMatchObject({
        status: 'in_progress',
        executionKind: 'script',
        scriptRunId: accepted.runId,
        scriptName: 'legacy-deploy',
        projectDir: dir,
      });
      expect(await scriptStore.getRun(script.id, accepted.runId)).toMatchObject({ status: 'running' });

      release(0);
      await service.waitForRun(accepted.runId);
      expect(await cardStore.getCard(accepted.cardId)).toMatchObject({
        status: 'complete',
        resolution: 'completed',
        result: expect.stringContaining('legacy complete'),
      });

      const override = await handleRequest(new Request(
        `http://localhost/api/scripts/${script.id}/run`,
        {
          method: 'POST',
          headers: { Host: 'localhost', 'Content-Type': 'application/json' },
          body: JSON.stringify({ interpreter: 'zsh', command: 'touch /tmp/unsafe' }),
        },
      ));
      expect(override.status).toBe(400);
      expect(await override.json()).toEqual({
        error: 'Script run requests do not accept command or interpreter overrides',
      });
      expect((await cardStore.load()).cards).toHaveLength(1);
    });
  });
});
