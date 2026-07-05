import { describe, test, expect } from 'bun:test';
import { createServer } from '../server/index';
import { KanbanStore } from '../core/store';
import { withTempDir } from './setup';
import type { QuestionMonitor } from '../plugin/question-monitor';
import type { QuestionRequest } from '../plugin/question-monitor';

// ── Helpers ──────────────────────────────────────────────────────────

function makeQuestion(id: string, question = 'Pick one'): QuestionRequest {
  return {
    id,
    sessionID: `sess-${id}`,
    questions: [
      {
        question,
        header: 'Header',
        options: [
          { label: 'A', description: 'Option A' },
          { label: 'B', description: 'Option B' },
        ],
      },
    ],
  };
}

function createMockQuestionMonitor(
  questions: QuestionRequest[] = [],
  overrides: {
    reply?: (id: string, answers: string[][]) => Promise<boolean>;
    reject?: (id: string) => Promise<boolean>;
  } = {},
) {
  const questionList = [...questions];
  return {
    getQuestions: () => [...questionList],
    reply: overrides.reply ?? (async () => true),
    reject: overrides.reject ?? (async () => true),
    addMockQuestion: (question: QuestionRequest) => {
      questionList.push(question);
    },
    removeQuestion: (id: string) => {
      const index = questionList.findIndex((question) => question.id === id);
      if (index === -1) return false;
      questionList.splice(index, 1);
      return true;
    },
    start: () => {},
    stop: () => {},
  } as unknown as QuestionMonitor;
}

async function withQuestionServer(
  questionMonitor: QuestionMonitor | undefined,
  callback: (baseUrl: string) => Promise<void>,
) {
  await withTempDir(async (dir) => {
    const store = new KanbanStore(dir);
    const port = 24700 + Math.floor(Math.random() * 100);
    const { stop, port: actualPort } = createServer(
      store,
      port,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      questionMonitor,
    );
    const baseUrl = `http://localhost:${actualPort}`;
    try {
      await callback(baseUrl);
    } finally {
      stop();
    }
  });
}

// ── Tests ────────────────────────────────────────────────────────────

describe('Question API Routes', () => {
  // ── GET /api/questions ──────────────────────────────────────────────

  test('GET /api/questions returns empty array when no monitor', async () => {
    await withQuestionServer(undefined, async (url) => {
      const res = await fetch(`${url}/api/questions`);
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data).toEqual([]);
    });
  });

  test('GET /api/questions returns questions from monitor', async () => {
    const q1 = makeQuestion('q1');
    const q2 = makeQuestion('q2', 'Which framework?');
    const monitor = createMockQuestionMonitor([q1, q2]);

    await withQuestionServer(monitor, async (url) => {
      const res = await fetch(`${url}/api/questions`);
      expect(res.status).toBe(200);
      const data = (await res.json()) as QuestionRequest[];
      expect(data).toHaveLength(2);
      expect(data[0].id).toBe('q1');
      expect(data[1].id).toBe('q2');
    });
  });

  test('GET /api/questions returns empty array when monitor has no questions', async () => {
    const monitor = createMockQuestionMonitor([]);

    await withQuestionServer(monitor, async (url) => {
      const res = await fetch(`${url}/api/questions`);
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data).toEqual([]);
    });
  });

  // ── POST /api/questions/:id/reply ───────────────────────────────────

  test('POST /api/questions/:id/reply returns 503 when no monitor', async () => {
    await withQuestionServer(undefined, async (url) => {
      const res = await fetch(`${url}/api/questions/q1/reply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ answers: [['A']] }),
      });
      expect(res.status).toBe(503);
      const data = (await res.json()) as { error: string };
      expect(data.error).toContain('not available');
    });
  });

  test('POST /api/questions/:id/reply returns ok true on success', async () => {
    const monitor = createMockQuestionMonitor([], {
      reply: async () => true,
    });

    await withQuestionServer(monitor, async (url) => {
      const res = await fetch(`${url}/api/questions/q1/reply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ answers: [['A']] }),
      });
      expect(res.status).toBe(200);
      const data = (await res.json()) as { ok: boolean };
      expect(data.ok).toBe(true);
    });
  });

  test('POST /api/questions/:id/reply returns ok false when monitor.reply fails', async () => {
    const monitor = createMockQuestionMonitor([], {
      reply: async () => false,
    });

    await withQuestionServer(monitor, async (url) => {
      const res = await fetch(`${url}/api/questions/q1/reply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ answers: [['A']] }),
      });
      expect(res.status).toBe(200);
      const data = (await res.json()) as { ok: boolean };
      expect(data.ok).toBe(false);
    });
  });

  test('POST /api/questions/:id/reply returns 400 when answers is missing', async () => {
    const monitor = createMockQuestionMonitor([]);

    await withQuestionServer(monitor, async (url) => {
      const res = await fetch(`${url}/api/questions/q1/reply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
      const data = (await res.json()) as { error: string };
      expect(data.error).toContain('answers');
    });
  });

  test('POST /api/questions/:id/reply returns 400 for invalid JSON body', async () => {
    const monitor = createMockQuestionMonitor([]);

    await withQuestionServer(monitor, async (url) => {
      const res = await fetch(`${url}/api/questions/q1/reply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'NOT_VALID_JSON',
      });
      expect(res.status).toBe(400);
      const data = (await res.json()) as { error: string };
      expect(data.error).toBeTruthy();
    });
  });

  // ── POST /api/questions/:id/reject ──────────────────────────────────

  test('POST /api/questions/:id/reject returns 503 when no monitor', async () => {
    await withQuestionServer(undefined, async (url) => {
      const res = await fetch(`${url}/api/questions/q1/reject`, {
        method: 'POST',
      });
      expect(res.status).toBe(503);
      const data = (await res.json()) as { error: string };
      expect(data.error).toContain('not available');
    });
  });

  test('POST /api/questions/:id/reject returns ok true on success', async () => {
    const monitor = createMockQuestionMonitor([], {
      reject: async () => true,
    });

    await withQuestionServer(monitor, async (url) => {
      const res = await fetch(`${url}/api/questions/q1/reject`, {
        method: 'POST',
      });
      expect(res.status).toBe(200);
      const data = (await res.json()) as { ok: boolean };
      expect(data.ok).toBe(true);
    });
  });

  test('POST /api/questions/:id/reject returns ok false when monitor.reject fails', async () => {
    const monitor = createMockQuestionMonitor([], {
      reject: async () => false,
    });

    await withQuestionServer(monitor, async (url) => {
      const res = await fetch(`${url}/api/questions/q1/reject`, {
        method: 'POST',
      });
      expect(res.status).toBe(200);
      const data = (await res.json()) as { ok: boolean };
      expect(data.ok).toBe(false);
    });
  });

  // ── Same-origin policy (no wildcard CORS) ───────────────────────────

  test('question routes do not emit a wildcard CORS header', async () => {
    const monitor = createMockQuestionMonitor([makeQuestion('q1')]);

    await withQuestionServer(monitor, async (url) => {
      const res = await fetch(`${url}/api/questions`);
      expect(res.status).toBe(200);
      // The SPA is same-origin; no cross-origin access is granted.
      expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
    });
  });

  test('cross-origin browser request to question route is rejected', async () => {
    const monitor = createMockQuestionMonitor([]);

    await withQuestionServer(monitor, async (url) => {
      const res = await fetch(`${url}/api/questions/q1/reply`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: 'http://evil.example.com',
        },
        body: JSON.stringify({ answers: [['A']] }),
      });
      expect(res.status).toBe(403);
    });
  });
});

// ── Phase 2: Question History Tests ──────────────────────────────────

async function withQuestionServerAndStore(
  questionMonitor: QuestionMonitor | undefined,
  callback: (baseUrl: string, store: KanbanStore) => Promise<void>,
) {
  await withTempDir(async (dir) => {
    const store = new KanbanStore(dir);
    const port = 24700 + Math.floor(Math.random() * 100);
    const { stop, port: actualPort } = createServer(
      store,
      port,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      questionMonitor,
    );
    const baseUrl = `http://localhost:${actualPort}`;
    try {
      await callback(baseUrl, store);
    } finally {
      stop();
    }
  });
}

/**
 * Creates a mock that holds questions and removes them on reply/reject
 * (simulating real QuestionMonitor behavior).
 */
function createMockQuestionMonitorWithState(initialQuestions: QuestionRequest[]) {
  const questions = [...initialQuestions];
  return {
    getQuestions: () => [...questions],
    reply: async (id: string) => {
      const idx = questions.findIndex(q => q.id === id);
      if (idx === -1) return false;
      questions.splice(idx, 1);
      return true;
    },
    reject: async (id: string) => {
      const idx = questions.findIndex(q => q.id === id);
      if (idx === -1) return false;
      questions.splice(idx, 1);
      return true;
    },
    addMockQuestion: (question: QuestionRequest) => {
      questions.push(question);
    },
    removeQuestion: (id: string) => {
      const idx = questions.findIndex(q => q.id === id);
      if (idx === -1) return false;
      questions.splice(idx, 1);
      return true;
    },
    start: () => {},
    stop: () => {},
  } as unknown as QuestionMonitor;
}

describe('Question History Integration (Phase 2)', () => {
  test('reply records Q&A history to card progressSummary', async () => {
    const q1 = makeQuestion('q1', 'Which color?');
    const monitor = createMockQuestionMonitorWithState([q1]);

    await withQuestionServerAndStore(monitor, async (url, store) => {
      // Create a card with matching sessionId
      const card = await store.createCard({
        title: 'Test Task',
        description: 'A task',
        sessionId: 'sess-q1',
      });

      const res = await fetch(`${url}/api/questions/q1/reply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ answers: [['Red']] }),
      });
      expect(res.status).toBe(200);
      const data = (await res.json()) as { ok: boolean };
      expect(data.ok).toBe(true);

      // Verify progressSummary was updated
      const updated = await store.getCard(card.id);
      expect(updated).not.toBeNull();
      expect(updated!.progressSummary).toContain('✅ Question answered');
      expect(updated!.progressSummary).toContain('Q: Header — Which color?');
      expect(updated!.progressSummary).toContain('A: Red');
    });
  });

  test('reject records rejection to card progressSummary', async () => {
    const q1 = makeQuestion('q1', 'Pick framework');
    const monitor = createMockQuestionMonitorWithState([q1]);

    await withQuestionServerAndStore(monitor, async (url, store) => {
      const card = await store.createCard({
        title: 'Test Task',
        description: 'A task',
        sessionId: 'sess-q1',
      });

      const res = await fetch(`${url}/api/questions/q1/reject`, {
        method: 'POST',
      });
      expect(res.status).toBe(200);
      const data = (await res.json()) as { ok: boolean };
      expect(data.ok).toBe(true);

      const updated = await store.getCard(card.id);
      expect(updated).not.toBeNull();
      expect(updated!.progressSummary).toContain('❌ Question rejected');
      expect(updated!.progressSummary).toContain('Q: Header — Pick framework');
    });
  });

  test('reply with no matching card does not error', async () => {
    // Question has sessionID 'sess-q1' but no card exists with that sessionId
    const q1 = makeQuestion('q1');
    const monitor = createMockQuestionMonitorWithState([q1]);

    await withQuestionServerAndStore(monitor, async (url, store) => {
      const res = await fetch(`${url}/api/questions/q1/reply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ answers: [['A']] }),
      });
      expect(res.status).toBe(200);
      const data = (await res.json()) as { ok: boolean };
      expect(data.ok).toBe(true);

      // No cards should have progressSummary updated (no matching card)
      const cards = await store.getCards();
      expect(cards).toHaveLength(0);
    });
  });

  test('history format includes timestamp, question text, and answers', async () => {
    const q1: QuestionRequest = {
      id: 'q-fmt',
      sessionID: 'sess-fmt',
      questions: [
        {
          question: 'Pick a language',
          header: 'Language',
          options: [
            { label: 'TypeScript', description: 'TS' },
            { label: 'Rust', description: 'RS' },
          ],
        },
        {
          question: 'Pick a runtime',
          header: 'Runtime',
          options: [
            { label: 'Bun', description: 'Fast' },
            { label: 'Node', description: 'Classic' },
          ],
        },
      ],
    };
    const monitor = createMockQuestionMonitorWithState([q1]);

    await withQuestionServerAndStore(monitor, async (url, store) => {
      await store.createCard({
        title: 'Multi-Q Task',
        description: 'Testing multi-question format',
        sessionId: 'sess-fmt',
      });

      await fetch(`${url}/api/questions/q-fmt/reply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ answers: [['TypeScript'], ['Bun']] }),
      });

      const cards = await store.getCards();
      const card = cards.find(c => c.sessionId === 'sess-fmt');
      expect(card).toBeDefined();
      const summary = card!.progressSummary!;

      // Verify ISO timestamp format
      expect(summary).toMatch(/\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
      // Verify both questions and answers are present
      expect(summary).toContain('Q: Language — Pick a language');
      expect(summary).toContain('A: TypeScript');
      expect(summary).toContain('Q: Runtime — Pick a runtime');
      expect(summary).toContain('A: Bun');
    });
  });

  test('reply appends to existing progressSummary', async () => {
    const q1 = makeQuestion('q1', 'Pick one');
    const monitor = createMockQuestionMonitorWithState([q1]);

    await withQuestionServerAndStore(monitor, async (url, store) => {
      const card = await store.createCard({
        title: 'Test Task',
        description: 'A task',
        sessionId: 'sess-q1',
      });
      await store.updateCard(card.id, { progressSummary: 'Previous progress notes' });

      await fetch(`${url}/api/questions/q1/reply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ answers: [['A']] }),
      });

      const updated = await store.getCard(card.id);
      expect(updated).not.toBeNull();
      // Should start with existing content
      expect(updated!.progressSummary).toStartWith('Previous progress notes');
      // Should also contain new Q&A
      expect(updated!.progressSummary).toContain('✅ Question answered');
      expect(updated!.progressSummary).toContain('A: A');
    });
  });
});
