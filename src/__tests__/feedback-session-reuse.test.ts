import { describe, test, expect } from 'bun:test';
import { KanbanStore } from '../core/store';
import { createRouteHandler } from '../server/routes';
import { withTempDir } from './setup';

/**
 * Tests for feedback session reuse behavior.
 *
 * When a card has `feedbackForCardId` set, dispatchCard() should reuse the
 * original card's sessionId instead of creating a new session. This test
 * suite verifies the store-level state transitions that enable this.
 *
 * The actual dispatchCard() is an internal closure in plugin/index.ts, so
 * we test via the dispatch server route with a controlled dispatchFn that
 * simulates the session reuse logic.
 */

/**
 * Simulates the session reuse decision logic from dispatchCard().
 * This mirrors the logic in src/plugin/index.ts lines 41-65.
 */
async function resolveSessionId(
  store: KanbanStore,
  card: { feedbackForCardId?: string | null; queueSessionMode?: 'new_session' | 'continue_queued_after_session'; queuedAfterCardId?: string },
): Promise<{ sessionId: string; reused: boolean }> {
  if (card.feedbackForCardId) {
    const originalCard = await store.getCard(card.feedbackForCardId);
    if (originalCard?.sessionId) {
      return { sessionId: originalCard.sessionId, reused: true };
    }
  }

  if (card.queueSessionMode === 'continue_queued_after_session' && card.queuedAfterCardId) {
    const predecessor = await store.getCard(card.queuedAfterCardId);
    if (predecessor?.sessionId && predecessor.status !== 'in_progress') {
      return { sessionId: predecessor.sessionId, reused: true };
    }
  }

  // Fallback: would create new session — simulate with a generated ID
  return { sessionId: `new-session-${Date.now()}`, reused: false };
}

describe('Feedback Session Reuse', () => {
  test('feedback card reuses original card sessionId', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);

      // 1. Create original card (completed with sessionId)
      const original = await store.createCard({
        title: 'Original task',
        description: 'Do the thing',
        sessionId: 'ses-original-123',
      });
      await store.updateCard(original.id, { status: 'complete' });

      // 2. Create feedback card linked to original
      const feedback = await store.createCard({
        title: 'Feedback for original',
        description: 'Please also do X',
        agentType: 'Hephaestus (Deep Agent)',
        feedbackForCardId: original.id,
      });

      // 3. Resolve session — should reuse original's sessionId
      const { sessionId, reused } = await resolveSessionId(store, feedback);
      expect(reused).toBe(true);
      expect(sessionId).toBe('ses-original-123');
      expect(feedback.agentType).toBe('hephaestus');
    });
  });

  test('fallback when original card has no sessionId', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);

      // 1. Create original card WITHOUT sessionId
      const original = await store.createCard({
        title: 'Original task (no session)',
        description: 'Created without dispatch',
      });
      await store.updateCard(original.id, { status: 'complete' });

      // 2. Create feedback card linked to original
      const feedback = await store.createCard({
        title: 'Feedback for sessionless card',
        description: 'Some feedback',
        feedbackForCardId: original.id,
      });

      // 3. Resolve session — should NOT reuse (no sessionId on original)
      const { reused } = await resolveSessionId(store, feedback);
      expect(reused).toBe(false);
    });
  });

  test('non-feedback cards do not attempt session reuse', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);

      // 1. Create a regular card (no feedbackForCardId)
      const regular = await store.createCard({
        title: 'Regular task',
        description: 'Normal task, not feedback',
      });

      // 2. Resolve session — should create new (no reuse)
      const { reused } = await resolveSessionId(store, regular);
      expect(reused).toBe(false);
    });
  });

  test('queued card can reuse predecessor session when explicitly requested', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);

      const predecessor = await store.createCard({
        title: 'Predecessor',
        description: 'Already completed',
        sessionId: 'ses-queued-prev',
      });
      await store.updateCard(predecessor.id, { status: 'complete' });

      const queued = await store.createCard({
        title: 'Queued follow-up',
        description: 'Use same thread',
      });
      await store.updateCard(queued.id, {
        queuedAfterCardId: predecessor.id,
        queuePosition: 1,
        queueSessionMode: 'continue_queued_after_session',
      });

      const resolved = await resolveSessionId(store, (await store.getCard(queued.id))!);
      expect(resolved.reused).toBe(true);
      expect(resolved.sessionId).toBe('ses-queued-prev');
    });
  });

  test('queued card falls back to new session while predecessor is still in progress', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);

      const predecessor = await store.createCard({
        title: 'Active predecessor',
        description: 'Still running',
        sessionId: 'ses-active-prev',
      });
      await store.updateCard(predecessor.id, { status: 'in_progress' });

      const queued = await store.createCard({
        title: 'Queued follow-up',
        description: 'Should not collide',
      });
      await store.updateCard(queued.id, {
        queuedAfterCardId: predecessor.id,
        queuePosition: 1,
        queueSessionMode: 'continue_queued_after_session',
      });

      const resolved = await resolveSessionId(store, (await store.getCard(queued.id))!);
      expect(resolved.reused).toBe(false);
      expect(resolved.sessionId.startsWith('new-session-')).toBe(true);
    });
  });

  test('feedback session reuse stays higher priority than queue session mode', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);

      const feedbackSource = await store.createCard({
        title: 'Original completed task',
        description: 'Original',
        sessionId: 'ses-feedback-source',
      });
      await store.updateCard(feedbackSource.id, { status: 'complete' });

      const queueSource = await store.createCard({
        title: 'Queue predecessor',
        description: 'Different session',
        sessionId: 'ses-queue-source',
      });
      await store.updateCard(queueSource.id, { status: 'complete' });

      const queuedFeedback = await store.createCard({
        title: 'Queued feedback',
        description: 'Should prefer feedback session',
        feedbackForCardId: feedbackSource.id,
      });
      await store.updateCard(queuedFeedback.id, {
        queuedAfterCardId: queueSource.id,
        queuePosition: 1,
        queueSessionMode: 'continue_queued_after_session',
      });

      const resolved = await resolveSessionId(store, (await store.getCard(queuedFeedback.id))!);
      expect(resolved.reused).toBe(true);
      expect(resolved.sessionId).toBe('ses-feedback-source');
    });
  });

  test('fallback when feedbackForCardId points to non-existent card', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);

      // 1. Create feedback card pointing to non-existent original
      const feedback = await store.createCard({
        title: 'Feedback for deleted card',
        description: 'Original was deleted',
        feedbackForCardId: 'non-existent-card-id',
      });

      // 2. Resolve session — should NOT reuse (original doesn't exist)
      const { reused } = await resolveSessionId(store, feedback);
      expect(reused).toBe(false);
    });
  });

  test('feedback session reuse depends on feedbackForCardId, not description wrapper text', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);

      const original = await store.createCard({
        title: 'Original task',
        description: 'Original result body',
        sessionId: 'ses-original-wrapper',
      });
      await store.updateCard(original.id, { status: 'complete' });

      const feedback = await store.createCard({
        title: 'Feedback task',
        description: 'Completely rewritten feedback body without legacy wrapper markers',
        feedbackForCardId: original.id,
      });

      const { sessionId, reused } = await resolveSessionId(store, feedback);
      expect(reused).toBe(true);
      expect(sessionId).toBe('ses-original-wrapper');
    });
  });
});

describe('Feedback Session Reuse: Server Dispatch Route', () => {
  test('dispatch route calls dispatchFn with correct card ID for feedback card', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);

      // 1. Create original completed card
      const original = await store.createCard({
        title: 'Original',
        description: 'Original work',
        sessionId: 'ses-original-456',
      });
      await store.updateCard(original.id, { status: 'complete' });

      // 2. Create feedback card in todo status (dispatch requires todo)
      const feedback = await store.createCard({
        title: 'Feedback',
        description: 'Do more',
        feedbackForCardId: original.id,
      });

      // 3. Create server with a dispatchFn that captures the card and
      //    simulates session reuse logic
      let dispatchedCardId = null as string | null;
      let resolvedSessionId = null as string | null;

      const dispatchFn = async (cardId: string) => {
        dispatchedCardId = cardId;
        const card = await store.getCard(cardId);
        if (!card) throw new Error('Card not found');

        const { sessionId } = await resolveSessionId(store, card);
        resolvedSessionId = sessionId;

        // Simulate what dispatchCard does: update card status
        await store.updateCard(cardId, {
          status: 'in_progress',
          sessionId,
        });

        return { sessionId, runId: 'run-feedback', startedAt: new Date().toISOString() };
      };

      const { handleRequest } = createRouteHandler(store, dispatchFn);

      // 4. Dispatch the feedback card
      const res = await handleRequest(
        new Request(`http://localhost/api/cards/${feedback.id}/dispatch`, {
          method: 'POST',
        })
      );
      expect(res.status).toBe(200);

      // 5. Verify dispatchFn was called with feedback card
      expect(dispatchedCardId).toBe(feedback.id);

      // 6. Verify session reuse happened
      expect(resolvedSessionId).toBe('ses-original-456');

      // 7. Verify card was updated with reused sessionId
      const updatedCard = await store.getCard(feedback.id);
      expect(updatedCard!.status).toBe('in_progress');
      expect(updatedCard!.sessionId).toBe('ses-original-456');
    });
  });

  test('dispatch route rejects non-todo cards', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);

      const card = await store.createCard({
        title: 'Already started',
        description: 'In progress',
      });
      await store.updateCard(card.id, { status: 'in_progress' });

      const dispatchFn = async (_cardId: string) => {
        return { sessionId: 'ses-should-not-reach', runId: 'run-unreachable', startedAt: new Date().toISOString() };
      };

      const { handleRequest } = createRouteHandler(store, dispatchFn);

      const res = await handleRequest(
        new Request(`http://localhost/api/cards/${card.id}/dispatch`, {
          method: 'POST',
        })
      );
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain('todo');
    });
  });
});
