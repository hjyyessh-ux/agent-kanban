import { describe, test, expect } from 'bun:test';
import { KanbanStore } from '../core/store';
import { WorkStore } from '../core/work-store';
import { SettingsStore } from '../core/settings-store';
import { createRouteHandler } from '../server/routes';
import {
  loadWorksConfig,
  loadWorksConfigDto,
  saveWorksConfig,
  WORKS_SETTING_DEFAULTS,
} from '../plugin/works/works-config';
import {
  generateWorkSummary,
  parseSummaryLines,
  type WorkTranscriptSource,
} from '../plugin/works/works-summary';
import { withTempDir } from './setup';
import type { Work, WorksConfigDto } from '../core/types';

/** createRouteHandler with only settingsStore (pos 5) + workStore (pos 22) wired. */
function handlerWith(store: KanbanStore, settingsStore: SettingsStore, workStore: WorkStore) {
  return createRouteHandler(
    store, undefined, undefined, undefined, settingsStore, undefined, undefined,
    undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    workStore,
  );
}

describe('works-config', () => {
  test('loadWorksConfig returns sane defaults on a fresh store', async () => {
    await withTempDir(async (dir) => {
      const config = await loadWorksConfig(new SettingsStore(dir));
      expect(config.summaryModel).toBe(WORKS_SETTING_DEFAULTS.summaryModel);
      expect(config.summaryLines).toBe(4);
      expect(config.assignPreferSameDir).toBe(true);
      expect(config.assignSuggestResumeChain).toBe(true);
      expect(config.staleDays).toBe(5);
      expect(config.doneConfirm).toBe(false);
    });
  });

  test('saveWorksConfig persists only provided fields and derives the route', async () => {
    await withTempDir(async (dir) => {
      const settingsStore = new SettingsStore(dir);
      const dto = await saveWorksConfig(settingsStore, {
        summaryModel: 'gpt-5.5',
        summaryLines: 3,
        doneConfirm: true,
      });
      expect(dto.configured).toBe(true);
      expect(dto.route).toBe('codex'); // gpt-* → codex
      expect(dto.summaryLines).toBe(3);
      expect(dto.doneConfirm).toBe(true);
      // Untouched fields keep their defaults.
      expect(dto.assignPreferSameDir).toBe(true);
      expect(dto.staleDays).toBe(5);

      // Round-trips through a fresh store instance.
      const reloaded = await loadWorksConfig(new SettingsStore(dir));
      expect(reloaded.summaryModel).toBe('gpt-5.5');
      expect(reloaded.summaryLines).toBe(3);
    });
  });

  test('loadWorksConfigDto reports configured=false before any save', async () => {
    await withTempDir(async (dir) => {
      const dto = await loadWorksConfigDto(new SettingsStore(dir));
      expect(dto.configured).toBe(false);
      expect(dto.route).toBe('claude'); // default claude model
    });
  });

  test('GET/POST /api/works/config round-trips over HTTP', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const settingsStore = new SettingsStore(dir);
      const workStore = new WorkStore(dir);
      const { handleRequest } = handlerWith(store, settingsStore, workStore);

      const before = await handleRequest(new Request('http://localhost/api/works/config'));
      expect(before.status).toBe(200);
      expect((await before.json() as WorksConfigDto).configured).toBe(false);

      const saved = await handleRequest(new Request('http://localhost/api/works/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ summaryLines: 5, staleDays: 7 }),
      }));
      expect(saved.status).toBe(200);
      const savedDto = await saved.json() as WorksConfigDto;
      expect(savedDto.summaryLines).toBe(5);
      expect(savedDto.staleDays).toBe(7);
      expect(savedDto.configured).toBe(true);
    });
  });

  test('POST /api/works/config rejects an invalid summaryLines', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const settingsStore = new SettingsStore(dir);
      const workStore = new WorkStore(dir);
      const { handleRequest } = handlerWith(store, settingsStore, workStore);

      const res = await handleRequest(new Request('http://localhost/api/works/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ summaryLines: 8 }),
      }));
      expect(res.status).toBe(400);
    });
  });

  test('/api/works/config is not shadowed by the /api/works/:id GET route', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const settingsStore = new SettingsStore(dir);
      const workStore = new WorkStore(dir);
      const { handleRequest } = handlerWith(store, settingsStore, workStore);

      const res = await handleRequest(new Request('http://localhost/api/works/config'));
      // The catch-all would 404 "Work not found" for id="config"; config wins.
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('application/json');
    });
  });
});

describe('works-summary', () => {
  test('parseSummaryLines strips markers, drops preamble, and caps line count', () => {
    const raw = '요약:\n- 첫 번째 핵심\n2. 두 번째 핵심\n• 세 번째 핵심\n\n네 번째 핵심\n다섯 번째';
    expect(parseSummaryLines(raw, 4)).toEqual([
      '첫 번째 핵심',
      '두 번째 핵심',
      '세 번째 핵심',
      '네 번째 핵심',
    ]);
  });

  test('generateWorkSummary summarizes usable sessions and reports skipped ones', async () => {
    const work: Work = {
      id: 'w1',
      title: 'ArgoCD ACL 개선',
      status: 'active',
      sessionLinks: [
        { sessionId: 'ses-有', linkedAt: new Date().toISOString() },
        { sessionId: 'ses-無', linkedAt: new Date().toISOString() },
      ],
      startedAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const sources: WorkTranscriptSource[] = [
      { link: work.sessionLinks[0], transcript: '[user] ACL 고쳐줘\n[assistant] 고쳤습니다', title: 'ACL 작업' },
      { link: work.sessionLinks[1], transcript: undefined },
    ];

    let capturedModel: string | undefined;
    const result = await generateWorkSummary({
      work,
      sources,
      lines: 3,
      model: 'claude-sonnet-5',
      effort: 'medium',
      llmRunner: async (_prompt, options) => {
        capturedModel = options?.model;
        return '한 일: ACL 규칙 수정\n결정: 화이트리스트 방식 채택\n남은 일: 스테이징 검증';
      },
    });

    expect(capturedModel).toBe('claude-sonnet-5');
    expect(result.summary.lines).toHaveLength(3);
    expect(result.summary.model).toBe('claude-sonnet-5');
    expect(result.generatedSessions).toEqual(['ses-有']);
    expect(result.skippedSessions).toEqual([{ sessionId: 'ses-無', reason: 'transcript unavailable' }]);
  });

  test('generateWorkSummary throws when no session has a transcript', async () => {
    const work: Work = {
      id: 'w2',
      title: 'empty',
      status: 'active',
      sessionLinks: [{ sessionId: 'ses-x', linkedAt: new Date().toISOString() }],
      startedAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await expect(generateWorkSummary({
      work,
      sources: [{ link: work.sessionLinks[0], transcript: undefined }],
      lines: 4,
      model: 'claude-sonnet-5',
      effort: 'medium',
      llmRunner: async () => 'unused',
    })).rejects.toThrow('No session transcripts available');
  });
});
