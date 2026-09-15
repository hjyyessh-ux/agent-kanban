import { describe, test, expect, afterAll, afterEach, beforeAll } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  loadSessionTranscript,
  locateSessionTranscript,
  resolveClaudeTranscriptPath,
  resolveCodexTranscriptPath,
} from '../plugin/wiki/wiki-transcript';

/**
 * The codex side redirects to a temp `CODEX_HOME` — the resolver reads that
 * variable the way Codex CLI itself does. Writing into the real store instead
 * meant every lookup globbed all 1,376 files of it, and that I/O was enough to
 * starve the suite's timing-sensitive tests (telegram completion, scheduled
 * dispatch) into intermittent failures.
 *
 * The claude side has no such seam: `resolveClaudeTranscriptPath` reads
 * `homedir()`, which Bun resolves once per process. Those fixtures therefore
 * land at the real path under one dedicated project directory — cheap, since
 * that lookup is a plain `join` + `existsSync` with nothing to scan — and are
 * removed after every test.
 */
let CODEX_ROOT = '';
let codexHomeDir = '';
const ORIGINAL_CODEX_HOME = process.env.CODEX_HOME;

/** The one project directory the claude fixtures munge into. */
const CLAUDE_FIXTURE_PROJECT_DIR = join(homedir(), '.agent-kanban-test', 'transcript-fixture');
const written: string[] = [];

beforeAll(() => {
  codexHomeDir = mkdtempSync(join(tmpdir(), 'ak-codex-home-'));
  process.env.CODEX_HOME = codexHomeDir;
  CODEX_ROOT = join(codexHomeDir, 'sessions');
});

afterAll(() => {
  if (ORIGINAL_CODEX_HOME === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = ORIGINAL_CODEX_HOME;
  rmSync(codexHomeDir, { recursive: true, force: true });
});

function writeCodexRollout(sessionId: string, lines: string[]): string {
  const path = join(CODEX_ROOT, '2026', '09', '15', `rollout-2026-09-15T08-39-47-${sessionId}.jsonl`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, lines.join('\n'));
  written.push(path);
  return path;
}

function writeClaudeTranscript(projectDir: string, sessionId: string, lines: string[]): string {
  const path = resolveClaudeTranscriptPath(projectDir, sessionId);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, lines.join('\n'));
  written.push(path);
  return path;
}

afterEach(() => {
  for (const path of written.splice(0)) rmSync(path, { force: true });
  // The munged project directory would otherwise be left behind, empty, in the
  // user's real `~/.claude/projects` listing.
  rmSync(dirname(resolveClaudeTranscriptPath(CLAUDE_FIXTURE_PROJECT_DIR, 'x')), {
    recursive: true,
    force: true,
  });
});

function rolloutMessage(role: string, text: string): string {
  return JSON.stringify({
    timestamp: '2026-09-15T00:00:00.000Z',
    type: 'response_item',
    payload: { type: 'message', role, content: [{ type: role === 'assistant' ? 'output_text' : 'input_text', text }] },
  });
}

describe('resolveCodexTranscriptPath', () => {
  test('finds a rollout by session id alone — no projectDir involved', () => {
    const sessionId = 'aktest01-1111-7000-0000-000000000001';
    const path = writeCodexRollout(sessionId, [rolloutMessage('user', 'hi')]);

    expect(resolveCodexTranscriptPath(sessionId)).toBe(path);
  });

  // Codex CLI's own override (`codex --help`). A user who relocates their Codex
  // home would otherwise get "transcript 없음" on every session.
  test('honours CODEX_HOME rather than assuming ~/.codex', () => {
    const sessionId = 'aktest01-1010-7000-0000-000000000010';
    const path = writeCodexRollout(sessionId, [rolloutMessage('user', 'hi')]);

    expect(path.startsWith(codexHomeDir)).toBe(true);
    expect(resolveCodexTranscriptPath(sessionId)).toBe(path);
  });

  test('an unknown session id is undefined, not a throw', () => {
    expect(resolveCodexTranscriptPath('aktest01-0000-7000-0000-00000000dead')).toBeUndefined();
  });

  // A glob metacharacter in the id would widen the match and could return some
  // other session's conversation. Session ids reaching here come from stored
  // Work links, so the shape is checked rather than trusted.
  test('refuses a session id that is not the id shape codex writes', () => {
    writeCodexRollout('aktest01-2222-7000-0000-000000000002', [rolloutMessage('user', 'hi')]);

    expect(resolveCodexTranscriptPath('*')).toBeUndefined();
    expect(resolveCodexTranscriptPath('../../etc/passwd')).toBeUndefined();
    expect(resolveCodexTranscriptPath('')).toBeUndefined();
  });
});

describe('locateSessionTranscript', () => {
  test('reports the codex rollout with its format', () => {
    const sessionId = 'aktest01-3333-7000-0000-000000000003';
    const path = writeCodexRollout(sessionId, [rolloutMessage('user', 'hi')]);

    expect(locateSessionTranscript(sessionId)).toEqual({ path, format: 'codex' });
  });

  // The runtime on the card is a dispatch intent; this is a question about a
  // file. A card tagged codex whose conversation sits in the Claude Code
  // directory has to resolve — and be parsed — as claude.
  test('a claude transcript wins when both exist, and carries the claude format', () => {
    const sessionId = 'aktest01-4444-7000-0000-000000000004';
    const projectDir = CLAUDE_FIXTURE_PROJECT_DIR;
    const claudePath = writeClaudeTranscript(projectDir, sessionId, [
      JSON.stringify({ message: { role: 'user', content: 'from claude' } }),
    ]);
    writeCodexRollout(sessionId, [rolloutMessage('user', 'from codex')]);

    expect(locateSessionTranscript(sessionId, projectDir)).toEqual({ path: claudePath, format: 'claude' });
  });

  test('no file anywhere is undefined', () => {
    expect(locateSessionTranscript('aktest01-5555-7000-0000-00000000beef')).toBeUndefined();
  });
});

describe('loadSessionTranscript', () => {
  test('flattens a codex rollout into [role] turns, dropping developer and non-message lines', () => {
    const sessionId = 'aktest01-6666-7000-0000-000000000006';
    writeCodexRollout(sessionId, [
      JSON.stringify({ type: 'session_meta', payload: { session_id: sessionId } }),
      rolloutMessage('developer', 'You are Codex, an agent based on GPT-6.'),
      rolloutMessage('user', 'PR 리뷰해줘'),
      rolloutMessage('assistant', '두 PR을 확인하겠습니다.'),
      // Tool traffic is not conversation.
      JSON.stringify({ type: 'response_item', payload: { type: 'function_call', name: 'shell' } }),
      'not json',
      '',
    ]);

    expect(loadSessionTranscript({ sessionId })).toBe('[user] PR 리뷰해줘\n\n[assistant] 두 PR을 확인하겠습니다.');
  });

  test('parses a claude transcript with the claude rules', () => {
    const sessionId = 'aktest01-7777-7000-0000-000000000007';
    const projectDir = CLAUDE_FIXTURE_PROJECT_DIR;
    writeClaudeTranscript(projectDir, sessionId, [
      JSON.stringify({ message: { role: 'user', content: '고쳐줘' } }),
      JSON.stringify({ message: { role: 'assistant', content: [{ type: 'text', text: '고쳤습니다' }] } }),
      JSON.stringify({ message: { role: 'system', content: 'ignored' } }),
    ]);

    expect(loadSessionTranscript({ sessionId, projectDir })).toBe('[user] 고쳐줘\n\n[assistant] 고쳤습니다');
  });

  // The whole point of dropping the `agentRuntime !== 'claude'` gate: a codex
  // session has to enrich the wiki/Work summary the same way a claude one does.
  test('a session with no projectDir still loads when codex wrote a rollout', () => {
    const sessionId = 'aktest01-8888-7000-0000-000000000008';
    writeCodexRollout(sessionId, [rolloutMessage('user', '이어서 진행')]);

    expect(loadSessionTranscript({ sessionId })).toBe('[user] 이어서 진행');
  });

  test('a rollout with no conversation turns is undefined, not an empty string', () => {
    const sessionId = 'aktest01-9999-7000-0000-000000000009';
    writeCodexRollout(sessionId, [
      JSON.stringify({ type: 'session_meta', payload: { session_id: sessionId } }),
      rolloutMessage('developer', 'system prompt only'),
    ]);

    expect(loadSessionTranscript({ sessionId })).toBeUndefined();
  });

  test('no session id is undefined', () => {
    expect(loadSessionTranscript({ sessionId: undefined })).toBeUndefined();
  });
});
