import { describe, test, expect, mock, afterEach } from 'bun:test';
import { QuestionMonitor } from '../plugin/question-monitor';
import type { QuestionRequest } from '../plugin/question-monitor';
import { KanbanStore } from '../core/store';
import { withTempDir } from './setup';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockInput(port = 9999): any {
  return {
    serverUrl: new URL(`http://localhost:${port}`),
  };
}

function makeRequest(overrides: Partial<QuestionRequest> = {}): QuestionRequest {
  return {
    id: 'req-1',
    sessionID: 'ses-abc',
    questions: [
      {
        question: 'Which approach?',
        header: 'Architecture Decision',
        options: [
          { label: 'Option A', description: 'First approach' },
          { label: 'Option B', description: 'Second approach' },
        ],
      },
    ],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('QuestionMonitor', () => {
  let monitor: QuestionMonitor | null = null;

  afterEach(() => {
    monitor?.stop();
    monitor = null;
  });

  // ── Initial state ────────────────────────────────────────────────────────

  test('getQuestions returns empty array initially', () => {
    monitor = new QuestionMonitor(createMockInput());
    expect(monitor.getQuestions()).toEqual([]);
  });

  // ── stop() safety ────────────────────────────────────────────────────────

  test('stop is safe to call before start', () => {
    monitor = new QuestionMonitor(createMockInput());
    expect(() => monitor!.stop()).not.toThrow();
  });

  test('stop is safe to call multiple times', () => {
    monitor = new QuestionMonitor(createMockInput());
    monitor.stop();
    expect(() => monitor!.stop()).not.toThrow();
    monitor = null;
  });

  // ── reply() ──────────────────────────────────────────────────────────────

  test('reply POSTs to correct URL and removes question on success', async () => {
    const input = createMockInput();
    const capturedUrls: string[] = [];
    const capturedBodies: unknown[] = [];

    const origFetch = globalThis.fetch;
    globalThis.fetch = mock(async (url: RequestInfo, init?: RequestInit) => {
      const urlStr = url instanceof URL ? url.toString() : url as string;
      capturedUrls.push(urlStr);
      capturedBodies.push(init?.body ? JSON.parse(init.body as string) : null);
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as unknown as typeof fetch;

    try {
      monitor = new QuestionMonitor(input);

      // Inject a question directly via poll mock: re-expose via private access
      monitor.addMockQuestion(makeRequest({ id: 'req-1' }));
      expect(monitor.getQuestions()).toHaveLength(1);

      const ok = await monitor.reply('req-1', [['Option A']]);

      expect(ok).toBe(true);
      expect(capturedUrls[0]).toContain('/question/req-1/reply');
      expect(capturedBodies[0]).toEqual({ answers: [['Option A']] });
      // Should be removed from map
      expect(monitor.getQuestions()).toHaveLength(0);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  test('reply returns false and keeps question when server returns error', async () => {
    const origFetch = globalThis.fetch;
    globalThis.fetch = mock(async () => {
      return new Response('not ok', { status: 500 });
    }) as unknown as typeof fetch;

    try {
      monitor = new QuestionMonitor(createMockInput());
      monitor.addMockQuestion(makeRequest({ id: 'req-1' }));

      const ok = await monitor.reply('req-1', [['Option A']]);
      expect(ok).toBe(false);
      // Question should still be in the map
      expect(monitor.getQuestions()).toHaveLength(1);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  test('reply returns false when fetch throws', async () => {
    const origFetch = globalThis.fetch;
    globalThis.fetch = mock(async () => {
      throw new Error('network error');
    }) as unknown as typeof fetch;

    try {
      monitor = new QuestionMonitor(createMockInput());
      monitor.addMockQuestion(makeRequest({ id: 'req-1' }));

      const ok = await monitor.reply('req-1', [['A']]);
      expect(ok).toBe(false);
      expect(monitor.getQuestions()).toHaveLength(1);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  // ── reject() ─────────────────────────────────────────────────────────────

  test('reject POSTs to correct URL and removes question on success', async () => {
    const capturedUrls: string[] = [];
    const origFetch = globalThis.fetch;
    globalThis.fetch = mock(async (url: RequestInfo) => {
      capturedUrls.push(url instanceof URL ? url.toString() : url as string);
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as unknown as typeof fetch;

    try {
      monitor = new QuestionMonitor(createMockInput());
      monitor.addMockQuestion(makeRequest({ id: 'req-2' }));
      expect(monitor.getQuestions()).toHaveLength(1);

      const ok = await monitor.reject('req-2');

      expect(ok).toBe(true);
      expect(capturedUrls[0]).toContain('/question/req-2/reject');
      expect(monitor.getQuestions()).toHaveLength(0);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  test('reject returns false and keeps question when server returns error', async () => {
    const origFetch = globalThis.fetch;
    globalThis.fetch = mock(async () => {
      return new Response('error', { status: 503 });
    }) as unknown as typeof fetch;

    try {
      monitor = new QuestionMonitor(createMockInput());
      monitor.addMockQuestion(makeRequest({ id: 'req-2' }));

      const ok = await monitor.reject('req-2');
      expect(ok).toBe(false);
      expect(monitor.getQuestions()).toHaveLength(1);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  // ── poll() ────────────────────────────────────────────────────────────────

  test('poll merges new questions from server', async () => {
    const req1 = makeRequest({ id: 'poll-1' });
    const req2 = makeRequest({ id: 'poll-2', sessionID: 'ses-xyz' });

    const origFetch = globalThis.fetch;
    globalThis.fetch = mock(async () => {
      return new Response(JSON.stringify([req1, req2]), { status: 200 });
    }) as unknown as typeof fetch;

    try {
      monitor = new QuestionMonitor(createMockInput());
      await (monitor as any).poll();

      const questions = monitor.getQuestions();
      expect(questions).toHaveLength(2);
      expect(questions.map((q) => q.id).sort()).toEqual(['poll-1', 'poll-2']);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  test('poll removes stale questions no longer in server response', async () => {
    const origFetch = globalThis.fetch;
    globalThis.fetch = mock(async () => {
      // Server now only returns req-b, req-a is gone
      return new Response(JSON.stringify([makeRequest({ id: 'req-b' })]), { status: 200 });
    }) as unknown as typeof fetch;

    try {
      monitor = new QuestionMonitor(createMockInput());
      // Pre-seed two questions
      monitor.addMockQuestion(makeRequest({ id: 'req-a' }));
      monitor.addMockQuestion(makeRequest({ id: 'req-b' }));

      await (monitor as any).poll();

      const questions = monitor.getQuestions();
      expect(questions).toHaveLength(1);
      expect(questions[0].id).toBe('req-b');
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  test('poll silently ignores server errors', async () => {
    const origFetch = globalThis.fetch;
    globalThis.fetch = mock(async () => {
      return new Response('server error', { status: 500 });
    }) as unknown as typeof fetch;

    try {
      monitor = new QuestionMonitor(createMockInput());
      monitor.addMockQuestion(makeRequest({ id: 'existing' }));

      // Should not throw, should not clear existing questions
      expect((monitor as any).poll()).resolves.toBeUndefined();
      expect(monitor.getQuestions()).toHaveLength(1);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  test('poll silently ignores network errors', async () => {
    const origFetch = globalThis.fetch;
    globalThis.fetch = mock(async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;

    try {
      monitor = new QuestionMonitor(createMockInput());
      expect((monitor as any).poll()).resolves.toBeUndefined();
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  test('poll ignores non-array server response', async () => {
    const origFetch = globalThis.fetch;
    globalThis.fetch = mock(async () => {
      return new Response(JSON.stringify({ unexpected: true }), { status: 200 });
    }) as unknown as typeof fetch;

    try {
      monitor = new QuestionMonitor(createMockInput());
      expect((monitor as any).poll()).resolves.toBeUndefined();
      expect(monitor.getQuestions()).toHaveLength(0);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  // ── SSE handleSSEEvent() ─────────────────────────────────────────────────

  test('handleSSEEvent question.asked adds to map', () => {
    monitor = new QuestionMonitor(createMockInput());
    const req = makeRequest({ id: 'sse-1' });

    (monitor as any).handleSSEEvent('question.asked', JSON.stringify(req));

    expect(monitor.getQuestions()).toHaveLength(1);
    expect(monitor.getQuestions()[0].id).toBe('sse-1');
  });

  test('handleSSEEvent question.replied removes from map', () => {
    monitor = new QuestionMonitor(createMockInput());
    monitor.addMockQuestion(makeRequest({ id: 'sse-2' }));

    (monitor as any).handleSSEEvent('question.replied', JSON.stringify({ requestID: 'sse-2' }));

    expect(monitor.getQuestions()).toHaveLength(0);
  });

  test('handleSSEEvent question.rejected removes from map', () => {
    monitor = new QuestionMonitor(createMockInput());
    monitor.addMockQuestion(makeRequest({ id: 'sse-3' }));

    (monitor as any).handleSSEEvent('question.rejected', JSON.stringify({ id: 'sse-3' }));

    expect(monitor.getQuestions()).toHaveLength(0);
  });

  test('handleSSEEvent ignores unknown event types', () => {
    monitor = new QuestionMonitor(createMockInput());
    monitor.addMockQuestion(makeRequest({ id: 'keep' }));

    (monitor as any).handleSSEEvent('session.idle', JSON.stringify({ id: 'keep' }));

    // Should be untouched
    expect(monitor.getQuestions()).toHaveLength(1);
  });

  test('handleSSEEvent silently ignores malformed JSON for question.asked', () => {
    monitor = new QuestionMonitor(createMockInput());
    expect(() => {
      (monitor as any).handleSSEEvent('question.asked', 'NOT_JSON{{');
    }).not.toThrow();
    expect(monitor.getQuestions()).toHaveLength(0);
  });

  test('handleSSEEvent silently ignores malformed JSON for question.replied', () => {
    monitor = new QuestionMonitor(createMockInput());
    monitor.addMockQuestion(makeRequest({ id: 'q1' }));
    expect(() => {
      (monitor as any).handleSSEEvent('question.replied', '{{BAD');
    }).not.toThrow();
    // q1 should remain
    expect(monitor.getQuestions()).toHaveLength(1);
  });

  test('handleSSEEvent ignores question.asked with missing id', () => {
    monitor = new QuestionMonitor(createMockInput());
    (monitor as any).handleSSEEvent('question.asked', JSON.stringify({ sessionID: 'x' }));
    expect(monitor.getQuestions()).toHaveLength(0);
  });

  // ── tryAutoReply (recommended-option auto-reply) ────────────────────────

  test('tryAutoReply auto-replies when a tracked card matches the session', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const created = await store.createCard({
        title: 'Telegram Task',
        description: 'test',
        sessionId: 'ses-telegram',
        telegramChatId: 12345,
      });

      const capturedBodies: unknown[] = [];
      const origFetch = globalThis.fetch;
      globalThis.fetch = mock(async (_url: RequestInfo, init?: RequestInit) => {
        capturedBodies.push(init?.body ? JSON.parse(init.body as string) : null);
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }) as unknown as typeof fetch;

      try {
        monitor = new QuestionMonitor(createMockInput(), store);
        const req = makeRequest({ id: 'tg-q1', sessionID: 'ses-telegram' });

        await (monitor as any).tryAutoReply(req);

        // Should have sent a reply with the first option
        expect(capturedBodies.length).toBeGreaterThanOrEqual(1);
        expect(capturedBodies[0]).toEqual({ answers: [['Option A']] });

        // Should have recorded Q&A in progressSummary
        const updated = await store.getCard(created.id);
        expect(updated?.progressSummary).toContain('Auto-answered (recommended default)');
        expect(updated?.progressSummary).toContain('Option A');
      } finally {
        globalThis.fetch = origFetch;
      }
    });
  });

  test('tryAutoReply auto-replies when card has no telegramChatId', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const created = await store.createCard({
        title: 'Normal Task',
        description: 'test',
        sessionId: 'ses-normal',
      });

      const capturedBodies: unknown[] = [];
      const origFetch = globalThis.fetch;
      globalThis.fetch = mock(async (_url: RequestInfo, init?: RequestInit) => {
        capturedBodies.push(init?.body ? JSON.parse(init.body as string) : null);
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }) as unknown as typeof fetch;

      try {
        monitor = new QuestionMonitor(createMockInput(), store);
        const req = makeRequest({ id: 'q-normal', sessionID: 'ses-normal' });

        await (monitor as any).tryAutoReply(req);

        expect(capturedBodies).toEqual([{ answers: [['Option A']] }]);
        const updated = await store.getCard(created.id);
        expect(updated?.progressSummary).toContain('Auto-answered (recommended default)');
      } finally {
        globalThis.fetch = origFetch;
      }
    });
  });

  test('tryAutoReply does nothing when store is not provided', async () => {
    const fetchCalled = { value: false };
    const origFetch = globalThis.fetch;
    globalThis.fetch = mock(async () => {
      fetchCalled.value = true;
      return new Response('ok', { status: 200 });
    }) as unknown as typeof fetch;

    try {
      monitor = new QuestionMonitor(createMockInput()); // no store
      const req = makeRequest({ id: 'q-nostore', sessionID: 'ses-any' });

      await (monitor as any).tryAutoReply(req);

      expect(fetchCalled.value).toBe(false);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  test('tryAutoReply does nothing when recommended auto-reply is disabled', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      await store.createCard({
        title: 'Disabled TG Task',
        description: 'test',
        sessionId: 'ses-disabled',
        telegramChatId: 33333,
      });

      const fetchCalled = { value: false };
      const origFetch = globalThis.fetch;
      globalThis.fetch = mock(async () => {
        fetchCalled.value = true;
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }) as unknown as typeof fetch;

      try {
        monitor = new QuestionMonitor(createMockInput(), store, {
          enableRecommendedAutoReply: false,
        });
        const req = makeRequest({ id: 'q-disabled', sessionID: 'ses-disabled' });

        await (monitor as any).tryAutoReply(req);

        expect(fetchCalled.value).toBe(false);
      } finally {
        globalThis.fetch = origFetch;
      }
    });
  });

  test('tryAutoReply does nothing when no card found for session', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      // No card created for 'ses-unknown'

      const fetchCalled = { value: false };
      const origFetch = globalThis.fetch;
      globalThis.fetch = mock(async () => {
        fetchCalled.value = true;
        return new Response('ok', { status: 200 });
      }) as unknown as typeof fetch;

      try {
        monitor = new QuestionMonitor(createMockInput(), store);
        const req = makeRequest({ id: 'q-unknown', sessionID: 'ses-unknown' });

        await (monitor as any).tryAutoReply(req);

        expect(fetchCalled.value).toBe(false);
      } finally {
        globalThis.fetch = origFetch;
      }
    });
  });

  test('tryAutoReply appends to existing progressSummary', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const created = await store.createCard({
        title: 'TG Append Task',
        description: 'test',
        sessionId: 'ses-tg-append',
        telegramChatId: 99999,
      });
      // Set initial progressSummary
      await store.updateCard(created.id, { progressSummary: 'Existing progress notes' });

      const origFetch = globalThis.fetch;
      globalThis.fetch = mock(async () => {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }) as unknown as typeof fetch;

      try {
        monitor = new QuestionMonitor(createMockInput(), store);
        const req = makeRequest({ id: 'q-append', sessionID: 'ses-tg-append' });

        await (monitor as any).tryAutoReply(req);

        const updated = await store.getCard(created.id);
        // Should contain both old and new content
        expect(updated?.progressSummary).toContain('Existing progress notes');
        expect(updated?.progressSummary).toContain('Auto-answered (recommended default)');
      } finally {
        globalThis.fetch = origFetch;
      }
    });
  });

  test('tryAutoReply does not record when reply fails', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const created = await store.createCard({
        title: 'TG Fail Task',
        description: 'test',
        sessionId: 'ses-tg-fail',
        telegramChatId: 77777,
      });

      const origFetch = globalThis.fetch;
      globalThis.fetch = mock(async () => {
        return new Response('server error', { status: 500 });
      }) as unknown as typeof fetch;

      try {
        monitor = new QuestionMonitor(createMockInput(), store);
        const req = makeRequest({ id: 'q-fail', sessionID: 'ses-tg-fail' });

        await (monitor as any).tryAutoReply(req);

        // progressSummary should NOT have been updated
        const updated = await store.getCard(created.id);
        expect(updated?.progressSummary).toBeUndefined();
      } finally {
        globalThis.fetch = origFetch;
      }
    });
  });

  test('handleSSEEvent question.asked triggers tryAutoReply for tracked card session', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      await store.createCard({
        title: 'TG SSE Task',
        description: 'test',
        sessionId: 'ses-tg-sse',
        telegramChatId: 55555,
      });

      const capturedUrls: string[] = [];
      const origFetch = globalThis.fetch;
      globalThis.fetch = mock(async (url: RequestInfo) => {
        capturedUrls.push(url instanceof URL ? url.toString() : url as string);
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }) as unknown as typeof fetch;

      try {
        monitor = new QuestionMonitor(createMockInput(), store);
        const req = makeRequest({ id: 'sse-tg-q', sessionID: 'ses-tg-sse' });

        (monitor as any).handleSSEEvent('question.asked', JSON.stringify(req));

        // Wait briefly for the async tryAutoReply to fire
        await new Promise((r) => setTimeout(r, 100));

        // Should have added to questions map AND sent auto-reply
        expect(capturedUrls.some((u) => u.includes('/question/sse-tg-q/reply'))).toBe(true);
      } finally {
        globalThis.fetch = origFetch;
      }
    });
  });

  test('poll triggers tryAutoReply for newly discovered tracked card questions', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      await store.createCard({
        title: 'TG Poll Task',
        description: 'test',
        sessionId: 'ses-tg-poll',
        telegramChatId: 44444,
      });

      const req = makeRequest({ id: 'poll-tg-q', sessionID: 'ses-tg-poll' });
      const capturedUrls: string[] = [];

      const origFetch = globalThis.fetch;
      globalThis.fetch = mock(async (url: RequestInfo) => {
        const urlStr = url instanceof URL ? url.toString() : url as string;
        capturedUrls.push(urlStr);

        // First fetch is the poll GET /question
        if (urlStr.includes('/question') && !urlStr.includes('/reply') && !urlStr.includes('/reject')) {
          return new Response(JSON.stringify([req]), { status: 200 });
        }
        // Second fetch is the auto-reply POST
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }) as unknown as typeof fetch;

      try {
        monitor = new QuestionMonitor(createMockInput(), store);
        await (monitor as any).poll();

        // Wait briefly for the async tryAutoReply to fire
        await new Promise((r) => setTimeout(r, 100));

        // Should have sent auto-reply for the newly discovered question
        expect(capturedUrls.some((u) => u.includes('/question/poll-tg-q/reply'))).toBe(true);
      } finally {
        globalThis.fetch = origFetch;
      }
    });
  });

  // ── formatQuestionHistory ──────────────────────────────────────────────

  test('formatQuestionHistory formats recommended auto-answer with emoji', () => {
    const req = makeRequest({ id: 'fmt-1' });
    const answers = [['Option A']];

    const result = QuestionMonitor.formatQuestionHistory(req, answers);

    expect(result).toContain('🤖 Auto-answered (recommended default)');
    expect(result).toContain('Q: Architecture Decision — Which approach?');
    expect(result).toContain('A: Option A');
  });

  test('formatQuestionHistory formats rejection', () => {
    const req = makeRequest({ id: 'fmt-2' });

    const result = QuestionMonitor.formatQuestionHistory(req, null);

    expect(result).toContain('❌ Question rejected');
    expect(result).toContain('Q: Architecture Decision — Which approach?');
    expect(result).not.toContain('A:');
  });
});
