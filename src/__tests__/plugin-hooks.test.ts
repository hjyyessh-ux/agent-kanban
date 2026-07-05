import { describe, test, expect, mock, afterEach } from 'bun:test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KanbanStore } from '../core/store';
import { withTempDir } from './setup';
import { createEventHooks } from '../plugin/hooks/index';
import { trackDispatch, clearDispatch } from '../plugin/hooks/dispatch-tracker';
import { markSessionActive, resetObservedActiveSessions } from '../plugin/hooks/session-activity-registry';
import { _testing as commandTrackerTesting, clearCommandWindow } from '../plugin/hooks/command-tracker';
import { SettingsStore } from '../core/settings-store';
import {
  getSubagentParent,
  registerSubagentParent,
} from '../plugin/hooks/subagent-parent-registry';
import { isCommandGeneratedPrompt } from '../plugin/hooks/chat-message';
import { WIKI_INTERNAL_MARKER, buildTriagePrompt } from '../plugin/wiki/wiki-prompts';
import { sweepWikiInternalCards } from '../plugin/wiki/wiki-sweep';
import type { PluginInput } from '@opencode-ai/plugin';
import type { UserMessage, Part, Event } from '@opencode-ai/sdk';

// Mock PluginInput — client.session.messages is used by event-handler
function createMockInput(
  sessionMessages?: Record<string, Array<{ info: { role: string }; parts: Part[] }>>,
  directory = '/tmp/test-project',
): PluginInput {
  return {
    client: {
      session: {
        messages: async ({ path }: { path: { id: string } }) => {
          const messages = sessionMessages?.[path.id] ?? [];
          return { data: messages };
        },
      },
    },
    project: {},
    directory,
    worktree: directory,
    serverUrl: new URL('http://localhost:4000'),
    $: {},
  } as unknown as PluginInput;
}

// Default mock with no session messages (backward-compatible)
const mockInput = createMockInput();

afterEach(() => {
  commandTrackerTesting.commandMap.clear();
  commandTrackerTesting.commandWindowMap.clear();
  clearCommandWindow('session-cmd');
  clearCommandWindow('session-consume');
  clearCommandWindow('session-other');
  clearCommandWindow('session-command-only');
  clearCommandWindow('session-command-subagent');
  clearCommandWindow('session-command-parent');
  clearCommandWindow('session-command-other');
  clearCommandWindow('session-command-with-prompt');
  delete process.env.KANBAN_RUNTIME_DEBUG_LOG_FILE;
});

function createUserMessage(overrides: Partial<UserMessage> = {}): UserMessage {
  return {
    id: 'msg-1',
    sessionID: 'session-abc',
    role: 'user',
    time: { created: Date.now() },
    agent: 'build',
    model: { providerID: 'anthropic', modelID: 'claude-sonnet-4-20250514' },
    ...overrides,
  };
}

function createTextPart(text: string): Part {
  return {
    id: 'part-1',
    sessionID: 'session-abc',
    messageID: 'msg-1',
    type: 'text',
    text,
  };
}

describe('chat.message hook', () => {
  test('creates TODO card from user message and moves to in_progress', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const hooks = createEventHooks(store, mockInput);

      const message = createUserMessage();
      const parts: Part[] = [createTextPart('Implement login feature')];

      await hooks['chat.message']!(
        {
          sessionID: 'session-abc',
          agent: 'build',
          model: { providerID: 'anthropic', modelID: 'claude-sonnet-4-20250514' },
          messageID: 'msg-1',
        },
        { message, parts },
      );

      const cards = await store.getCards();
      expect(cards).toHaveLength(1);
      expect(cards[0].title).toContain('Implement login feature');
      expect(cards[0].status).toBe('in_progress');
      expect(cards[0].sessionId).toBe('session-abc');
    });
  });

  test('skips card creation for internal wiki worker prompts (no feedback loop)', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const hooks = createEventHooks(store, mockInput);

      const message = createUserMessage();
      // A real wiki triage prompt carries the internal sentinel.
      const wikiPrompt = buildTriagePrompt({ key: 'card:x', cards: [] });
      expect(wikiPrompt).toContain(WIKI_INTERNAL_MARKER);
      const parts: Part[] = [createTextPart(wikiPrompt)];

      await hooks['chat.message']!(
        {
          sessionID: 'wiki-codex-session',
          agent: 'build',
          model: { providerID: 'openai', modelID: 'gpt-5.5' },
          messageID: 'msg-wiki-1',
        },
        { message, parts },
      );

      const cards = await store.getCards();
      expect(cards).toHaveLength(0);
    });
  });

  test('sweepWikiInternalCards hides legacy marker cards and keeps them out of the wiki queue', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);

      // A normal card that must survive untouched.
      const normalCard = await store.createCard({
        title: 'real work',
        description: 'a genuine task',
      });

      // A legacy wiki-internal card minted before the createCard guard existed.
      // The guard now refuses to persist marker-prefixed cards, so seed it
      // directly onto the board to reproduce a card already sitting on disk.
      const wikiCardId = 'legacy-wiki-card';
      const board = await store.load();
      const base = board.cards.find((c) => c.id === normalCard.id)!;
      board.cards.push({
        ...base,
        id: wikiCardId,
        title: `${WIKI_INTERNAL_MARKER} triage prompt`,
        description: `${WIKI_INTERNAL_MARKER}\n분류자 프롬프트 본문`,
      });
      await store.save(board);

      const swept = await sweepWikiInternalCards(store);
      expect(swept).toBe(1);

      // Hidden from the board; the normal card stays.
      const visible = await store.getCards();
      expect(visible.map((c) => c.id)).toEqual([normalCard.id]);

      // Idempotent: a second pass finds nothing.
      expect(await sweepWikiInternalCards(store)).toBe(0);

      // Even forced to done + archived, the swept card never enters the wiki
      // processing queue (archive skips soft-deleted cards entirely).
      await store.updateCard(wikiCardId, { status: 'done' });
      await store.archiveCards();
      const pending = await store.getWikiPendingCards();
      expect(pending.some((c) => c.id === wikiCardId)).toBe(false);
    });
  });

  test('createCard skips marker-prefixed cards but keeps cards that merely quote it', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);

      // Marker at the start (a wiki worker one-shot prompt) → never persisted.
      await store.createCard({
        title: `${WIKI_INTERNAL_MARKER} triage`,
        description: `${WIKI_INTERNAL_MARKER}\nbody`,
      });
      // A human card that merely quotes the marker mid-text → survives.
      const quoting = await store.createCard({
        title: 'How the wiki marker works',
        description: `We use ${WIKI_INTERNAL_MARKER} to flag internal prompts`,
      });

      const cards = await store.getCards();
      expect(cards.map((c) => c.id)).toEqual([quoting.id]);
    });
  });

  test('sets projectDir and model from context', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const hooks = createEventHooks(store, mockInput);

      const message = createUserMessage({
        model: { providerID: 'anthropic', modelID: 'claude-sonnet-4-20250514' },
      });
      const parts: Part[] = [createTextPart('Fix the bug')];

      await hooks['chat.message']!(
        {
          sessionID: 'session-xyz',
          model: { providerID: 'anthropic', modelID: 'claude-sonnet-4-20250514' },
        },
        { message, parts },
      );

      const cards = await store.getCards();
      expect(cards).toHaveLength(1);
      expect(cards[0].projectDir).toBe('/tmp/test-project');
      expect(cards[0].model).toBe('anthropic/claude-sonnet-4-20250514');
    });
  });

  test('ignores non-user messages (no text parts)', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const hooks = createEventHooks(store, mockInput);

      const message = createUserMessage();
      // No text parts — e.g. only tool/file parts
      const toolPart: Part = {
        id: 'part-tool',
        sessionID: 'session-abc',
        messageID: 'msg-1',
        type: 'tool',
        callID: 'call-1',
        tool: 'some_tool',
        state: { status: 'pending', input: {}, raw: '{}' },
      };

      await hooks['chat.message']!(
        { sessionID: 'session-abc' },
        { message, parts: [toolPart] },
      );

      const cards = await store.getCards();
      expect(cards).toHaveLength(0);
    });
  });

  test('truncates long messages in card title', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const hooks = createEventHooks(store, mockInput);

      const longText = 'A'.repeat(200);
      const message = createUserMessage();
      const parts: Part[] = [createTextPart(longText)];

      await hooks['chat.message']!(
        { sessionID: 'session-abc' },
        { message, parts },
      );

      const cards = await store.getCards();
      expect(cards).toHaveLength(1);
      // Title should be truncated
      expect(cards[0].title.length).toBeLessThanOrEqual(103); // 100 + '...'
    });
  });

  test('sanitizes system markers before --- separator, preserves user text after', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const hooks = createEventHooks(store, mockInput);

      const rawText = [
        '[analyze-mode]',
        '<ultrawork-mode>System instructions here</ultrawork-mode>',
        '<Role>You are an AI assistant</Role>',
        '---',
        'Deploy the new authentication service',
      ].join('\n');

      const message = createUserMessage();
      const parts: Part[] = [createTextPart(rawText)];

      await hooks['chat.message']!(
        { sessionID: 'session-sanitize-1' },
        { message, parts },
      );

      const cards = await store.getCards();
      expect(cards).toHaveLength(1);
      expect(cards[0].description).toBe('Deploy the new authentication service');
      expect(cards[0].title).toBe('Deploy the new authentication service');
      // System markers should NOT appear
      expect(cards[0].description).not.toContain('ultrawork-mode');
      expect(cards[0].description).not.toContain('analyze-mode');
      expect(cards[0].description).not.toContain('Role');
    });
  });

  test('preserves normal text without --- separator as-is', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const hooks = createEventHooks(store, mockInput);

      const rawText = 'Fix the login page CSS alignment issue';

      const message = createUserMessage();
      const parts: Part[] = [createTextPart(rawText)];

      await hooks['chat.message']!(
        { sessionID: 'session-sanitize-2' },
        { message, parts },
      );

      const cards = await store.getCards();
      expect(cards).toHaveLength(1);
      expect(cards[0].description).toBe('Fix the login page CSS alignment issue');
    });
  });

  test('detects command-generated prompt wrappers', () => {
    expect(isCommandGeneratedPrompt('<command-instruction>\ninternal')).toBe(true);
    expect(isCommandGeneratedPrompt('<user-task>\ninternal')).toBe(true);
    expect(isCommandGeneratedPrompt('[SYSTEM DIRECTIVE: OH-MY-OPENCODE - RALPH LOOP 2/100]\ncontinue')).toBe(true);
    expect(isCommandGeneratedPrompt('## Anti-Patterns\n- Internal guidance')).toBe(true);
    expect(isCommandGeneratedPrompt('**Remember: Refactoring without tests is reckless. Refactoring without understanding is destructive.**')).toBe(true);
    expect(isCommandGeneratedPrompt('## Plan Not Found\nCould not find a plan matching ...')).toBe(true);
    expect(isCommandGeneratedPrompt('## Active Work Session Found\n\n**Status**: RESUMING existing work')).toBe(true);
    expect(isCommandGeneratedPrompt('Real user follow-up request')).toBe(false);
  });

  test('strips mixed XML tags from user text segment', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const hooks = createEventHooks(store, mockInput);

      const rawText = [
        '<Behavior_Instructions>Do stuff</Behavior_Instructions>',
        '<!-- OMO_INTERNAL_MARKER -->',
        '---',
        'Refactor the database <Constraints>leftover tag</Constraints> layer',
      ].join('\n');

      const message = createUserMessage();
      const parts: Part[] = [createTextPart(rawText)];

      await hooks['chat.message']!(
        { sessionID: 'session-sanitize-3' },
        { message, parts },
      );

      const cards = await store.getCards();
      expect(cards).toHaveLength(1);
      expect(cards[0].description).toBe('Refactor the database  layer');
      expect(cards[0].description).not.toContain('Constraints');
      expect(cards[0].description).not.toContain('OMO_INTERNAL');
    });
  });

  test('skips card creation when text is purely system markers', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const hooks = createEventHooks(store, mockInput);

      const rawText = [
        '[analyze-mode]',
        '<ultrawork-mode>Only system content</ultrawork-mode>',
        '<Role>AI assistant</Role>',
        '<!-- internal comment -->',
      ].join('\n');

      const message = createUserMessage();
      const parts: Part[] = [createTextPart(rawText)];

      await hooks['chat.message']!(
        { sessionID: 'session-sanitize-4' },
        { message, parts },
      );

      const cards = await store.getCards();
      expect(cards).toHaveLength(0); // No card created
    });
  });

  test('skips card creation when text is a bracket-mode block with multi-line instructions', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const hooks = createEventHooks(store, mockInput);

      const rawText = [
        '[search-mode]',
        'MAXIMIZE SEARCH EFFORT. Launch multiple background agents IN PARALLEL:',
        '- explore agents (codebase patterns, file structures, ast-grep)',
        '- librarian agents (remote repos, official docs, GitHub examples)',
        'Plus direct tools: Grep, ripgrep (rg), ast-grep (sg)',
        'NEVER stop at first result - be exhaustive.',
      ].join('\n');

      const message = createUserMessage();
      const parts: Part[] = [createTextPart(rawText)];

      await hooks['chat.message']!(
        { sessionID: 'session-sanitize-block-1' },
        { message, parts },
      );

      const cards = await store.getCards();
      expect(cards).toHaveLength(0);
    });
  });

  test('skips card creation when text has multiple bracket-mode blocks with no user content', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const hooks = createEventHooks(store, mockInput);

      const rawText = [
        '[search-mode]',
        'MAXIMIZE SEARCH EFFORT.',
        '---',
        '',
        '[analyze-mode]',
        'ANALYSIS MODE. Gather context before diving deep.',
        '',
        'CONTEXT GATHERING (parallel):',
        '- 1-2 explore agents',
        '- 1-2 librarian agents',
      ].join('\n');

      const message = createUserMessage();
      const parts: Part[] = [createTextPart(rawText)];

      await hooks['chat.message']!(
        { sessionID: 'session-sanitize-block-2' },
        { message, parts },
      );

      const cards = await store.getCards();
      expect(cards).toHaveLength(0);
    });
  });

  test('skips card creation when text is standalone lowercase system markers only', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const hooks = createEventHooks(store, mockInput);

      const rawText = [
        '<system-reminder>',
        '</system-reminder>',
        '<analyze-mode>',
        '<ultrawork-mode>',
      ].join('\n');

      const message = createUserMessage();
      const parts: Part[] = [createTextPart(rawText)];

      await hooks['chat.message']!(
        { sessionID: 'session-sanitize-lowercase-1' },
        { message, parts },
      );

      const cards = await store.getCards();
      expect(cards).toHaveLength(0);
    });
  });

  test('preserves user text when standalone system markers wrap real content', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const hooks = createEventHooks(store, mockInput);

      const rawText = [
        '<system-reminder>',
        'Please investigate the queue behavior',
        '</system-reminder>',
      ].join('\n');

      const message = createUserMessage();
      const parts: Part[] = [createTextPart(rawText)];

      await hooks['chat.message']!(
        { sessionID: 'session-sanitize-lowercase-2' },
        { message, parts },
      );

      const cards = await store.getCards();
      expect(cards).toHaveLength(1);
      expect(cards[0].description).toBe('Please investigate the queue behavior');
    });
  });

  test('preserves user text after bracket-mode block separated by ---', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const hooks = createEventHooks(store, mockInput);

      const rawText = [
        '[search-mode]',
        'MAXIMIZE SEARCH EFFORT.',
        '---',
        '',
        '[analyze-mode]',
        'ANALYSIS MODE.',
        '---',
        '',
        'Search mode, Analyze mode 가 새로운 카드로 등록됨',
      ].join('\n');

      const message = createUserMessage();
      const parts: Part[] = [createTextPart(rawText)];

      await hooks['chat.message']!(
        { sessionID: 'session-sanitize-block-3' },
        { message, parts },
      );

      const cards = await store.getCards();
      expect(cards).toHaveLength(1);
      expect(cards[0].description).toBe('Search mode, Analyze mode 가 새로운 카드로 등록됨');
    });
  });

  test('creates card for any agent including sub-agents', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const hooks = createEventHooks(store, mockInput);

      const message = createUserMessage();
      const parts: Part[] = [createTextPart('Analyze this file...')];

      // All agents should create cards
      await hooks['chat.message']!(
        { sessionID: 'session-sub', agent: 'explore' },
        { message, parts },
      );

      const cards = await store.getCards();
      expect(cards).toHaveLength(1);
      expect(cards[0].description).toBe('Analyze this file...');
    });
  });

  test('creates card for primary build agent', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const hooks = createEventHooks(store, mockInput);

      const message = createUserMessage();
      const parts: Part[] = [createTextPart('Deploy new service')];

      // Explicit 'build' agent should create a card
      await hooks['chat.message']!(
        { sessionID: 'session-build', agent: 'build' },
        { message, parts },
      );

      const cards = await store.getCards();
      expect(cards).toHaveLength(1);
      expect(cards[0].description).toBe('Deploy new service');
    });
  });

  test('creates card when agent is undefined (default agent)', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const hooks = createEventHooks(store, mockInput);

      const message = createUserMessage();
      const parts: Part[] = [createTextPart('Fix the API endpoint')];

      // No agent field = default agent, should create a card
      await hooks['chat.message']!(
        { sessionID: 'session-default' },
        { message, parts },
      );

      const cards = await store.getCards();
      expect(cards).toHaveLength(1);
      expect(cards[0].description).toBe('Fix the API endpoint');
    });
  });

  test('creates cards for all agent types', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const hooks = createEventHooks(store, mockInput);

      const agents = ['explore', 'librarian', 'plan', 'general', 'oracle'];

      for (const agent of agents) {
        const message = createUserMessage({ id: `msg-${agent}`, sessionID: `session-${agent}` });
        const parts: Part[] = [createTextPart(`Task from ${agent}`)];
        await hooks['chat.message']!(
          { sessionID: `session-${agent}`, agent, messageID: `msg-${agent}` },
          { message, parts },
        );
      }

      const cards = await store.getCards();
      expect(cards).toHaveLength(5); // All agents create cards
    });
  });

  test('creates separate cards for same session with different messageIDs (per-message dedup)', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const hooks = createEventHooks(store, mockInput);

      const message = createUserMessage({ sessionID: 'session-same' });

      // First message in session — creates a card
      await hooks['chat.message']!(
        { sessionID: 'session-same', messageID: 'msg-aaa' },
        { message, parts: [createTextPart('First task in session')] },
      );

      // Second message in same session, different messageID — creates another card
      await hooks['chat.message']!(
        { sessionID: 'session-same', messageID: 'msg-bbb' },
        { message, parts: [createTextPart('Second task in session')] },
      );

      const cards = await store.getCards();
      expect(cards).toHaveLength(2); // Each message creates its own card
      const titles = cards.map(c => c.title).sort();
      expect(titles).toContain('First task in session');
      expect(titles).toContain('Second task in session');
      // Both share the same session
      expect(cards.every(c => c.sessionId === 'session-same')).toBe(true);
    });
  });

  test('deduplicates cards with identical messageID (prevents double-creation)', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const hooks = createEventHooks(store, mockInput);

      const message = createUserMessage({ sessionID: 'session-dedup' });

      // Fire the same messageID twice (simulates retry/replay)
      await hooks['chat.message']!(
        { sessionID: 'session-dedup', messageID: 'msg-dup' },
        { message, parts: [createTextPart('Deploy the service')] },
      );

      await hooks['chat.message']!(
        { sessionID: 'session-dedup', messageID: 'msg-dup' },
        { message, parts: [createTextPart('Deploy the service')] },
      );

      const cards = await store.getCards();
      expect(cards).toHaveLength(1); // Only one card despite two invocations
      expect(cards[0].title).toBe('Deploy the service');
      expect(cards[0].messageId).toBe('msg-dup');
    });
  });

  test('skips duplicate creation when claude-code already created same-session same-prompt card', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const hooks = createEventHooks(store, mockInput);

      await store.createCard({
        title: 'Test just say hi',
        description: 'Test just say hi',
        sessionId: 'ses_123',
        sourceContext: 'claude-code',
        model: 'claude-sonnet-4-6',
      });

      const message = createUserMessage({ id: 'msg-claude-dedup', sessionID: 'ses_123' });

      await hooks['chat.message']!(
        {
          sessionID: 'ses_123',
          agent: 'Hephaestus',
          model: { providerID: 'github-copilot', modelID: 'gpt-5.4' },
          messageID: 'msg-claude-dedup',
        },
        { message, parts: [createTextPart('Test just say hi')] },
      );

      const cards = await store.getCards();
      expect(cards).toHaveLength(1);
      expect(cards[0].sourceContext).toBe('claude-code');
      expect(cards[0].messageId).toBeUndefined();
    });
  });
});

describe('session.idle event handler', () => {
  afterEach(() => {
    resetObservedActiveSessions();
  });

  test('duplicate session.idle events are idempotent after activity is cleared', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const onSessionComplete = mock(async () => {});
      const hooks = createEventHooks(store, createMockInput({
        'session-idempotent': [
          {
            info: { role: 'assistant' },
            parts: [createTextPart('Done exactly once.')],
          },
        ],
      }), undefined, undefined, onSessionComplete);

      const card = await store.createCard({
        title: 'Idempotent task',
        description: 'Idempotent task',
        sessionId: 'session-idempotent',
      });
      await store.updateCard(card.id, { status: 'in_progress' });

      const event: Event = {
        type: 'session.idle',
        properties: { sessionID: 'session-idempotent' },
      };

      markSessionActive('session-idempotent');
      await hooks.event!({ event });
      await hooks.event!({ event });

      const updated = await store.getCard(card.id);
      expect(updated!.status).toBe('complete');
      expect(updated!.result).toBe('Done exactly once.');
      expect(onSessionComplete).toHaveBeenCalledTimes(1);
    });
  });

  test('updates in_progress card to complete', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const hooks = createEventHooks(store, mockInput);

      // Create a card and set it to in_progress with a session
      const card = await store.createCard({
        title: 'Working task',
        description: 'Some work',
        sessionId: 'session-abc',
      });
      await store.updateCard(card.id, { status: 'in_progress' });

      const event: Event = {
        type: 'session.idle',
        properties: { sessionID: 'session-abc' },
      };

      markSessionActive('session-abc');
      await hooks.event!({ event });

      const updated = await store.getCard(card.id);
      expect(updated!.status).toBe('complete');
    });
  });

  test('updates existing in_progress card matching sessionID', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const hooks = createEventHooks(store, mockInput);

      // Create cards for different sessions
      const card1 = await store.createCard({
        title: 'Task for session A',
        description: 'Work A',
        sessionId: 'session-a',
      });
      await store.updateCard(card1.id, { status: 'in_progress' });

      const card2 = await store.createCard({
        title: 'Task for session B',
        description: 'Work B',
        sessionId: 'session-b',
      });
      await store.updateCard(card2.id, { status: 'in_progress' });

      // Only session-a goes idle
      const event: Event = {
        type: 'session.idle',
        properties: { sessionID: 'session-a' },
      };

      markSessionActive('session-a');
      await hooks.event!({ event });

      const updatedA = await store.getCard(card1.id);
      const updatedB = await store.getCard(card2.id);
      expect(updatedA!.status).toBe('complete');
      expect(updatedB!.status).toBe('in_progress');
    });
  });

  test('ignores non-session.idle events', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const hooks = createEventHooks(store, mockInput);

      const card = await store.createCard({
        title: 'In progress task',
        description: 'Work',
        sessionId: 'session-abc',
      });
      await store.updateCard(card.id, { status: 'in_progress' });

      const event: Event = {
        type: 'session.updated',
        properties: {
          info: {
            id: 'session-abc',
            projectID: 'proj-1',
            directory: '/tmp',
            title: 'Session',
            version: '1',
            time: { created: Date.now(), updated: Date.now() },
          },
        },
      };

      await hooks.event!({ event });

      const updated = await store.getCard(card.id);
      expect(updated!.status).toBe('in_progress');
    });
  });

  test('populates result field from last assistant message on session.idle', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const inputWithMessages = createMockInput({
        'session-result': [
          {
            info: { role: 'user' },
            parts: [createTextPart('Fix the login bug')],
          },
          {
            info: { role: 'assistant' },
            parts: [createTextPart('I fixed the login bug by updating the auth middleware.')],
          },
        ],
      });
      const hooks = createEventHooks(store, inputWithMessages);

      const card = await store.createCard({
        title: 'Fix login',
        description: 'Fix the login bug',
        sessionId: 'session-result',
      });
      await store.updateCard(card.id, { status: 'in_progress' });

      const event: Event = {
        type: 'session.idle',
        properties: { sessionID: 'session-result' },
      };

      markSessionActive('session-result');
      await hooks.event!({ event });

      const updated = await store.getCard(card.id);
      expect(updated!.status).toBe('complete');
      expect(updated!.result).toBe('I fixed the login bug by updating the auth middleware.');
    });
  });

  test('handles missing session messages gracefully (result stays empty)', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      // Mock client that returns no messages
      const inputNoMessages = createMockInput({});
      const hooks = createEventHooks(store, inputNoMessages);

      const card = await store.createCard({
        title: 'Some task',
        description: 'Do something',
        sessionId: 'session-no-msgs',
      });
      await store.updateCard(card.id, { status: 'in_progress' });

      const event: Event = {
        type: 'session.idle',
        properties: { sessionID: 'session-no-msgs' },
      };

      markSessionActive('session-no-msgs');
      await hooks.event!({ event });

      const updated = await store.getCard(card.id);
      expect(updated!.status).toBe('complete');
      expect(updated!.result).toBe('(No result captured)');
    });
  });

  test('does not complete card when session message fetch throws', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const throwingInput = {
        ...createMockInput(),
        client: {
          session: {
            messages: async () => {
              throw new Error('session lookup failed');
            },
          },
        },
      } as unknown as PluginInput;
      const hooks = createEventHooks(store, throwingInput);

      const card = await store.createCard({
        title: 'Throwing snapshot task',
        description: 'Throwing snapshot task',
        sessionId: 'session-throwing-snapshot',
      });
      await store.updateCard(card.id, { status: 'in_progress' });

      markSessionActive('session-throwing-snapshot');
      await hooks.event!({
        event: {
          type: 'session.idle',
          properties: { sessionID: 'session-throwing-snapshot' },
        },
      });

      const updated = await store.getCard(card.id);
      expect(updated!.status).toBe('in_progress');
      expect(updated!.result).toBeUndefined();
    });
  });

  test('sanitizes existing card description during transition', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const hooks = createEventHooks(store, mockInput);

      // Create a card with unsanitized system prompt description (pre-Phase 1 card)
      const rawDescription = [
        '<ultrawork-mode>System instructions</ultrawork-mode>',
        '---',
        'Deploy the new API endpoint',
      ].join('\n');

      const card = await store.createCard({
        title: '<ultrawork-mode>',
        description: rawDescription,
        sessionId: 'session-sanitize',
      });
      await store.updateCard(card.id, { status: 'in_progress' });

      const event: Event = {
        type: 'session.idle',
        properties: { sessionID: 'session-sanitize' },
      };

      markSessionActive('session-sanitize');
      await hooks.event!({ event });

      const updated = await store.getCard(card.id);
      expect(updated!.status).toBe('complete');
      // Description should now be sanitized
      expect(updated!.description).toBe('Deploy the new API endpoint');
      // Title should also be updated from sanitized content
      expect(updated!.title).toBe('Deploy the new API endpoint');
    });
  });

  test('does not change already-sanitized card description', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const hooks = createEventHooks(store, mockInput);

      const card = await store.createCard({
        title: 'Clean description',
        description: 'Already clean description',
        sessionId: 'session-clean',
      });
      await store.updateCard(card.id, { status: 'in_progress' });

      const event: Event = {
        type: 'session.idle',
        properties: { sessionID: 'session-clean' },
      };

      markSessionActive('session-clean');
      await hooks.event!({ event });

      const updated = await store.getCard(card.id);
      // Description unchanged since it was already clean
      expect(updated!.description).toBe('Already clean description');
      expect(updated!.title).toBe('Clean description');
    });
  });

  test('does not sanitize feedback card description on session.idle', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const hooks = createEventHooks(store, mockInput);

      const rawFeedbackDescription = [
        '[Feedback for: Original Card]',
        '[Original Card ID: abc12345]',
        '[Original Result: hi]',
        '---',
        'Keep this wrapper intact',
      ].join('\n');

      const card = await store.createCard({
        title: 'Feedback: Original Card',
        description: rawFeedbackDescription,
        sessionId: 'session-feedback-no-sanitize',
        feedbackForCardId: 'parent-card-id',
      });
      await store.updateCard(card.id, { status: 'in_progress' });

      const event: Event = {
        type: 'session.idle',
        properties: { sessionID: 'session-feedback-no-sanitize' },
      };

      markSessionActive('session-feedback-no-sanitize');
      await hooks.event!({ event });

      const updated = await store.getCard(card.id);
      expect(updated!.status).toBe('complete');
      expect(updated!.description).toBe(rawFeedbackDescription);
      expect(updated!.title).toBe('Feedback: Original Card');
    });
  });

  test('ignores session.idle when no session activity was observed in this process', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const hooks = createEventHooks(store, mockInput);

      const card = await store.createCard({
        title: 'Old running task',
        description: 'Still running',
        sessionId: 'session-unseen-idle',
      });
      await store.updateCard(card.id, { status: 'in_progress' });

      await hooks.event!({
        event: {
          type: 'session.idle',
          properties: { sessionID: 'session-unseen-idle' },
        },
      });

      const updated = await store.getCard(card.id);
      expect(updated!.status).toBe('in_progress');
    });
  });

  test('completes newest card and marks older same-session cards as superseded', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const inputWithMessages = createMockInput({
        'session-multi-card': [
          {
            info: { role: 'assistant' },
            parts: [createTextPart('Newest card finished.')],
          },
        ],
      });
      const hooks = createEventHooks(store, inputWithMessages);

      const older = await store.createCard({
        title: 'Older card',
        description: 'Older card',
        sessionId: 'session-multi-card',
      });
      await store.updateCard(older.id, { status: 'in_progress' });

      const unrelatedQueued = await store.createCard({
        title: 'Queued elsewhere',
        description: 'Queued elsewhere',
      });
      await store.updateCard(unrelatedQueued.id, {
        queuedAfterCardId: 'different-parent-card',
        queuePosition: 1,
      });

      const newer = await store.createCard({
        title: 'Newer card',
        description: 'Newer card',
        sessionId: 'session-multi-card',
      });
      await store.updateCard(newer.id, { status: 'in_progress' });

      markSessionActive('session-multi-card');
      await hooks.event!({
        event: {
          type: 'session.idle',
          properties: { sessionID: 'session-multi-card' },
        },
      });

      const updatedOlder = await store.getCard(older.id);
      const updatedNewer = await store.getCard(newer.id);
      expect(updatedOlder!.status).toBe('complete');
      expect(updatedOlder!.resolution).toBe('superseded');
      expect(updatedOlder!.supersededByCardId).toBe(newer.id);
      expect(updatedOlder!.result).toContain('[Superseded]');
      expect(updatedOlder!.result).toContain(newer.id);
      expect(updatedNewer!.status).toBe('complete');
      expect(updatedNewer!.resolution).toBe('completed');
      expect(updatedNewer!.result).toBe('Newest card finished.');
      expect(updatedOlder!.responseAt).toBeTruthy();
      expect(updatedNewer!.responseAt).toBeTruthy();
      expect(updatedOlder!.responseAt! < updatedNewer!.responseAt!).toBe(true);
    });
  });

  test('completes remaining same-session cards when newest card is waiting on a direct child', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const inputWithMessages = createMockInput({
        'session-waiting-parent-with-older-work': [
          {
            info: { role: 'assistant' },
            parts: [createTextPart('Older prompt was handled by the final response.')],
          },
        ],
      });
      const hooks = createEventHooks(store, inputWithMessages);

      const older = await store.createCard({
        title: 'Older prompt',
        description: 'Older prompt',
        sessionId: 'session-waiting-parent-with-older-work',
      });
      await store.updateCard(older.id, { status: 'in_progress' });

      await Bun.sleep(5);

      const waitingParent = await store.createCard({
        title: 'Newest parent prompt',
        description: 'Newest parent prompt',
        sessionId: 'session-waiting-parent-with-older-work',
      });
      await store.updateCard(waitingParent.id, { status: 'in_progress' });

      const directChild = await store.createCard({
        title: 'Direct child work',
        description: 'Direct child work',
        sessionId: 'session-child-still-running',
        parentCardId: waitingParent.id,
      });
      await store.updateCard(directChild.id, { status: 'in_progress' });

      markSessionActive('session-waiting-parent-with-older-work');
      await hooks.event!({
        event: {
          type: 'session.idle',
          properties: { sessionID: 'session-waiting-parent-with-older-work' },
        },
      });

      const updatedOlder = await store.getCard(older.id);
      const updatedParent = await store.getCard(waitingParent.id);
      const updatedChild = await store.getCard(directChild.id);
      expect(updatedOlder!.status).toBe('complete');
      expect(updatedOlder!.resolution).toBe('completed');
      expect(updatedOlder!.result).toBe('Older prompt was handled by the final response.');
      expect(updatedParent!.status).toBe('in_progress');
      expect(updatedChild!.status).toBe('in_progress');

      await store.updateCard(directChild.id, { status: 'complete' });
      await hooks.event!({
        event: {
          type: 'session.idle',
          properties: { sessionID: 'session-waiting-parent-with-older-work' },
        },
      });

      const completedParent = await store.getCard(waitingParent.id);
      expect(completedParent!.status).toBe('complete');
      expect(completedParent!.resolution).toBe('completed');
    });
  });

  test('preserves existing older result and appends superseded notice', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const inputWithMessages = createMockInput({
        'session-multi-result': [
          {
            info: { role: 'assistant' },
            parts: [createTextPart('Latest final answer.')],
          },
        ],
      });
      const hooks = createEventHooks(store, inputWithMessages);

      const older = await store.createCard({
        title: 'Older card with intermediate output',
        description: 'Older card with intermediate output',
        sessionId: 'session-multi-result',
      });
      await store.updateCard(older.id, {
        status: 'in_progress',
        result: 'Intermediate output from earlier turn.',
      });

      const newer = await store.createCard({
        title: 'Newest card output',
        description: 'Newest card output',
        sessionId: 'session-multi-result',
      });
      await store.updateCard(newer.id, { status: 'in_progress' });

      markSessionActive('session-multi-result');
      await hooks.event!({
        event: {
          type: 'session.idle',
          properties: { sessionID: 'session-multi-result' },
        },
      });

      const updatedOlder = await store.getCard(older.id);
      const updatedNewer = await store.getCard(newer.id);
      expect(updatedOlder!.status).toBe('complete');
      expect(updatedOlder!.resolution).toBe('superseded');
      expect(updatedOlder!.result).toContain('Intermediate output from earlier turn.');
      expect(updatedOlder!.result).toContain('[Superseded]');
      expect(updatedOlder!.result).toContain('다른 카드에서 처리되었습니다.');
      expect(updatedOlder!.result).toContain(updatedNewer!.id);

      expect(updatedNewer!.status).toBe('complete');
      expect(updatedNewer!.resolution).toBe('completed');
      expect(updatedNewer!.result).toBe('Latest final answer.');
    });
  });

  test('dispatches the first queued todo card when a card completes', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const dispatchFn = mock(async () => ({ sessionId: 'ses-queued-next' }));
      const hooks = createEventHooks(store, createMockInput({
        'session-queue-complete': [
          {
            info: { role: 'assistant' },
            parts: [createTextPart('Queue predecessor finished.')],
          },
        ],
      }), dispatchFn);

      const completed = await store.createCard({
        title: 'Queue predecessor',
        description: 'Queue predecessor',
        sessionId: 'session-queue-complete',
      });
      await store.updateCard(completed.id, { status: 'in_progress' });

      const queuedFirst = await store.createCard({
        title: 'Queued first',
        description: 'Queued first',
      });
      await store.updateCard(queuedFirst.id, {
        queuedAfterCardId: completed.id,
        queuePosition: 1,
      });

      const queuedSecond = await store.createCard({
        title: 'Queued second',
        description: 'Queued second',
      });
      await store.updateCard(queuedSecond.id, {
        queuedAfterCardId: completed.id,
        queuePosition: 2,
      });

      markSessionActive('session-queue-complete');
      await hooks.event!({
        event: {
          type: 'session.idle',
          properties: { sessionID: 'session-queue-complete' },
        },
      });

      const updated = await store.getCard(completed.id);
      expect(updated!.status).toBe('complete');
      expect(dispatchFn).toHaveBeenCalledTimes(1);
      expect(dispatchFn).toHaveBeenCalledWith(queuedFirst.id);
    });
  });

  test('skips non-todo queued cards and dispatches the next queued todo card', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const dispatchFn = mock(async () => ({ sessionId: 'ses-queued-todo' }));
      const hooks = createEventHooks(store, createMockInput({
        'session-queue-skip': [
          {
            info: { role: 'assistant' },
            parts: [createTextPart('Queue predecessor finished again.')],
          },
        ],
      }), dispatchFn);

      const completed = await store.createCard({
        title: 'Queue predecessor',
        description: 'Queue predecessor',
        sessionId: 'session-queue-skip',
      });
      await store.updateCard(completed.id, { status: 'in_progress' });

      const staleQueued = await store.createCard({
        title: 'Already started queued card',
        description: 'Already started queued card',
      });
      await store.updateCard(staleQueued.id, {
        status: 'in_progress',
        queuedAfterCardId: completed.id,
        queuePosition: 1,
      });

      const nextTodo = await store.createCard({
        title: 'Next todo queued card',
        description: 'Next todo queued card',
      });
      await store.updateCard(nextTodo.id, {
        queuedAfterCardId: completed.id,
        queuePosition: 2,
      });

      markSessionActive('session-queue-skip');
      await hooks.event!({
        event: {
          type: 'session.idle',
          properties: { sessionID: 'session-queue-skip' },
        },
      });

      expect(dispatchFn).toHaveBeenCalledTimes(1);
      expect(dispatchFn).toHaveBeenCalledWith(nextTodo.id);
    });
  });

  test('does not complete a top-level parent while a direct child card is still in_progress', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const dispatchFn = mock(async () => ({ sessionId: 'ses-should-not-run' }));
      const hooks = createEventHooks(store, createMockInput({
        'session-parent-active-child': [
          {
            info: { role: 'assistant' },
            parts: [createTextPart('Parent looks idle but child still runs.')],
          },
        ],
      }), dispatchFn);

      const parent = await store.createCard({
        title: 'Parent task',
        description: 'Parent task',
        sessionId: 'session-parent-active-child',
      });
      await store.updateCard(parent.id, { status: 'in_progress' });

      const child = await store.createCard({
        title: 'Explore#1',
        description: 'Child task',
        sessionId: 'session-child-active',
        parentCardId: parent.id,
        agentType: 'explore',
      });
      await store.updateCard(child.id, { status: 'in_progress' });

      const queued = await store.createCard({
        title: 'Queued after parent',
        description: 'Queued after parent',
      });
      await store.updateCard(queued.id, {
        queuedAfterCardId: parent.id,
        queuePosition: 1,
      });

      markSessionActive('session-parent-active-child');
      await hooks.event!({
        event: {
          type: 'session.idle',
          properties: { sessionID: 'session-parent-active-child' },
        },
      });

      const updatedParent = await store.getCard(parent.id);
      const updatedChild = await store.getCard(child.id);
      expect(updatedParent!.status).toBe('in_progress');
      expect(updatedParent!.result).toBeUndefined();
      expect(updatedChild!.status).toBe('in_progress');
      expect(dispatchFn).not.toHaveBeenCalled();
    });
  });

  test('completes the parent once direct child is no longer in_progress', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const hooks = createEventHooks(store, createMockInput({
        'session-parent-retry': [
          {
            info: { role: 'assistant' },
            parts: [createTextPart('Parent can finish now.')],
          },
        ],
      }));

      const parent = await store.createCard({
        title: 'Parent retry task',
        description: 'Parent retry task',
        sessionId: 'session-parent-retry',
      });
      await store.updateCard(parent.id, { status: 'in_progress' });

      const child = await store.createCard({
        title: 'Oracle#1',
        description: 'Child finished task',
        sessionId: 'session-child-retry',
        parentCardId: parent.id,
        agentType: 'oracle',
      });
      await store.updateCard(child.id, { status: 'complete' });

      markSessionActive('session-parent-retry');
      await hooks.event!({
        event: {
          type: 'session.idle',
          properties: { sessionID: 'session-parent-retry' },
        },
      });

      const updatedParent = await store.getCard(parent.id);
      expect(updatedParent!.status).toBe('complete');
      expect(updatedParent!.result).toBe('Parent can finish now.');
    });
  });
});

describe('session.created event handler', () => {
  afterEach(() => {
    resetObservedActiveSessions();
  });

  test('registers child session mapping to the newest card in the parent session when no command root exists', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const hooks = createEventHooks(store, mockInput);

      const older = await store.createCard({
        title: 'Older parent card',
        description: 'Older parent card',
        sessionId: 'session-parent-latest',
      });
      await store.updateCard(older.id, { status: 'complete' });

      await Bun.sleep(5);

      const newer = await store.createCard({
        title: 'Newest parent card',
        description: 'Newest parent card',
        sessionId: 'session-parent-latest',
      });
      await store.updateCard(newer.id, { status: 'in_progress' });

      await hooks.event!({
        event: {
          type: 'session.created',
          properties: {
            info: {
              id: 'session-child-latest-parent',
              projectID: 'project-1',
              directory: '/tmp/test-project',
              parentID: 'session-parent-latest',
              title: 'Child session',
              version: '1.0.0',
              time: {
                created: Date.now(),
                updated: Date.now(),
              },
            },
          },
        },
      });

      expect(getSubagentParent('session-child-latest-parent')?.parentCardId).toBe(newer.id);
    });
  });

  test('registers child session mapping to command-origin root over newer same-session card', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const hooks = createEventHooks(store, mockInput);

      const commandRoot = await store.createCard({
        title: 'Command root',
        description: 'Start work root card',
        sessionId: 'session-command-parent',
        command: 'start-work',
        sourceContext: '/start-work plan-abc',
      });
      await store.updateCard(commandRoot.id, { status: 'in_progress' });

      await Bun.sleep(5);

      const newerFollowUp = await store.createCard({
        title: 'Primary follow-up card',
        description: 'Follow-up in same session',
        sessionId: 'session-command-parent',
        agentType: 'build',
      });
      await store.updateCard(newerFollowUp.id, { status: 'in_progress' });

      await hooks.event!({
        event: {
          type: 'session.created',
          properties: {
            info: {
              id: 'session-command-child',
              projectID: 'project-1',
              directory: '/tmp/test-project',
              parentID: 'session-command-parent',
              title: 'Child session',
              version: '1.0.0',
              time: {
                created: Date.now(),
                updated: Date.now(),
              },
            },
          },
        },
      });

      expect(getSubagentParent('session-command-child')?.parentCardId).toBe(commandRoot.id);
    });
  });

  test('registers child session parent mapping when session has parentID', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const hooks = createEventHooks(store, mockInput);

      const parent = await store.createCard({
        title: 'Parent task',
        description: 'Main task',
        sessionId: 'session-parent-created',
        projectDir: '/tmp/test-project',
        agentType: 'Sisyphus (Ultraworker)',
      });
      await store.updateCard(parent.id, { status: 'in_progress' });

      await hooks.event!({
        event: {
          type: 'session.created',
          properties: {
            info: {
              id: 'session-child-created',
              projectID: 'project-1',
              directory: '/tmp/other-project',
              parentID: 'session-parent-created',
              title: 'Child session',
              version: '1.0.0',
              time: {
                created: Date.now(),
                updated: Date.now(),
              },
            },
          },
        },
      });

      expect(getSubagentParent('session-child-created')?.parentCardId).toBe(parent.id);
    });
  });

  test('session.idle clears child session parent mapping', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const hooks = createEventHooks(store, mockInput);

      const parent = await store.createCard({
        title: 'Parent task',
        description: 'Main task',
        sessionId: 'session-parent-idle',
        projectDir: '/tmp/test-project',
        agentType: 'Sisyphus (Ultraworker)',
      });
      await store.updateCard(parent.id, { status: 'in_progress' });

      registerSubagentParent('session-child-idle', {
        parentCardId: parent.id,
        rootCardId: parent.id,
        parentSessionId: 'session-parent-idle',
      });

      const child = await store.createCard({
        title: 'Explore#1',
        description: 'Sub work',
        sessionId: 'session-child-idle',
        parentCardId: parent.id,
        agentType: 'explore',
      });
      await store.updateCard(child.id, { status: 'in_progress' });

      markSessionActive('session-child-idle');

      await hooks.event!({
        event: {
          type: 'session.idle',
          properties: {
            sessionID: 'session-child-idle',
          },
        },
      });

      expect(getSubagentParent('session-child-idle')).toBeUndefined();
    });
  });
});

describe('command.execute.before hook', () => {
  test('tracks command and makes it available via consumeCommand', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const hooks = createEventHooks(store, mockInput);

      // Simulate a slash command being executed
      await hooks['command.execute.before']!(
        {
          command: '/start-work',
          sessionID: 'session-cmd',
          arguments: 'plan-abc',
        },
        { parts: [] },
      );

      // Now simulate a user message in the same session
      const message = createUserMessage({
        id: 'msg-cmd',
        sessionID: 'session-cmd',
      });
      const parts: Part[] = [createTextPart('Working on plan')];

      await hooks['chat.message']!(
        {
          sessionID: 'session-cmd',
          agent: 'build',
          model: { providerID: 'anthropic', modelID: 'claude-sonnet-4-20250514' },
          messageID: 'msg-cmd',
        },
        { message, parts },
      );

      const cards = await store.getCards();
      expect(cards).toHaveLength(1);
      expect(cards[0].command).toBe('start-work');
      expect(cards[0].sourceContext).toBe('/start-work plan-abc');
    });
  });

  test('command is consumed after first card creation', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const hooks = createEventHooks(store, mockInput);

      // Track a command
      await hooks['command.execute.before']!(
        {
          command: '/init-deep',
          sessionID: 'session-consume',
          arguments: '',
        },
        { parts: [] },
      );

      // First message picks up the command
      const msg1 = createUserMessage({
        id: 'msg-c1',
        sessionID: 'session-consume',
      });
      await hooks['chat.message']!(
        {
          sessionID: 'session-consume',
          agent: 'build',
          model: { providerID: 'anthropic', modelID: 'claude-sonnet-4-20250514' },
          messageID: 'msg-c1',
        },
        { message: msg1, parts: [createTextPart('First message')] },
      );

      // Command is consumed — won't appear on cards from different sessions
      const msg2 = createUserMessage({
        id: 'msg-c2',
        sessionID: 'session-other',
      });
      await hooks['chat.message']!(
        {
          sessionID: 'session-other',
          agent: 'build',
          model: { providerID: 'anthropic', modelID: 'claude-sonnet-4-20250514' },
          messageID: 'msg-c2',
        },
        { message: msg2, parts: [createTextPart('Second message')] },
      );

      const cards = await store.getCards();
      const cmdCard = cards.find(c => c.sessionId === 'session-consume');
      const otherCard = cards.find(c => c.sessionId === 'session-other');
      expect(cmdCard!.command).toBe('init-deep');
      expect(otherCard!.command).toBeUndefined();
    });
  });

  test('suppresses second primary-agent message in same session for command_only builtins', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const hooks = createEventHooks(store, mockInput);

      await hooks['command.execute.before']!(
        {
          command: '/init-deep',
          sessionID: 'session-command-only',
          arguments: 'repo-plan',
        },
        { parts: [] },
      );

      const msg1 = createUserMessage({
        id: 'msg-command-only-1',
        sessionID: 'session-command-only',
      });
      await hooks['chat.message']!(
        {
          sessionID: 'session-command-only',
          agent: 'build',
          model: { providerID: 'github-copilot', modelID: 'gpt-5.4' },
          messageID: 'msg-command-only-1',
        },
        { message: msg1, parts: [createTextPart('Initialize deep workspace')] },
      );

      const msg2 = createUserMessage({
        id: 'msg-command-only-2',
        sessionID: 'session-command-only',
      });
      await hooks['chat.message']!(
        {
          sessionID: 'session-command-only',
          agent: 'build',
          model: { providerID: 'github-copilot', modelID: 'gpt-5.4' },
          messageID: 'msg-command-only-2',
        },
        { message: msg2, parts: [createTextPart('## Anti-Patterns')] },
      );

      const cards = await store.getCards();
      expect(cards).toHaveLength(1);
      expect(cards[0].sessionId).toBe('session-command-only');
      expect(cards[0].command).toBe('init-deep');
      expect(cards[0].sourceContext).toBe('/init-deep repo-plan');
      expect(cards[0].description).toBe('Initialize deep workspace');
      expect(commandTrackerTesting.commandWindowMap.has('session-command-only')).toBe(true);
    });
  });

  test('does not suppress subagent messages during command_only window', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const hooks = createEventHooks(store, mockInput);

      await hooks['command.execute.before']!(
        {
          command: '/init-deep',
          sessionID: 'session-command-subagent',
          arguments: '',
        },
        { parts: [] },
      );

      const rootMessage = createUserMessage({
        id: 'msg-command-subagent-1',
        sessionID: 'session-command-subagent',
      });
      await hooks['chat.message']!(
        {
          sessionID: 'session-command-subagent',
          agent: 'build',
          model: { providerID: 'github-copilot', modelID: 'gpt-5.4' },
          messageID: 'msg-command-subagent-1',
        },
        { message: rootMessage, parts: [createTextPart('Initialize deep workspace')] },
      );

      const subMessage = createUserMessage({
        id: 'msg-command-subagent-2',
        sessionID: 'session-command-subagent',
      });
      await hooks['chat.message']!(
        {
          sessionID: 'session-command-subagent',
          agent: 'explore',
          model: { providerID: 'github-copilot', modelID: 'gpt-5.4' },
          messageID: 'msg-command-subagent-2',
        },
        { message: subMessage, parts: [createTextPart('Scan repository structure')] },
      );

      const cards = await store.getCards();
      expect(cards).toHaveLength(2);
      const root = cards.find(card => card.command === 'init-deep');
      const child = cards.find(card => card.agentType === 'explore');
      expect(root).toBeDefined();
      expect(child).toBeDefined();
      expect(child!.parentCardId).toBe(root!.id);
      expect(child!.description).toBe('Scan repository structure');
    });
  });

  test('subagent prefers command-origin root over newer same-session primary follow-up card', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const hooks = createEventHooks(store, mockInput);

      const commandRoot = await store.createCard({
        title: 'Command root',
        description: 'Start work root card',
        sessionId: 'session-command-root-preferred',
        command: 'start-work',
        sourceContext: '/start-work plan-xyz',
      });
      await store.updateCard(commandRoot.id, { status: 'in_progress' });

      await Bun.sleep(5);

      const primaryFollowUp = await store.createCard({
        title: 'Primary follow-up',
        description: 'Later build card in same session',
        sessionId: 'session-command-root-preferred',
        agentType: 'build',
      });
      await store.updateCard(primaryFollowUp.id, { status: 'in_progress' });

      const message = createUserMessage({
        id: 'msg-command-root-preferred-sub',
        sessionID: 'session-command-root-preferred',
      });
      await hooks['chat.message']!(
        {
          sessionID: 'session-command-root-preferred',
          agent: 'explore',
          messageID: 'msg-command-root-preferred-sub',
        },
        { message, parts: [createTextPart('Inspect repository layout')] },
      );

      const cards = await store.getCards();
      const child = cards.find(card => card.messageId === 'msg-command-root-preferred-sub');
      expect(child).toBeDefined();
      expect(child!.parentCardId).toBe(commandRoot.id);
      expect(child!.parentCardId).not.toBe(primaryFollowUp.id);
      expect(child!.title).toBe('Explore#1');
    });
  });

  test('suppresses command-generated primary prompt for init-deep', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const hooks = createEventHooks(store, mockInput);

      await hooks['command.execute.before']!(
        {
          command: '/init-deep',
          sessionID: 'session-init-deep-generated',
          arguments: '',
        },
        { parts: [] },
      );

      const rootMessage = createUserMessage({
        id: 'msg-init-generated-root',
        sessionID: 'session-init-deep-generated',
      });
      await hooks['chat.message']!(
        {
          sessionID: 'session-init-deep-generated',
          agent: 'Hephaestus (Deep Agent)',
          messageID: 'msg-init-generated-root',
        },
        { message: rootMessage, parts: [createTextPart('Initialize deep workspace')] },
      );

      const generatedMessage = createUserMessage({
        id: 'msg-init-generated-followup',
        sessionID: 'session-init-deep-generated',
      });
      await hooks['chat.message']!(
        {
          sessionID: 'session-init-deep-generated',
          agent: 'Hephaestus (Deep Agent)',
          messageID: 'msg-init-generated-followup',
        },
        { message: generatedMessage, parts: [createTextPart('## Anti-Patterns\n- Internal guidance')] },
      );

      const cards = await store.getCards();
      expect(cards).toHaveLength(1);
      expect(cards[0].description).toBe('Initialize deep workspace');
      expect(cards[0].command).toBe('init-deep');
    });
  });

  test('suppresses command-generated primary prompts for ralph loop wrappers', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const hooks = createEventHooks(store, mockInput);

      await hooks['command.execute.before']!(
        {
          command: '/ralph-loop',
          sessionID: 'session-ralph-generated',
          arguments: '--max-iteration=2',
        },
        { parts: [] },
      );

      const rootMessage = createUserMessage({
        id: 'msg-ralph-generated-root',
        sessionID: 'session-ralph-generated',
      });
      await hooks['chat.message']!(
        {
          sessionID: 'session-ralph-generated',
          agent: 'Hephaestus (Deep Agent)',
          messageID: 'msg-ralph-generated-root',
        },
        { message: rootMessage, parts: [createTextPart('just say hi to me for test')] },
      );

      const commandInstruction = createUserMessage({
        id: 'msg-ralph-generated-instruction',
        sessionID: 'session-ralph-generated',
      });
      await hooks['chat.message']!(
        {
          sessionID: 'session-ralph-generated',
          agent: 'Hephaestus (Deep Agent)',
          messageID: 'msg-ralph-generated-instruction',
        },
        { message: commandInstruction, parts: [createTextPart('<command-instruction>\nYou are starting a Ralph Loop</command-instruction>\n\n<user-task>\njust say hi to me for test --max-iteration=2\n</user-task>')] },
      );

      const loopDirective = createUserMessage({
        id: 'msg-ralph-generated-loop',
        sessionID: 'session-ralph-generated',
      });
      await hooks['chat.message']!(
        {
          sessionID: 'session-ralph-generated',
          agent: 'Hephaestus (Deep Agent)',
          messageID: 'msg-ralph-generated-loop',
        },
        { message: loopDirective, parts: [createTextPart('[SYSTEM DIRECTIVE: OH-MY-OPENCODE - RALPH LOOP 2/100]\nContinue working on the task')] },
      );

      const cards = await store.getCards();
      expect(cards).toHaveLength(1);
      expect(cards[0].description).toBe('just say hi to me for test');
      expect(cards[0].command).toBe('ralph-loop');
    });
  });

  test('suppresses command-generated primary prompt for refactor wrapper', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const hooks = createEventHooks(store, mockInput);

      await hooks['command.execute.before']!(
        {
          command: '/refactor',
          sessionID: 'session-refactor-generated',
          arguments: 'refactor',
        },
        { parts: [] },
      );

      const rootMessage = createUserMessage({
        id: 'msg-refactor-generated-root',
        sessionID: 'session-refactor-generated',
      });
      await hooks['chat.message']!(
        {
          sessionID: 'session-refactor-generated',
          agent: 'Hephaestus (Deep Agent)',
          messageID: 'msg-refactor-generated-root',
        },
        { message: rootMessage, parts: [createTextPart('refactor')] },
      );

      const wrapperMessage = createUserMessage({
        id: 'msg-refactor-generated-wrapper',
        sessionID: 'session-refactor-generated',
      });
      await hooks['chat.message']!(
        {
          sessionID: 'session-refactor-generated',
          agent: 'Hephaestus (Deep Agent)',
          messageID: 'msg-refactor-generated-wrapper',
        },
        { message: wrapperMessage, parts: [createTextPart('**Remember: Refactoring without tests is reckless. Refactoring without understanding is destructive.**\n\n<user-request>\nrefactor\n</user-request>\n\n</command-instruction>')] },
      );

      const cards = await store.getCards();
      expect(cards).toHaveLength(1);
      expect(cards[0].description).toBe('refactor');
      expect(cards[0].command).toBe('refactor');
    });
  });

  test('suppresses plan-not-found wrappers for start-work and handoff', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const hooks = createEventHooks(store, mockInput);

      for (const command of ['/start-work', '/handoff'] as const) {
        const sessionID = `session-${command.slice(1)}-generated`;
        await hooks['command.execute.before']!(
          {
            command,
            sessionID,
            arguments: 'missing-plan',
          },
          { parts: [] },
        );

        const rootMessage = createUserMessage({
          id: `${sessionID}-root`,
          sessionID,
        });
        await hooks['chat.message']!(
          {
            sessionID,
            agent: 'Hephaestus (Deep Agent)',
            messageID: `${sessionID}-root`,
          },
          { message: rootMessage, parts: [createTextPart('run command for missing plan')] },
        );

        const wrapperMessage = createUserMessage({
          id: `${sessionID}-wrapper`,
          sessionID,
        });
        await hooks['chat.message']!(
          {
            sessionID,
            agent: command === '/start-work' ? 'Atlas (Plan Executor)' : 'Hephaestus (Deep Agent)',
            messageID: `${sessionID}-wrapper`,
          },
          { message: wrapperMessage, parts: [createTextPart('## Plan Not Found\n\nCould not find a plan matching "missing-plan". No incomplete plans available. Create a new plan with: /plan "your task"')] },
        );
      }

      const cards = await store.getCards();
      expect(cards).toHaveLength(2);
      const commands = cards.map(card => card.command).sort();
      expect(commands).toEqual(['handoff', 'start-work']);
      expect(cards.every(card => card.title === 'run command for missing plan')).toBe(true);
    });
  });

  test('suppresses command-instruction wrappers for start-work', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const hooks = createEventHooks(store, mockInput);

      await hooks['command.execute.before']!(
        {
          command: '/start-work',
          sessionID: 'session-start-work-generated',
          arguments: 'task-card-redesign',
        },
        { parts: [] },
      );

      const rootMessage = createUserMessage({
        id: 'msg-start-work-generated-root',
        sessionID: 'session-start-work-generated',
      });
      await hooks['chat.message']!(
        {
          sessionID: 'session-start-work-generated',
          agent: 'Hephaestus (Deep Agent)',
          messageID: 'msg-start-work-generated-root',
        },
        { message: rootMessage, parts: [createTextPart('continue from saved plan')] },
      );

      const wrapperMessage = createUserMessage({
        id: 'msg-start-work-generated-wrapper',
        sessionID: 'session-start-work-generated',
      });
      await hooks['chat.message']!(
        {
          sessionID: 'session-start-work-generated',
          agent: 'Hephaestus (Deep Agent)',
          messageID: 'msg-start-work-generated-wrapper',
        },
        { message: wrapperMessage, parts: [createTextPart('<command-instruction>\nYou are starting a Sisyphus work session.\n## ARGUMENTS\n- `/start-work [plan-name] [--worktree <path>]`\n## WHAT TO DO\n1. **Find available plans**\n</command-instruction>')] },
      );

      const cards = await store.getCards();
      expect(cards).toHaveLength(1);
      expect(cards[0].description).toBe('continue from saved plan');
      expect(cards[0].command).toBe('start-work');
    });
  });

  test('suppresses active-work-session wrappers for handoff', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const hooks = createEventHooks(store, mockInput);

      await hooks['command.execute.before']!(
        {
          command: '/handoff',
          sessionID: 'session-handoff-active-work',
          arguments: '',
        },
        { parts: [] },
      );

      const rootMessage = createUserMessage({
        id: 'msg-handoff-active-work-root',
        sessionID: 'session-handoff-active-work',
      });
      await hooks['chat.message']!(
        {
          sessionID: 'session-handoff-active-work',
          agent: 'Hephaestus (Deep Agent)',
          messageID: 'msg-handoff-active-work-root',
        },
        { message: rootMessage, parts: [createTextPart('handoff current work')] },
      );

      const wrapperMessage = createUserMessage({
        id: 'msg-handoff-active-work-wrapper',
        sessionID: 'session-handoff-active-work',
      });
      await hooks['chat.message']!(
        {
          sessionID: 'session-handoff-active-work',
          agent: 'Hephaestus (Deep Agent)',
          messageID: 'msg-handoff-active-work-wrapper',
        },
        { message: wrapperMessage, parts: [createTextPart('## Active Work Session Found\n\n**Status**: RESUMING existing work\n**Plan**: task-card-redesign\n\nThe current session (ses_test) has been added to session_ids.\nRead the plan file and continue from the first unchecked task.')] },
      );

      const cards = await store.getCards();
      expect(cards).toHaveLength(1);
      expect(cards[0].description).toBe('handoff current work');
      expect(cards[0].command).toBe('handoff');
    });
  });

  test('keeps suppressing primary command-only follow-up messages well beyond one minute', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const hooks = createEventHooks(store, mockInput);

      await hooks['command.execute.before']!(
        {
          command: '/init-deep',
          sessionID: 'session-command-long-window',
          arguments: 'repo-plan',
        },
        { parts: [] },
      );

      const msg1 = createUserMessage({
        id: 'msg-command-long-window-1',
        sessionID: 'session-command-long-window',
      });
      await hooks['chat.message']!(
        {
          sessionID: 'session-command-long-window',
          agent: 'build',
          model: { providerID: 'github-copilot', modelID: 'gpt-5.4' },
          messageID: 'msg-command-long-window-1',
        },
        { message: msg1, parts: [createTextPart('Initialize deep workspace')] },
      );

      const consumedAt = commandTrackerTesting.commandWindowMap.get('session-command-long-window');
      expect(consumedAt).toBeDefined();
      commandTrackerTesting.commandWindowMap.set('session-command-long-window', consumedAt! - 70 * 1000);

      const msg2 = createUserMessage({
        id: 'msg-command-long-window-2',
        sessionID: 'session-command-long-window',
      });
      await hooks['chat.message']!(
        {
          sessionID: 'session-command-long-window',
          agent: 'build',
          model: { providerID: 'github-copilot', modelID: 'gpt-5.4' },
          messageID: 'msg-command-long-window-2',
        },
        { message: msg2, parts: [createTextPart('## Generate AGENTS files')] },
      );

      const cards = await store.getCards();
      expect(cards).toHaveLength(1);
      expect(cards[0].sessionId).toBe('session-command-long-window');
      expect(cards[0].command).toBe('init-deep');
      expect(cards[0].sourceContext).toBe('/init-deep repo-plan');
    });
  });

  test('different session messages are not affected by another session command window', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const hooks = createEventHooks(store, mockInput);

      await hooks['command.execute.before']!(
        {
          command: '/init-deep',
          sessionID: 'session-command-parent',
          arguments: '',
        },
        { parts: [] },
      );

      const commandMessage = createUserMessage({
        id: 'msg-command-parent-1',
        sessionID: 'session-command-parent',
      });
      await hooks['chat.message']!(
        {
          sessionID: 'session-command-parent',
          agent: 'build',
          model: { providerID: 'github-copilot', modelID: 'gpt-5.4' },
          messageID: 'msg-command-parent-1',
        },
        { message: commandMessage, parts: [createTextPart('Initialize deep workspace')] },
      );

      const otherMessage = createUserMessage({
        id: 'msg-command-other-1',
        sessionID: 'session-command-other',
      });
      await hooks['chat.message']!(
        {
          sessionID: 'session-command-other',
          agent: 'build',
          model: { providerID: 'github-copilot', modelID: 'gpt-5.4' },
          messageID: 'msg-command-other-1',
        },
        { message: otherMessage, parts: [createTextPart('Independent user request')] },
      );

      const cards = await store.getCards();
      expect(cards).toHaveLength(2);
      const commandCard = cards.find(card => card.sessionId === 'session-command-parent');
      const otherCard = cards.find(card => card.sessionId === 'session-command-other');
      expect(commandCard!.command).toBe('init-deep');
      expect(otherCard!.command).toBeUndefined();
      expect(otherCard!.description).toBe('Independent user request');
    });
  });

  test('does not open suppress window for command_with_prompt builtins', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const hooks = createEventHooks(store, mockInput);

      await hooks['command.execute.before']!(
        {
          command: '/start-work',
          sessionID: 'session-command-with-prompt',
          arguments: 'plan-xyz',
        },
        { parts: [] },
      );

      const msg1 = createUserMessage({
        id: 'msg-command-with-prompt-1',
        sessionID: 'session-command-with-prompt',
      });
      await hooks['chat.message']!(
        {
          sessionID: 'session-command-with-prompt',
          agent: 'build',
          model: { providerID: 'github-copilot', modelID: 'gpt-5.4' },
          messageID: 'msg-command-with-prompt-1',
        },
        { message: msg1, parts: [createTextPart('Start executing plan')] },
      );

      const msg2 = createUserMessage({
        id: 'msg-command-with-prompt-2',
        sessionID: 'session-command-with-prompt',
      });
      await hooks['chat.message']!(
        {
          sessionID: 'session-command-with-prompt',
          agent: 'build',
          model: { providerID: 'github-copilot', modelID: 'gpt-5.4' },
          messageID: 'msg-command-with-prompt-2',
        },
        { message: msg2, parts: [createTextPart('Follow-up user request')] },
      );

      const cards = await store.getCards();
      expect(cards).toHaveLength(2);
      expect(cards.filter(card => card.sessionId === 'session-command-with-prompt')).toHaveLength(2);
      expect(commandTrackerTesting.commandWindowMap.has('session-command-with-prompt')).toBe(false);
    });
  });
});

describe('parent-child card linking (regression)', () => {
  test('subagent prefers explicit registry mapping over project heuristic', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const childInput = createMockInput(undefined, '/tmp/child-project');
      const hooks = createEventHooks(store, childInput);

      const parent = await store.createCard({
        title: 'Parent task',
        description: 'Main work',
        sessionId: 'session-parent-registry',
        projectDir: '/tmp/test-project',
        agentType: 'Sisyphus (Ultraworker)',
      });
      await store.updateCard(parent.id, { status: 'in_progress' });

      const unrelated = await store.createCard({
        title: 'Unrelated project parent',
        description: 'Other work',
        sessionId: 'session-other-parent',
        projectDir: '/tmp/child-project',
        agentType: 'Sisyphus (Ultraworker)',
      });
      await store.updateCard(unrelated.id, { status: 'in_progress' });

      await hooks.event!({
        event: {
          type: 'session.created',
          properties: {
            info: {
              id: 'session-child-registry',
              projectID: 'project-1',
              directory: '/tmp/child-project',
              parentID: 'session-parent-registry',
              title: 'Child session',
              version: '1.0.0',
              time: {
                created: Date.now(),
                updated: Date.now(),
              },
            },
          },
        },
      });

      const message = createUserMessage({
        id: 'msg-registry-1',
        sessionID: 'session-child-registry',
      });
      await hooks['chat.message']!(
        {
          sessionID: 'session-child-registry',
          agent: 'explore',
          messageID: 'msg-registry-1',
        },
        { message, parts: [createTextPart('Registry-linked explore')] },
      );

      const cards = await store.getCards();
      const child = cards.find(c => c.sessionId === 'session-child-registry');
      expect(child).toBeDefined();
      expect(child!.parentCardId).toBe(parent.id);
      expect(child!.parentCardId).not.toBe(unrelated.id);
      expect(child!.title).toBe('Explore#1');
    });
  });

  test('stale registry mapping is cleared and falls back to heuristic parent selection', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const hooks = createEventHooks(store, mockInput);

      const staleParent = await store.createCard({
        title: 'Stale parent',
        description: 'Old work',
        sessionId: 'session-stale-parent',
        projectDir: '/tmp/test-project',
        agentType: 'Sisyphus (Ultraworker)',
      });
      await store.updateCard(staleParent.id, { status: 'in_progress' });

      const fallbackParent = await store.createCard({
        title: 'Fallback parent',
        description: 'Current work',
        sessionId: 'session-fallback-parent',
        projectDir: '/tmp/test-project',
        agentType: 'Sisyphus (Ultraworker)',
      });
      await store.updateCard(fallbackParent.id, { status: 'in_progress' });

      registerSubagentParent('session-stale-registry-child', {
        parentCardId: staleParent.id,
        rootCardId: staleParent.id,
        parentSessionId: 'session-stale-parent',
      });

      await store.deleteCard(staleParent.id);

      const message = createUserMessage({
        id: 'msg-stale-registry-1',
        sessionID: 'session-stale-registry-child',
      });
      await hooks['chat.message']!(
        {
          sessionID: 'session-stale-registry-child',
          agent: 'explore',
          messageID: 'msg-stale-registry-1',
        },
        { message, parts: [createTextPart('Stale registry fallback')] },
      );

      const cards = await store.getCards();
      const child = cards.find(c => c.sessionId === 'session-stale-registry-child');
      expect(child).toBeDefined();
      expect(child!.parentCardId).toBe(fallbackParent.id);
      expect(getSubagentParent('session-stale-registry-child')).toBeUndefined();
    });
  });

  test('subagent gets parentCardId when in_progress parent exists in same session', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const hooks = createEventHooks(store, mockInput);

      const parent = await store.createCard({
        title: 'Parent task',
        description: 'Main work',
        sessionId: 'session-parent',
        agentType: 'Sisyphus (Ultraworker)',
      });
      await store.updateCard(parent.id, { status: 'in_progress' });

      const message = createUserMessage({
        id: 'msg-sub-1',
        sessionID: 'session-parent',
      });
      await hooks['chat.message']!(
        {
          sessionID: 'session-parent',
          agent: 'explore',
          messageID: 'msg-sub-1',
        },
        { message, parts: [createTextPart('Searching for patterns')] },
      );

      const cards = await store.getCards();
      const child = cards.find(c => c.id !== parent.id);
      expect(child).toBeDefined();
      expect(child!.parentCardId).toBe(parent.id);
      expect(child!.agentType).toBe('explore');
    });
  });

  test('subagent falls back to same-session active parent before same-project parent', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const hooks = createEventHooks(store, mockInput);

      const sameSessionParent = await store.createCard({
        title: 'Same-session active parent',
        description: 'Recently completed but still active context',
        sessionId: 'session-same-session-active',
        projectDir: '/tmp/test-project',
        agentType: 'Sisyphus (Ultraworker)',
      });
      await store.updateCard(sameSessionParent.id, { status: 'complete' });

      const sameProjectParent = await store.createCard({
        title: 'Same-project in-progress parent',
        description: 'Other session parent',
        sessionId: 'session-same-project-parent',
        projectDir: '/tmp/test-project',
        agentType: 'Sisyphus (Ultraworker)',
      });
      await store.updateCard(sameProjectParent.id, { status: 'in_progress' });

      const message = createUserMessage({
        id: 'msg-same-session-active',
        sessionID: 'session-same-session-active',
      });
      await hooks['chat.message']!(
        {
          sessionID: 'session-same-session-active',
          agent: 'explore',
          messageID: 'msg-same-session-active',
        },
        { message, parts: [createTextPart('Investigate same-session fallback')] },
      );

      const cards = await store.getCards();
      const child = cards.find(card => card.description === 'Investigate same-session fallback');
      expect(child).toBeDefined();
      expect(child!.parentCardId).toBe(sameSessionParent.id);
      expect(child!.parentCardId).not.toBe(sameProjectParent.id);
      expect(child!.title).toBe('Explore#1');
    });
  });

  test('subagent title follows AgentName#N format when parent found', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const hooks = createEventHooks(store, mockInput);

      const parent = await store.createCard({
        title: 'Parent task',
        description: 'Main work',
        sessionId: 'session-title',
        agentType: 'Sisyphus (Ultraworker)',
      });
      await store.updateCard(parent.id, { status: 'in_progress' });

      const message = createUserMessage({
        id: 'msg-oracle-1',
        sessionID: 'session-title',
      });
      await hooks['chat.message']!(
        {
          sessionID: 'session-title',
          agent: 'oracle',
          messageID: 'msg-oracle-1',
        },
        { message, parts: [createTextPart('Looking up docs')] },
      );

      const cards = await store.getCards();
      const child = cards.find(c => c.id !== parent.id);
      expect(child).toBeDefined();
      expect(child!.title).toBe('Oracle#1');
    });
  });

  test('second subagent of same type gets incremented number', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const hooks = createEventHooks(store, mockInput);

      const parent = await store.createCard({
        title: 'Parent task',
        description: 'Main work',
        sessionId: 'session-inc',
        agentType: 'Sisyphus (Ultraworker)',
      });
      await store.updateCard(parent.id, { status: 'in_progress' });

      const msg1 = createUserMessage({
        id: 'msg-explore-1',
        sessionID: 'session-inc',
      });
      await hooks['chat.message']!(
        {
          sessionID: 'session-inc',
          agent: 'explore',
          messageID: 'msg-explore-1',
        },
        { message: msg1, parts: [createTextPart('First explore')] },
      );

      const msg2 = createUserMessage({
        id: 'msg-explore-2',
        sessionID: 'session-inc',
      });
      await hooks['chat.message']!(
        {
          sessionID: 'session-inc',
          agent: 'explore',
          messageID: 'msg-explore-2',
        },
        { message: msg2, parts: [createTextPart('Second explore')] },
      );

      const cards = await store.getCards();
      const children = cards.filter(c => c.parentCardId === parent.id).sort(
        (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
      );
      expect(children).toHaveLength(2);
      expect(children[0].title).toBe('Explore#1');
      expect(children[1].title).toBe('Explore#2');
      expect(children[0].parentCardId).toBe(parent.id);
      expect(children[1].parentCardId).toBe(parent.id);
    });
  });

  test('subagent with no candidate parent gets no parentCardId, uses user text title', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const hooks = createEventHooks(store, mockInput);

      const message = createUserMessage({
        id: 'msg-orphan-1',
        sessionID: 'session-orphan',
      });
      await hooks['chat.message']!(
        {
          sessionID: 'session-orphan',
          agent: 'explore',
          messageID: 'msg-orphan-1',
        },
        { message, parts: [createTextPart('Searching without parent')] },
      );

      const cards = await store.getCards();
      expect(cards).toHaveLength(1);
      expect(cards[0].parentCardId).toBeUndefined();
      expect(cards[0].title).toBe('Searching without parent');
    });
  });

  test('unknown agent type creates top-level card (not subagent)', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const hooks = createEventHooks(store, mockInput);

      const parent = await store.createCard({
        title: 'Parent task',
        description: 'Main work',
        sessionId: 'session-unknown',
        messageId: 'msg-parent-unknown',
      });
      await store.updateCard(parent.id, { status: 'in_progress' });

      const message = createUserMessage({
        id: 'msg-build-1',
        sessionID: 'session-build-standalone',
      });
      await hooks['chat.message']!(
        {
          sessionID: 'session-build-standalone',
          agent: 'build',
          messageID: 'msg-build-1',
        },
        { message, parts: [createTextPart('Build agent task')] },
      );

      const cards = await store.getCards();
      const buildCard = cards.find(c => c.id !== parent.id);
      expect(buildCard).toBeDefined();
      expect(buildCard!.parentCardId).toBeUndefined();
      expect(buildCard!.agentType).toBe('build');
    });
  });

  test('agentType field is stored on all agent cards', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const hooks = createEventHooks(store, mockInput);

      const msg1 = createUserMessage({
        id: 'msg-lib-1',
        sessionID: 'session-agent-1',
      });
      await hooks['chat.message']!(
        {
          sessionID: 'session-agent-1',
          agent: 'librarian',
          messageID: 'msg-lib-1',
        },
        { message: msg1, parts: [createTextPart('Librarian task')] },
      );

      const msg2 = createUserMessage({
        id: 'msg-build-2',
        sessionID: 'session-agent-2',
      });
      await hooks['chat.message']!(
        {
          sessionID: 'session-agent-2',
          agent: 'build',
          messageID: 'msg-build-2',
        },
        { message: msg2, parts: [createTextPart('Build task')] },
      );

      const cards = await store.getCards();
      const libCard = cards.find(c => c.sessionId === 'session-agent-1');
      const buildCard = cards.find(c => c.sessionId === 'session-agent-2');
      expect(libCard!.agentType).toBe('librarian');
      expect(buildCard!.agentType).toBe('build');
    });
  });

  test('parent candidate waterfall: prefers same-session in_progress over same-project', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const hooks = createEventHooks(store, mockInput);

      const cardA = await store.createCard({
        title: 'Card A same session',
        description: 'Work A',
        sessionId: 'session-1',
        projectDir: '/tmp/test-project',
        agentType: 'Sisyphus (Ultraworker)',
      });
      await store.updateCard(cardA.id, { status: 'in_progress' });

      const cardB = await store.createCard({
        title: 'Card B different session',
        description: 'Work B',
        sessionId: 'session-2',
        projectDir: '/tmp/test-project',
      });
      await store.updateCard(cardB.id, { status: 'in_progress' });

      const message = createUserMessage({
        id: 'msg-waterfall-1',
        sessionID: 'session-1',
      });
      await hooks['chat.message']!(
        {
          sessionID: 'session-1',
          agent: 'explore',
          messageID: 'msg-waterfall-1',
        },
        { message, parts: [createTextPart('Explore in session 1')] },
      );

      const cards = await store.getCards();
      const child = cards.find(c => c.parentCardId !== undefined);
      expect(child).toBeDefined();
      expect(child!.parentCardId).toBe(cardA.id);
    });
  });

  test('dispatched card dedup is handled by dispatch-tracker for initial prompt without messageId', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const hooks = createEventHooks(store, mockInput);

      // Simulate dispatchCard: creates card with sessionId but NO agentType,
      // and registers in dispatch-tracker (the primary dedup mechanism).
      const dispatched = await store.createCard({
        title: 'Dispatched task',
        description: 'Work to be done',
        sessionId: 'session-dispatched',
      });
      await store.updateCard(dispatched.id, { status: 'in_progress' });

      // Register in dispatch tracker (as dispatchCard() does in production)
      const { trackDispatch, clearDispatch } = await import('../plugin/hooks/dispatch-tracker');
      trackDispatch('session-dispatched', dispatched.id, 'Working on dispatched task');

      const message = createUserMessage({
        id: undefined as unknown as string,
        sessionID: 'session-dispatched',
      });
      await hooks['chat.message']!(
        {
          sessionID: 'session-dispatched',
          agent: 'sisyphus-junior',
          messageID: undefined as unknown as string,
        },
        { message, parts: [createTextPart('Working on dispatched task')] },
      );

      const cards = await store.getCards();
      // Dispatch-tracker prevents any card creation in dispatched session
      expect(cards).toHaveLength(1);
      expect(cards[0].id).toBe(dispatched.id);

      // Cleanup dispatch tracker entry
      clearDispatch('session-dispatched');
    });
  });

  test('subagent creates child under dispatched card only after primary agent sets agentType', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const hooks = createEventHooks(store, mockInput);

      // Simulate a hook-created card (has agentType — created by chat.message hook)
      const parent = await store.createCard({
        title: 'Hook-created task',
        description: 'Main work',
        sessionId: 'session-hook',
        agentType: 'Sisyphus (Ultraworker)',
      });
      await store.updateCard(parent.id, { status: 'in_progress' });

      // Subagent fires in the same session — should create a child card
      const message = createUserMessage({
        id: 'msg-sub-hook-1',
        sessionID: 'session-hook',
      });
      await hooks['chat.message']!(
        {
          sessionID: 'session-hook',
          agent: 'explore',
          messageID: 'msg-sub-hook-1',
        },
        { message, parts: [createTextPart('Exploring codebase')] },
      );

      const cards = await store.getCards();
      expect(cards).toHaveLength(2);
      const child = cards.find(c => c.id !== parent.id);
      expect(child).toBeDefined();
      expect(child!.parentCardId).toBe(parent.id);
      expect(child!.agentType).toBe('explore');
    });
  });
  test('dispatch-tracker prevents duplicate card creation for dispatch lifecycle messages without messageId', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const hooks = createEventHooks(store, mockInput);

      // Simulate dispatchCard: create card, update sessionId, register in tracker
      const dispatched = await store.createCard({
        title: 'Dispatched task',
        description: 'Work to be done',
        sessionId: 'session-dispatch-tracker',
      });
      await store.updateCard(dispatched.id, { status: 'in_progress' });
      trackDispatch('session-dispatch-tracker', dispatched.id, 'Work to be done');

      const message1 = createUserMessage({
        id: undefined as unknown as string,
        sessionID: 'session-dispatch-tracker',
      });
      await hooks['chat.message']!(
        {
          sessionID: 'session-dispatch-tracker',
          agent: undefined,
          messageID: undefined as unknown as string,
        },
        { message: message1, parts: [createTextPart('Work to be done')] },
      );

      const message2 = createUserMessage({
        id: undefined as unknown as string,
        sessionID: 'session-dispatch-tracker',
      });
      await hooks['chat.message']!(
        {
          sessionID: 'session-dispatch-tracker',
          agent: 'Sisyphus (Ultraworker)',
          messageID: undefined as unknown as string,
        },
        { message: message2, parts: [createTextPart('Starting work on dispatched task')] },
      );

      const cards = await store.getCards();
      // Only the original dispatched card should exist
      expect(cards).toHaveLength(1);
      expect(cards[0].id).toBe(dispatched.id);

      // Cleanup tracker
      clearDispatch('session-dispatch-tracker');
    });
  });

  test('follow-up subagent message with messageId can create child card in dispatched session', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const hooks = createEventHooks(store, mockInput);

      const dispatched = await store.createCard({
        title: 'Dispatched sub task',
        description: 'Sub work',
        sessionId: 'session-dispatch-sub',
      });
      await store.updateCard(dispatched.id, { status: 'in_progress' });
      trackDispatch('session-dispatch-sub', dispatched.id, 'Sub work');

      // Subagent fires — should still be blocked by dispatch tracker
      const message = createUserMessage({
        id: 'msg-dt-sub',
        sessionID: 'session-dispatch-sub',
      });
      await hooks['chat.message']!(
        {
          sessionID: 'session-dispatch-sub',
          agent: 'explore',
          messageID: 'msg-dt-sub',
        },
        { message, parts: [createTextPart('Exploring for dispatched task')] },
      );

      const cards = await store.getCards();
      expect(cards).toHaveLength(2);
      const child = cards.find(c => c.id !== dispatched.id);
      expect(child).toBeDefined();
      expect(child!.parentCardId).toBe(dispatched.id);
      expect(child!.agentType).toBe('explore');

      clearDispatch('session-dispatch-sub');
    });
  });

  test('follow-up primary user message with messageId creates a new card even while dispatch-tracker is active', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const hooks = createEventHooks(store, mockInput);

      const dispatched = await store.createCard({
        title: 'Dispatched primary task',
        description: 'Initial dispatched work',
        sessionId: 'session-dispatch-followup',
      });
      await store.updateCard(dispatched.id, { status: 'in_progress' });
      trackDispatch('session-dispatch-followup', dispatched.id, 'Initial dispatched work');

      const message = createUserMessage({
        id: 'msg-followup-primary-1',
        sessionID: 'session-dispatch-followup',
      });
      await hooks['chat.message']!(
        {
          sessionID: 'session-dispatch-followup',
          agent: 'Hephaestus (Deep Agent)',
          messageID: 'msg-followup-primary-1',
        },
        { message, parts: [createTextPart('A follow-up user request in the same dispatched session')] },
      );

      const cards = await store.getCards();
      expect(cards).toHaveLength(2);
      const followUp = cards.find(c => c.id !== dispatched.id);
      expect(followUp).toBeDefined();
      expect(followUp!.sessionId).toBe('session-dispatch-followup');
      expect(followUp!.messageId).toBe('msg-followup-primary-1');
      expect(followUp!.description).toBe('A follow-up user request in the same dispatched session');
      expect(followUp!.agentType).toBe('hephaestus');

      clearDispatch('session-dispatch-followup');
    });
  });

  test('dispatch-tracker skips replayed dispatched prompt even when messageId exists', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const hooks = createEventHooks(store, mockInput);

      const dispatched = await store.createCard({
        title: 'Feedback task',
        description: 'Please refine the previous result',
        sessionId: 'session-feedback-reuse',
        feedbackForCardId: 'parent-card',
      });
      await store.updateCard(dispatched.id, { status: 'in_progress' });
      trackDispatch('session-feedback-reuse', dispatched.id, dispatched.description);

      const message = createUserMessage({
        id: 'msg-feedback-replay-1',
        sessionID: 'session-feedback-reuse',
      });

      await hooks['chat.message']!(
        {
          sessionID: 'session-feedback-reuse',
          agent: 'Hephaestus (Deep Agent)',
          messageID: 'msg-feedback-replay-1',
        },
        { message, parts: [createTextPart('Please refine the previous result')] },
      );

      const cards = await store.getCards();
      expect(cards).toHaveLength(1);
      expect(cards[0].id).toBe(dispatched.id);

      clearDispatch('session-feedback-reuse');
    });
  });

  test('dispatch-tracker skips replayed feedback prompt with metadata wrapper when messageId exists', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const hooks = createEventHooks(store, mockInput);

      const wrappedFeedbackDescription = [
        '[Feedback for: Original Card]',
        '[Original Card ID: abc12345]',
        '[Original Result: hi]',
        '---',
        'just say hi',
      ].join('\n');

      const dispatched = await store.createCard({
        title: 'Feedback task',
        description: wrappedFeedbackDescription,
        sessionId: 'session-feedback-wrapped',
        feedbackForCardId: 'parent-card',
      });
      await store.updateCard(dispatched.id, { status: 'in_progress' });
      trackDispatch('session-feedback-wrapped', dispatched.id, dispatched.description);

      const message = createUserMessage({
        id: 'msg-feedback-replay-wrapped-1',
        sessionID: 'session-feedback-wrapped',
      });

      await hooks['chat.message']!(
        {
          sessionID: 'session-feedback-wrapped',
          agent: 'Hephaestus (Deep Agent)',
          messageID: 'msg-feedback-replay-wrapped-1',
        },
        { message, parts: [createTextPart('just say hi')] },
      );

      const cards = await store.getCards();
      expect(cards).toHaveLength(1);
      expect(cards[0].id).toBe(dispatched.id);

      clearDispatch('session-feedback-wrapped');
    });
  });

  test('store-based dispatch dedup allows subsequent user messages with messageId to create new cards', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const hooks = createEventHooks(store, mockInput);

      // Simulate a dispatch-created card (no messageId, no agentType).
      // This simulates the scenario AFTER process restart where the in-memory
      // dispatch-tracker is gone, so dedup relies on the store-based fallback.
      const dispatched = await store.createCard({
        title: 'Dispatched via Telegram',
        description: 'Work to do',
        sessionId: 'session-store-dedup',
      });
      await store.updateCard(dispatched.id, { status: 'in_progress' });

      // NOTE: We do NOT call trackDispatch() here — simulating process restart
      // where the in-memory tracker is empty.

      // A subsequent user message WITH a messageId should create a new card,
      // not be blocked by the store-based dispatch dedup.
      const message1 = createUserMessage({
        id: 'msg-store-dedup-1',
        sessionID: 'session-store-dedup',
      });
      await hooks['chat.message']!(
        {
          sessionID: 'session-store-dedup',
          agent: 'Sisyphus (Ultraworker)',
          messageID: 'msg-store-dedup-1',
        },
        { message: message1, parts: [createTextPart('New user instruction in same session')] },
      );

      const cards = await store.getCards();
      expect(cards).toHaveLength(2);
      const newCard = cards.find(c => c.id !== dispatched.id);
      expect(newCard).toBeDefined();
      expect(newCard!.messageId).toBe('msg-store-dedup-1');
      expect(newCard!.sessionId).toBe('session-store-dedup');
    });
  });

  test('store-based dispatch dedup still blocks messages WITHOUT messageId (dispatch prompt)', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const hooks = createEventHooks(store, mockInput);

      // Dispatch-created card (no messageId)
      const dispatched = await store.createCard({
        title: 'Another dispatched task',
        description: 'Work',
        sessionId: 'session-store-dedup-block',
      });
      await store.updateCard(dispatched.id, { status: 'in_progress' });

      // Message WITHOUT messageId (simulates the initial dispatch prompt)
      // Should still be blocked by store-based dedup.
      const message = createUserMessage({
        id: undefined as unknown as string,
        sessionID: 'session-store-dedup-block',
      });
      await hooks['chat.message']!(
        {
          sessionID: 'session-store-dedup-block',
          agent: 'Sisyphus (Ultraworker)',
          messageID: undefined as unknown as string,
        },
        { message: message, parts: [createTextPart('Dispatch prompt replay')] },
      );

      const cards = await store.getCards();
      expect(cards).toHaveLength(1);
      expect(cards[0].id).toBe(dispatched.id);
    });
  });

  test('cross-session subagent links to recent same-project parent (dispatched card scenario)', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const hooks = createEventHooks(store, mockInput);

      // Simulate a dispatched parent card in session-A (has agentType, in_progress)
      const parent = await store.createCard({
        title: 'Dispatched parent task',
        description: 'Main work from TODO dispatch',
        sessionId: 'session-dispatch-A',
        projectDir: '/tmp/test-project',
        agentType: 'Sisyphus (Ultraworker)',
      });
      await store.updateCard(parent.id, { status: 'in_progress' });

      // Subagent fires in a DIFFERENT session (this is what opencode does for explore/oracle/etc.)
      const message = createUserMessage({
        id: 'msg-cross-1',
        sessionID: 'session-subagent-B',
      });
      await hooks['chat.message']!(
        {
          sessionID: 'session-subagent-B',
          agent: 'explore',
          messageID: 'msg-cross-1',
        },
        { message, parts: [createTextPart('Cross-session explore')] },
      );

      const cards = await store.getCards();
      const child = cards.find(c => c.id !== parent.id);
      expect(child).toBeDefined();
      expect(child!.parentCardId).toBe(parent.id);
      expect(child!.agentType).toBe('explore');
      expect(child!.title).toBe('Explore#1');
    });
  });

  test('cross-session subagent DOES link to stale in_progress same-project card (regardless of age)', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const hooks = createEventHooks(store, mockInput);

      // Create a parent card with a createdAt timestamp older than 5 minutes
      const staleParent = await store.createCard({
        title: 'Stale parent task',
        description: 'Old work from 10 minutes ago',
        sessionId: 'session-stale-A',
        projectDir: '/tmp/test-project',
        agentType: 'Sisyphus (Ultraworker)',
      });
      await store.updateCard(staleParent.id, { status: 'in_progress' });

      // Manually backdate the card's createdAt to 10 minutes ago via direct board manipulation
      const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
      const board = await store.load();
      const staleCard = board.cards.find(c => c.id === staleParent.id);
      staleCard!.createdAt = tenMinAgo;
      await store.save(board);

      // Subagent fires in a different session — SHOULD find the in_progress parent
      // because in_progress cards are actively being worked on regardless of creation age
      const message = createUserMessage({
        id: 'msg-stale-1',
        sessionID: 'session-subagent-stale-B',
      });
      await hooks['chat.message']!(
        {
          sessionID: 'session-subagent-stale-B',
          agent: 'explore',
          messageID: 'msg-stale-1',
        },
        { message, parts: [createTextPart('Explore for stale parent')] },
      );

      const cards = await store.getCards();
      const child = cards.find(c => c.id !== staleParent.id);
      expect(child).toBeDefined();
      // SHOULD be linked — in_progress parents are always valid regardless of creation age
      expect(child!.parentCardId).toBe(staleParent.id);
      expect(child!.title).toBe('Explore#1');
    });
  });

  test('cross-session subagent does NOT link to stale non-in_progress same-project card (older than 5 min)', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const hooks = createEventHooks(store, mockInput);

      // Create a card that is NOT in_progress (e.g., complete) and older than 5 minutes
      const staleCard = await store.createCard({
        title: 'Stale complete task',
        description: 'Old work that finished 10 minutes ago',
        sessionId: 'session-stale-complete-A',
        projectDir: '/tmp/test-project',
        agentType: 'Sisyphus (Ultraworker)',
      });
      await store.updateCard(staleCard.id, { status: 'complete' });

      // Manually backdate the card's createdAt to 10 minutes ago
      const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
      const board = await store.load();
      const card = board.cards.find(c => c.id === staleCard.id);
      card!.createdAt = tenMinAgo;
      await store.save(board);

      // Subagent fires in a different session — should NOT find the stale non-in_progress parent
      const message = createUserMessage({
        id: 'msg-stale-complete-1',
        sessionID: 'session-subagent-stale-complete-B',
      });
      await hooks['chat.message']!(
        {
          sessionID: 'session-subagent-stale-complete-B',
          agent: 'explore',
          messageID: 'msg-stale-complete-1',
        },
        { message, parts: [createTextPart('Explore for stale complete parent')] },
      );

      const cards = await store.getCards();
      const child = cards.find(c => c.id !== staleCard.id);
      expect(child).toBeDefined();
      // Should NOT be linked — non-in_progress stale parent is too old
      expect(child!.parentCardId).toBeUndefined();
      // Should have user text title (no parent = no AgentName#N format)
      expect(child!.title).toBe('Explore for stale complete parent');
    });
  });

  test('multiple cross-session subagents link to same recent parent with incremented numbers', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const hooks = createEventHooks(store, mockInput);

      // Parent card in session-A
      const parent = await store.createCard({
        title: 'Multi-sub parent',
        description: 'Parent for multiple cross-session subagents',
        sessionId: 'session-multi-A',
        projectDir: '/tmp/test-project',
        agentType: 'Sisyphus (Ultraworker)',
      });
      await store.updateCard(parent.id, { status: 'in_progress' });

      // Explore subagent in session-B
      const msg1 = createUserMessage({
        id: 'msg-multi-explore-1',
        sessionID: 'session-multi-B',
      });
      await hooks['chat.message']!(
        {
          sessionID: 'session-multi-B',
          agent: 'explore',
          messageID: 'msg-multi-explore-1',
        },
        { message: msg1, parts: [createTextPart('First cross-session explore')] },
      );

      // Oracle subagent in session-C
      const msg2 = createUserMessage({
        id: 'msg-multi-oracle-1',
        sessionID: 'session-multi-C',
      });
      await hooks['chat.message']!(
        {
          sessionID: 'session-multi-C',
          agent: 'oracle',
          messageID: 'msg-multi-oracle-1',
        },
        { message: msg2, parts: [createTextPart('Cross-session oracle')] },
      );

      // Second explore in session-D
      const msg3 = createUserMessage({
        id: 'msg-multi-explore-2',
        sessionID: 'session-multi-D',
      });
      await hooks['chat.message']!(
        {
          sessionID: 'session-multi-D',
          agent: 'explore',
          messageID: 'msg-multi-explore-2',
        },
        { message: msg3, parts: [createTextPart('Second cross-session explore')] },
      );

      const cards = await store.getCards();
      expect(cards).toHaveLength(4); // parent + 3 children

      const children = cards.filter(c => c.parentCardId === parent.id).sort(
        (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
      );
      expect(children).toHaveLength(3);
      expect(children[0].title).toBe('Explore#1');
      expect(children[0].agentType).toBe('explore');
      expect(children[1].title).toBe('Oracle#1');
      expect(children[1].agentType).toBe('oracle');
      expect(children[2].title).toBe('Explore#2');
      expect(children[2].agentType).toBe('explore');
    });
  });

  test('same-session parent takes priority over same-project parent (waterfall order)', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const hooks = createEventHooks(store, mockInput);

      // Same-project parent in session-A
      const projectParent = await store.createCard({
        title: 'Project parent',
        description: 'Same project different session',
        sessionId: 'session-proj-parent',
        projectDir: '/tmp/test-project',
        agentType: 'Sisyphus (Ultraworker)',
      });
      await store.updateCard(projectParent.id, { status: 'in_progress' });

      // Same-session parent
      const sessionParent = await store.createCard({
        title: 'Session parent',
        description: 'Same session',
        sessionId: 'session-sub-priority',
        projectDir: '/tmp/test-project',
        agentType: 'Sisyphus (Ultraworker)',
      });
      await store.updateCard(sessionParent.id, { status: 'in_progress' });

      // Subagent in the same session as sessionParent
      const message = createUserMessage({
        id: 'msg-priority-1',
        sessionID: 'session-sub-priority',
      });
      await hooks['chat.message']!(
        {
          sessionID: 'session-sub-priority',
          agent: 'explore',
          messageID: 'msg-priority-1',
        },
        { message, parts: [createTextPart('Priority test')] },
      );

      const cards = await store.getCards();
      const child = cards.find(c => c.agentType === 'explore');
      expect(child).toBeDefined();
      // Should pick same-session parent, NOT same-project parent
      expect(child!.parentCardId).toBe(sessionParent.id);
    });
  });

  test('cross-session subagent links to ORIGINAL parent, not a newer card in same project (regression)', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const hooks = createEventHooks(store, mockInput);

      // Step 1: Card A created (the original parent) in session-A
      const cardA = await store.createCard({
        title: 'Card A - Original parent',
        description: 'First task',
        sessionId: 'session-A',
        projectDir: '/tmp/test-project',
        agentType: 'Sisyphus (Ultraworker)',
      });
      await store.updateCard(cardA.id, { status: 'in_progress' });

      // Step 2: Subagent explore#1 fires in session-B — should link to Card A (only candidate)
      const msg1 = createUserMessage({
        id: 'msg-regression-1',
        sessionID: 'session-B',
      });
      await hooks['chat.message']!(
        {
          sessionID: 'session-B',
          agent: 'explore',
          messageID: 'msg-regression-1',
        },
        { message: msg1, parts: [createTextPart('First explore')] },
      );

      // Verify explore#1 linked to Card A
      let cards = await store.getCards();
      const explore1 = cards.find(c => c.agentType === 'explore' && c.title === 'Explore#1');
      expect(explore1).toBeDefined();
      expect(explore1!.parentCardId).toBe(cardA.id);

      // Step 3: Card B created (a NEW, SEPARATE task) in session-C — this is the newer card
      const cardB = await store.createCard({
        title: 'Card B - Newer separate task',
        description: 'Second unrelated task',
        sessionId: 'session-C',
        projectDir: '/tmp/test-project',
        agentType: 'Sisyphus (Ultraworker)',
      });
      await store.updateCard(cardB.id, { status: 'in_progress' });

      // Step 4: Subagent explore#2 fires in session-D (spawned by Card A's work)
      //   BUG: This would link to Card B (newer) instead of Card A (original parent)
      //   EXPECTED: Should link to Card A because Card A already has children (explore#1)
      const msg2 = createUserMessage({
        id: 'msg-regression-2',
        sessionID: 'session-D',
      });
      await hooks['chat.message']!(
        {
          sessionID: 'session-D',
          agent: 'explore',
          messageID: 'msg-regression-2',
        },
        { message: msg2, parts: [createTextPart('Second explore')] },
      );

      cards = await store.getCards();
      const explore2 = cards.find(
        c => c.agentType === 'explore' && c.sessionId === 'session-D',
      );
      expect(explore2).toBeDefined();

      // THIS IS THE KEY ASSERTION:
      // explore#2 should link to Card A (the original parent that already has children),
      // NOT Card B (the newer card that has no children)
      expect(explore2!.parentCardId).toBe(cardA.id);
      expect(explore2!.title).toBe('Explore#2');

      // Card B should have NO children
      const cardBChildren = cards.filter(c => c.parentCardId === cardB.id);
      expect(cardBChildren).toHaveLength(0);

      // Card A should have 2 children
      const cardAChildren = cards.filter(c => c.parentCardId === cardA.id);
      expect(cardAChildren).toHaveLength(2);
    });
  });

  describe('additional subagent types', () => {
    test('plan subagent gets parentCardId and Plan#1 title', async () => {
      await withTempDir(async (dir) => {
        const store = new KanbanStore(dir);
        const hooks = createEventHooks(store, mockInput);

        const parent = await store.createCard({
          title: 'Parent task',
          description: 'Main task',
          sessionId: 'session-plan-test',
          projectDir: '/tmp/test-project',
          agentType: 'Sisyphus (Ultraworker)',
        });
        await store.updateCard(parent.id, { status: 'in_progress' });

        const msg = createUserMessage({
          id: 'msg-plan-1',
          sessionID: 'session-plan-sub',
        });
        await hooks['chat.message']!(
          {
            sessionID: 'session-plan-sub',
            agent: 'plan',
            messageID: 'msg-plan-1',
          },
          { message: msg, parts: [createTextPart('Planning phase')] },
        );

        const cards = await store.getCards();
        const planCard = cards.find(c => c.agentType === 'plan');
        expect(planCard).toBeDefined();
        expect(planCard!.parentCardId).toBe(parent.id);
        expect(planCard!.title).toBe('Plan#1');
      });
    });

    test('metis subagent gets parentCardId and Metis#1 title', async () => {
      await withTempDir(async (dir) => {
        const store = new KanbanStore(dir);
        const hooks = createEventHooks(store, mockInput);

        const parent = await store.createCard({
          title: 'Parent task',
          description: 'Main task',
          sessionId: 'session-metis-test',
          projectDir: '/tmp/test-project',
          agentType: 'Sisyphus (Ultraworker)',
        });
        await store.updateCard(parent.id, { status: 'in_progress' });

        const msg = createUserMessage({
          id: 'msg-metis-1',
          sessionID: 'session-metis-sub',
        });
        await hooks['chat.message']!(
          {
            sessionID: 'session-metis-sub',
            agent: 'metis',
            messageID: 'msg-metis-1',
          },
          { message: msg, parts: [createTextPart('Pre-planning analysis')] },
        );

        const cards = await store.getCards();
        const metisCard = cards.find(c => c.agentType === 'metis');
        expect(metisCard).toBeDefined();
        expect(metisCard!.parentCardId).toBe(parent.id);
        expect(metisCard!.title).toBe('Metis#1');
      });
    });

    test('momus subagent gets parentCardId and Momus#1 title', async () => {
      await withTempDir(async (dir) => {
        const store = new KanbanStore(dir);
        const hooks = createEventHooks(store, mockInput);

        const parent = await store.createCard({
          title: 'Parent task',
          description: 'Main task',
          sessionId: 'session-momus-test',
          projectDir: '/tmp/test-project',
          agentType: 'Sisyphus (Ultraworker)',
        });
        await store.updateCard(parent.id, { status: 'in_progress' });

        const msg = createUserMessage({
          id: 'msg-momus-1',
          sessionID: 'session-momus-sub',
        });
        await hooks['chat.message']!(
          {
            sessionID: 'session-momus-sub',
            agent: 'momus',
            messageID: 'msg-momus-1',
          },
          { message: msg, parts: [createTextPart('Plan review')] },
        );

        const cards = await store.getCards();
        const momusCard = cards.find(c => c.agentType === 'momus');
        expect(momusCard).toBeDefined();
        expect(momusCard!.parentCardId).toBe(parent.id);
        expect(momusCard!.title).toBe('Momus#1');
      });
    });

    test('librarian subagent gets parentCardId and Librarian#1 title', async () => {
      await withTempDir(async (dir) => {
        const store = new KanbanStore(dir);
        const hooks = createEventHooks(store, mockInput);

        const parent = await store.createCard({
          title: 'Parent task',
          description: 'Main task',
          sessionId: 'session-librarian-test',
          projectDir: '/tmp/test-project',
          agentType: 'Sisyphus (Ultraworker)',
        });
        await store.updateCard(parent.id, { status: 'in_progress' });

        const msg = createUserMessage({
          id: 'msg-librarian-1',
          sessionID: 'session-librarian-sub',
        });
        await hooks['chat.message']!(
          {
            sessionID: 'session-librarian-sub',
            agent: 'librarian',
            messageID: 'msg-librarian-1',
          },
          { message: msg, parts: [createTextPart('Reference search')] },
        );

        const cards = await store.getCards();
        const libCard = cards.find(c => c.agentType === 'librarian');
        expect(libCard).toBeDefined();
        expect(libCard!.parentCardId).toBe(parent.id);
        expect(libCard!.title).toBe('Librarian#1');
      });
    });
  });

  describe('hyphenated agent name formatting', () => {
    test('multimodal-looker gets proper title Multimodal-Looker#1', async () => {
      await withTempDir(async (dir) => {
        const store = new KanbanStore(dir);
        const hooks = createEventHooks(store, mockInput);

        const parent = await store.createCard({
          title: 'Parent task',
          description: 'Main task',
          sessionId: 'session-ml-test',
          projectDir: '/tmp/test-project',
          agentType: 'Sisyphus (Ultraworker)',
        });
        await store.updateCard(parent.id, { status: 'in_progress' });

        const msg = createUserMessage({
          id: 'msg-ml-1',
          sessionID: 'session-ml-sub',
        });
        await hooks['chat.message']!(
          {
            sessionID: 'session-ml-sub',
            agent: 'multimodal-looker',
            messageID: 'msg-ml-1',
          },
          { message: msg, parts: [createTextPart('Analyzing image')] },
        );

        const cards = await store.getCards();
        const mlCard = cards.find(c => c.agentType === 'multimodal-looker');
        expect(mlCard).toBeDefined();
        expect(mlCard!.parentCardId).toBe(parent.id);
        expect(mlCard!.title).toBe('Multimodal-Looker#1');
      });
    });

    test('sisyphus-junior gets proper title Sisyphus-Junior#1', async () => {
      await withTempDir(async (dir) => {
        const store = new KanbanStore(dir);
        const hooks = createEventHooks(store, mockInput);

        const parent = await store.createCard({
          title: 'Parent task',
          description: 'Main task',
          sessionId: 'session-sj-test',
          projectDir: '/tmp/test-project',
          agentType: 'Sisyphus (Ultraworker)',
        });
        await store.updateCard(parent.id, { status: 'in_progress' });

        const msg = createUserMessage({
          id: 'msg-sj-1',
          sessionID: 'session-sj-sub',
        });
        await hooks['chat.message']!(
          {
            sessionID: 'session-sj-sub',
            agent: 'sisyphus-junior',
            messageID: 'msg-sj-1',
          },
          { message: msg, parts: [createTextPart('Delegated task')] },
        );

        const cards = await store.getCards();
        const sjCard = cards.find(c => c.agentType === 'sisyphus-junior');
        expect(sjCard).toBeDefined();
        expect(sjCard!.parentCardId).toBe(parent.id);
        expect(sjCard!.title).toBe('Sisyphus-Junior#1');
      });
    });
  });

  describe('case-insensitive agentType sibling counting', () => {
    test('sibling count is case-insensitive for agentType', async () => {
      await withTempDir(async (dir) => {
        const store = new KanbanStore(dir);
        const hooks = createEventHooks(store, mockInput);

        const parent = await store.createCard({
          title: 'Parent task',
          description: 'Main task',
          sessionId: 'session-case-test',
          projectDir: '/tmp/test-project',
          agentType: 'Sisyphus (Ultraworker)',
        });
        await store.updateCard(parent.id, { status: 'in_progress' });

        // First explore — lowercase 'explore'
        const msg1 = createUserMessage({
          id: 'msg-case-1',
          sessionID: 'session-case-sub1',
        });
        await hooks['chat.message']!(
          {
            sessionID: 'session-case-sub1',
            agent: 'explore',
            messageID: 'msg-case-1',
          },
          { message: msg1, parts: [createTextPart('First explore')] },
        );

        // Manually insert a card with uppercase agentType to simulate old data
        await store.createCard({
          title: 'Explore#2',
          description: 'Manual old card',
          sessionId: 'session-case-sub2',
          projectDir: '/tmp/test-project',
          parentCardId: parent.id,
          agentType: 'Explore', // uppercase — old/inconsistent data
        });

        // Third explore — should count both existing siblings regardless of case
        const msg3 = createUserMessage({
          id: 'msg-case-3',
          sessionID: 'session-case-sub3',
        });
        await hooks['chat.message']!(
          {
            sessionID: 'session-case-sub3',
            agent: 'explore',
            messageID: 'msg-case-3',
          },
          { message: msg3, parts: [createTextPart('Third explore')] },
        );

        const cards = await store.getCards();
        const thirdExplore = cards.find(
          c => c.sessionId === 'session-case-sub3' && c.agentType === 'explore',
        );
        expect(thirdExplore).toBeDefined();
        // Should be #3 because it counts both 'explore' (lowercase) and 'Explore' (uppercase)
        expect(thirdExplore!.title).toBe('Explore#3');
      });
    });

    test('agentType is stored normalized to lowercase', async () => {
      await withTempDir(async (dir) => {
        const store = new KanbanStore(dir);
        const hooks = createEventHooks(store, mockInput);

        const parent = await store.createCard({
          title: 'Parent task',
          description: 'Main task',
          sessionId: 'session-norm-test',
          projectDir: '/tmp/test-project',
          agentType: 'Sisyphus (Ultraworker)',
        });
        await store.updateCard(parent.id, { status: 'in_progress' });

        // Send agent with mixed case — e.g., 'Plan' instead of 'plan'
        const msg = createUserMessage({
          id: 'msg-norm-1',
          sessionID: 'session-norm-sub',
        });
        await hooks['chat.message']!(
          {
            sessionID: 'session-norm-sub',
            agent: 'Plan',
            messageID: 'msg-norm-1',
          },
          { message: msg, parts: [createTextPart('Planning')] },
        );

        const cards = await store.getCards();
        const planCard = cards.find(c => c.sessionId === 'session-norm-sub');
        expect(planCard).toBeDefined();
        // agentType should be stored as lowercase regardless of input casing
        expect(planCard!.agentType).toBe('plan');
        expect(planCard!.title).toBe('Plan#1');
      });
    });
  });

  describe('non-subagent types (CI-4 coverage)', () => {
    test('general agent does NOT get parentCardId', async () => {
      await withTempDir(async (dir) => {
        const store = new KanbanStore(dir);
        const hooks = createEventHooks(store, mockInput);

        // Create an in_progress parent card
        const parent = await store.createCard({
          title: 'Parent task',
          description: 'Main task',
          sessionId: 'session-general-parent',
          projectDir: '/tmp/test-project',
          agentType: 'Sisyphus (Ultraworker)',
        });
        await store.updateCard(parent.id, { status: 'in_progress' });

        // Fire 'general' agent — should NOT be treated as subagent
        const msg = createUserMessage({
          id: 'msg-general-1',
          sessionID: 'session-general-sub',
        });
        await hooks['chat.message']!(
          {
            sessionID: 'session-general-sub',
            agent: 'general',
            messageID: 'msg-general-1',
          },
          { message: msg, parts: [createTextPart('General task')] },
        );

        const cards = await store.getCards();
        const generalCard = cards.find(c => c.sessionId === 'session-general-sub');
        expect(generalCard).toBeDefined();
        // general is NOT a subagent — should have no parentCardId
        expect(generalCard!.parentCardId).toBeUndefined();
        // Title should be user text, not Agent#N format
        expect(generalCard!.title).toBe('General task');
      });
    });

    test('build agent does NOT get parentCardId', async () => {
      await withTempDir(async (dir) => {
        const store = new KanbanStore(dir);
        const hooks = createEventHooks(store, mockInput);

        const parent = await store.createCard({
          title: 'Parent task',
          description: 'Main task',
          sessionId: 'session-build-parent',
          projectDir: '/tmp/test-project',
          agentType: 'Sisyphus (Ultraworker)',
        });
        await store.updateCard(parent.id, { status: 'in_progress' });

        const msg = createUserMessage({
          id: 'msg-build-1',
          sessionID: 'session-build-sub',
        });
        await hooks['chat.message']!(
          {
            sessionID: 'session-build-sub',
            agent: 'build',
            messageID: 'msg-build-1',
          },
          { message: msg, parts: [createTextPart('Build task')] },
        );

        const cards = await store.getCards();
        const buildCard = cards.find(c => c.sessionId === 'session-build-sub');
        expect(buildCard).toBeDefined();
        expect(buildCard!.parentCardId).toBeUndefined();
        expect(buildCard!.title).toBe('Build task');
      });
    });

    test('undefined agent does NOT get parentCardId', async () => {
      await withTempDir(async (dir) => {
        const store = new KanbanStore(dir);
        const hooks = createEventHooks(store, mockInput);

        const parent = await store.createCard({
          title: 'Parent task',
          description: 'Main task',
          sessionId: 'session-undef-parent',
          projectDir: '/tmp/test-project',
          agentType: 'Sisyphus (Ultraworker)',
        });
        await store.updateCard(parent.id, { status: 'in_progress' });

        const msg = createUserMessage({
          id: 'msg-undef-1',
          sessionID: 'session-undef-sub',
        });
        await hooks['chat.message']!(
          {
            sessionID: 'session-undef-sub',
            agent: undefined,
            messageID: 'msg-undef-1',
          },
          { message: msg, parts: [createTextPart('No agent task')] },
        );

        const cards = await store.getCards();
        const noAgentCard = cards.find(c => c.sessionId === 'session-undef-sub');
        expect(noAgentCard).toBeDefined();
        expect(noAgentCard!.parentCardId).toBeUndefined();
        expect(noAgentCard!.title).toBe('No agent task');
      });
    });
  });
});

describe('Telegram completion notification', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    resetObservedActiveSessions();
  });

  test('sends Telegram message when card has telegramChatId and token exists', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const settingsStore = new SettingsStore(dir);

      // Set up Telegram bot token in settings
      await settingsStore.createEntry({
        key: 'TELEGRAM_BOT_TOKEN',
        value: 'test-bot-token-123',
        description: 'Telegram Bot Token',
      });

      const inputWithMessages = createMockInput({
        'session-tg': [
          {
            info: { role: 'assistant' },
            parts: [createTextPart('Task completed successfully.')],
          },
        ],
      });

      const hooks = createEventHooks(store, inputWithMessages, undefined, settingsStore);

      // Create a card that originated from Telegram
      const card = await store.createCard({
        title: 'Telegram task',
        description: 'Do something from Telegram',
        sessionId: 'session-tg',
        telegramChatId: 12345,
      });
      await store.updateCard(card.id, { status: 'in_progress' });

      // Mock fetch to capture Telegram API call
      const fetchCalls: { url: string; body: string }[] = [];
      globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
        if (url.includes('api.telegram.org')) {
          fetchCalls.push({ url, body: init?.body as string });
          return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return originalFetch(input, init);
      }) as unknown as typeof fetch;

      const event: Event = {
        type: 'session.idle',
        properties: { sessionID: 'session-tg' },
      };

      markSessionActive('session-tg');
      await hooks.event!({ event });

      // Card should be complete
      const updated = await store.getCard(card.id);
      expect(updated!.status).toBe('complete');
      expect(updated!.telegramReplyStatus).toBe('sent');
      expect(updated!.telegramReplyMessageId).toBe(1);
      expect(updated!.telegramReplyError).toBeUndefined();

      // Telegram message should have been sent
      expect(fetchCalls.length).toBe(1);
      expect(fetchCalls[0].url).toContain('test-bot-token-123');
      expect(fetchCalls[0].url).toContain('/sendMessage');
      const body = JSON.parse(fetchCalls[0].body);
      expect(body.chat_id).toBe(12345);
      expect(body.text).toContain('Telegram task');
      expect(body.text).toContain('Task completed successfully.');
    });
  });

  test('does NOT send Telegram message when card has no telegramChatId', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const settingsStore = new SettingsStore(dir);

      await settingsStore.createEntry({
        key: 'TELEGRAM_BOT_TOKEN',
        value: 'test-bot-token-123',
        description: 'Telegram Bot Token',
      });

      const hooks = createEventHooks(store, mockInput, undefined, settingsStore);

      // Create a normal card (no telegramChatId)
      const card = await store.createCard({
        title: 'Normal task',
        description: 'Regular work',
        sessionId: 'session-normal',
      });
      await store.updateCard(card.id, { status: 'in_progress' });

      const fetchCalls: string[] = [];
      globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
        if (url.includes('api.telegram.org')) {
          fetchCalls.push(url);
        }
        return originalFetch(input, init);
      }) as unknown as typeof fetch;

      const event: Event = {
        type: 'session.idle',
        properties: { sessionID: 'session-normal' },
      };

      markSessionActive('session-normal');
      await hooks.event!({ event });

      const updated = await store.getCard(card.id);
      expect(updated!.status).toBe('complete');
      // No Telegram call should have been made
      expect(fetchCalls.length).toBe(0);
    });
  });

  test('does NOT send Telegram message when no bot token in settings', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const settingsStore = new SettingsStore(dir);
      // No TELEGRAM_BOT_TOKEN entry created

      const hooks = createEventHooks(store, mockInput, undefined, settingsStore);

      const card = await store.createCard({
        title: 'Telegram task no token',
        description: 'Work from Telegram',
        sessionId: 'session-tg-notoken',
        telegramChatId: 99999,
      });
      await store.updateCard(card.id, { status: 'in_progress' });

      const fetchCalls: string[] = [];
      globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
        if (url.includes('api.telegram.org')) {
          fetchCalls.push(url);
        }
        return originalFetch(input, init);
      }) as unknown as typeof fetch;

      const event: Event = {
        type: 'session.idle',
        properties: { sessionID: 'session-tg-notoken' },
      };

      markSessionActive('session-tg-notoken');
      await hooks.event!({ event });

      const updated = await store.getCard(card.id);
      expect(updated!.status).toBe('complete');
      expect(updated!.telegramReplyStatus).toBe('failed');
      expect(updated!.telegramReplyError).toBe('Missing TELEGRAM_BOT_TOKEN');
      expect(fetchCalls.length).toBe(0);
    });
  });

  test('Telegram send failure does not prevent card completion', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const settingsStore = new SettingsStore(dir);

      await settingsStore.createEntry({
        key: 'TELEGRAM_BOT_TOKEN',
        value: 'test-bot-token-fail',
        description: 'Telegram Bot Token',
      });

      const hooks = createEventHooks(store, mockInput, undefined, settingsStore);

      const card = await store.createCard({
        title: 'Telegram task fail',
        description: 'Work from Telegram',
        sessionId: 'session-tg-fail',
        telegramChatId: 77777,
      });
      await store.updateCard(card.id, { status: 'in_progress' });

      // Mock fetch to throw an error for Telegram API
      globalThis.fetch = mock(async (input: string | URL | Request) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
        if (url.includes('api.telegram.org')) {
          throw new Error('Network error');
        }
        return originalFetch(input);
      }) as unknown as typeof fetch;

      const event: Event = {
        type: 'session.idle',
        properties: { sessionID: 'session-tg-fail' },
      };

      markSessionActive('session-tg-fail');
      // Should NOT throw — Telegram error is caught
      await hooks.event!({ event });

      const updated = await store.getCard(card.id);
      expect(updated!.status).toBe('complete');
      expect(updated!.telegramReplyStatus).toBe('failed');
      expect(updated!.telegramReplyError).toBe('Network error');
    });
  });

  test('marks older Telegram card as skipped when a newer same-session card completes', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const settingsStore = new SettingsStore(dir);

      await settingsStore.createEntry({
        key: 'TELEGRAM_BOT_TOKEN',
        value: 'test-bot-token-skip',
        description: 'Telegram Bot Token',
      });

      const hooks = createEventHooks(store, createMockInput({
        'session-tg-skip': [
          {
            info: { role: 'assistant' },
            parts: [createTextPart('Newest Telegram card completed.')],
          },
        ],
      }), undefined, settingsStore);

      const older = await store.createCard({
        title: 'Older Telegram card',
        description: 'Older Telegram card',
        sessionId: 'session-tg-skip',
        originChannel: 'telegram',
        telegramChatId: 31337,
        telegramMessageId: '100',
        telegramReplyStatus: 'pending',
      });
      await store.updateCard(older.id, { status: 'in_progress' });

      const newer = await store.createCard({
        title: 'Newer Telegram card',
        description: 'Newer Telegram card',
        sessionId: 'session-tg-skip',
        originChannel: 'telegram',
        telegramChatId: 31337,
        telegramMessageId: '101',
        telegramReplyStatus: 'pending',
      });
      await store.updateCard(newer.id, { status: 'in_progress' });

      globalThis.fetch = mock(async () => new Response(JSON.stringify({ ok: true, result: { message_id: 55 } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })) as unknown as typeof fetch;

      markSessionActive('session-tg-skip');
      await hooks.event!({
        event: {
          type: 'session.idle',
          properties: { sessionID: 'session-tg-skip' },
        },
      });

      const updatedOlder = await store.getCard(older.id);
      const updatedNewer = await store.getCard(newer.id);
      expect(updatedOlder!.telegramReplyStatus).toBe('skipped');
      expect(updatedNewer!.telegramReplyStatus).toBe('sent');
      expect(updatedNewer!.telegramReplyMessageId).toBe(55);
    });
  });

  test('invokes Telegram completion callback before sending completion message', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const settingsStore = new SettingsStore(dir);

      await settingsStore.createEntry({
        key: 'TELEGRAM_BOT_TOKEN',
        value: 'test-bot-token-clear',
        description: 'Telegram Bot Token',
      });

      const onSessionComplete = mock(async () => {});
      const inputWithMessages = createMockInput({
        'session-tg-clear': [
          {
            info: { role: 'assistant' },
            parts: [createTextPart('Final answer from Telegram flow.')],
          },
        ],
      });

      const hooks = createEventHooks(store, inputWithMessages, undefined, settingsStore, onSessionComplete);

      const card = await store.createCard({
        title: 'Telegram clear task',
        description: 'Clear session mapping',
        sessionId: 'session-tg-clear',
        telegramChatId: 45678,
      });
      await store.updateCard(card.id, { status: 'in_progress' });

      const callOrder: string[] = [];
      globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
        if (url.includes('api.telegram.org')) {
          callOrder.push('telegram');
          return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return originalFetch(input, init);
      }) as unknown as typeof fetch;
      onSessionComplete.mockImplementation(async () => {
        callOrder.push('clear');
      });

      markSessionActive('session-tg-clear');
      await hooks.event!({
        event: {
          type: 'session.idle',
          properties: { sessionID: 'session-tg-clear' },
        },
      });

      expect(onSessionComplete).toHaveBeenCalledWith('session-tg-clear');
      expect(callOrder).toEqual(['clear', 'telegram']);
    });
  });

  test('writes runtime debug logs for session.idle completion flow', async () => {
    await withTempDir(async (dir) => {
      const debugDir = mkdtempSync(join(tmpdir(), 'kanban-event-log-'));
      const logPath = join(debugDir, 'runtime-debug.log');
      process.env.KANBAN_RUNTIME_DEBUG_LOG_FILE = logPath;

      const store = new KanbanStore(dir);
      const settingsStore = new SettingsStore(dir);
      await settingsStore.createEntry({
        key: 'TELEGRAM_BOT_TOKEN',
        value: 'test-bot-token-log',
        description: 'Telegram Bot Token',
      });

      const hooks = createEventHooks(store, createMockInput({
        'session-tg-log': [
          {
            info: { role: 'assistant' },
            parts: [createTextPart('Logged completion result.')],
          },
        ],
      }), undefined, settingsStore);

      const card = await store.createCard({
        title: 'Telegram log task',
        description: 'Log this completion',
        sessionId: 'session-tg-log',
        originChannel: 'telegram',
        telegramChatId: 12121,
        telegramMessageId: '321',
      });
      await store.updateCard(card.id, { status: 'in_progress' });

      globalThis.fetch = mock(async () => new Response(JSON.stringify({ ok: true, result: { message_id: 77 } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })) as unknown as typeof fetch;

      markSessionActive('session-tg-log');
      await hooks.event!({
        event: {
          type: 'session.idle',
          properties: { sessionID: 'session-tg-log' },
        },
      });

      const lines = readFileSync(logPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
      expect(lines.some((line) => line.event === 'session.idle.received' && line.sessionID === 'session-tg-log')).toBe(true);
      expect(lines.some((line) => line.event === 'session.idle.primary_completed' && line.cardId === card.id)).toBe(true);
      expect(lines.some((line) => line.event === 'session.idle.telegram_send' && line.cardId === card.id)).toBe(true);
      expect(lines.some((line) => line.event === 'session.idle.telegram_send_result' && line.cardId === card.id && line.ok === true)).toBe(true);
    });
  });

});
