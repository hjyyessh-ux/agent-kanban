import { describe, expect, test } from 'bun:test';
import {
  MAX_REFERENCES,
  MENTION_TOKEN_RE,
  REFERENCE_BLOCK_CLOSE,
  REFERENCE_BLOCK_OPEN,
  TRANSCRIPT_READ_LIMIT_BYTES,
  appendReferenceBlock,
  parseMentionTokens,
  renderReferenceBlock,
  stripReferenceBlock,
  type ResolvedReference,
} from './mention-reference';

const MB = 1024 * 1024;

const SESSION_REF: ResolvedReference = {
  kind: 'session',
  id: 'kx9f2a1b',
  raw: '@session:kx9f2a1b',
  title: '텔레그램 폴러 중복 카드 수정',
  sessionId: 'kx9f2a1b-7c3e-4d21-9a08-11b4f6e0c552',
  cardId: 'k5mR0pBn',
  cardStatus: 'done',
  agentRuntime: 'claude',
  model: 'claude-opus-5',
  projectDir: '/Users/user/workspace/agent-kanban',
  startedAt: '2026-09-12T05:20:00.000Z', // KST 14:20
  completedAt: '2026-09-12T06:58:00.000Z', // KST 15:58
  resultExcerpt: '폴러 dedup 키를 messageId 기준으로 변경, 회귀 테스트 3개 추가',
  transcriptPath:
    '/Users/user/.claude/projects/-Users-user-workspace-agent-kanban/kx9f2a1b-7c3e-4d21-9a08-11b4f6e0c552.jsonl',
  transcriptSize: 1258291, // 1.2MB
  transcriptFormat: 'claude',
};

const WORK_REF: ResolvedReference = {
  kind: 'work',
  id: 'wTg4hN2',
  raw: '@work:wTg4hN2',
  title: 'Telegram 연동 안정화',
  workStatus: 'active',
  sessionCount: 4,
  cardCount: 11,
  summaryLines: [
    '폴러가 같은 메시지로 카드를 두 번 만드는 문제를 messageId 기준 dedup으로 정리',
    '/work 명령과 답장 상태(TelegramReplyStatus) 추적을 추가',
  ],
  workSessions: [
    {
      sessionId: 'kx9f2a1b',
      agentRuntime: 'claude',
      transcriptPath: '/Users/user/.claude/projects/ak/kx9f2a1b.jsonl',
      transcriptSize: 1258291, // 1.2MB
      transcriptFormat: 'claude',
    },
    {
      sessionId: 'b806ce4f',
      agentRuntime: 'claude',
      transcriptPath: '/Users/user/.claude/projects/ak/b806ce4f.jsonl',
      transcriptSize: 29779558, // 28.4MB
      transcriptFormat: 'claude',
    },
    // 같은 Work 안의 codex 세션 — rollout 경로를 그대로 싣는다.
    {
      sessionId: 'q5Wm1er8',
      agentRuntime: 'codex',
      transcriptPath: '/Users/user/.codex/sessions/2026/09/12/rollout-2026-09-12T14-20-01-q5Wm1er8.jsonl',
      transcriptSize: 524288, // 512KB
      transcriptFormat: 'codex',
    },
    { sessionId: 'z0Op7dQ2', agentRuntime: 'opencode', transcriptMissing: 'runtime_unsupported' },
  ],
};

const DOC_REF: ResolvedReference = {
  kind: 'doc',
  id: 'troubleshooting/telegram-poller-dup.md',
  raw: '@doc:troubleshooting/telegram-poller-dup.md',
  title: 'Telegram 폴러 중복 카드 — 원인과 dedup 키 설계',
  docPath: 'troubleshooting/telegram-poller-dup.md',
  docAbsPath: '/Users/user/workspace/obsidian/obsidian/Wiki/troubleshooting/telegram-poller-dup.md',
};

function sessionRef(id: string, overrides: Partial<ResolvedReference> = {}): ResolvedReference {
  return { ...SESSION_REF, id, raw: `@session:${id}`, ...overrides };
}

describe('parseMentionTokens', () => {
  test('extracts tokens in order with positions and decoded ids', () => {
    const text = '이거 참고: @session:kx9f2a1b 랑 @work:wTg4hN2 도 같이 봐줘';
    const tokens = parseMentionTokens(text);

    expect(tokens.map((t) => [t.kind, t.id])).toEqual([
      ['session', 'kx9f2a1b'],
      ['work', 'wTg4hN2'],
    ]);
    expect(tokens[0].raw).toBe('@session:kx9f2a1b');
    expect(text.slice(tokens[0].start, tokens[0].end)).toBe('@session:kx9f2a1b');
    expect(text.slice(tokens[1].start, tokens[1].end)).toBe('@work:wTg4hN2');
  });

  test('percent-encoded doc paths are decoded into id but raw keeps the token text', () => {
    const [token] = parseMentionTokens('@doc:notes/2026%20plan.md 확인');
    expect(token.id).toBe('notes/2026 plan.md');
    expect(token.raw).toBe('@doc:notes/2026%20plan.md');
  });

  test('an email address is never mistaken for a token', () => {
    expect(parseMentionTokens('junyeong@naverz-corp.com 로 메일 보냈어')).toEqual([]);
    // 종류 접두사까지 갖춘 최악의 경우도 앞 문자 가드에서 걸러진다.
    expect(parseMentionTokens('me@doc:notes.md')).toEqual([]);
    expect(parseMentionTokens('user@session:kx9f2a1b')).toEqual([]);
  });

  test('accepts tokens preceded by start of text, whitespace, newline, ( or [', () => {
    expect(parseMentionTokens('@session:aaaa1111').length).toBe(1);
    expect(parseMentionTokens('앞 @session:aaaa1111').length).toBe(1);
    expect(parseMentionTokens('앞\n@session:aaaa1111').length).toBe(1);
    expect(parseMentionTokens('(@session:aaaa1111)').length).toBe(1);
    expect(parseMentionTokens('[@session:aaaa1111]').length).toBe(1);
  });

  test('keeps only the first occurrence of a duplicated token', () => {
    const tokens = parseMentionTokens('@session:kx9f2a1b 그리고 다시 @session:kx9f2a1b');
    expect(tokens.length).toBe(1);
    expect(tokens[0].start).toBe(0);
  });

  test('the same id under a different kind is a different reference', () => {
    const tokens = parseMentionTokens('@session:abc @work:abc');
    expect(tokens.map((t) => t.kind)).toEqual(['session', 'work']);
  });

  test('the exported regex is not left with a dangling lastIndex', () => {
    parseMentionTokens('@session:kx9f2a1b');
    expect(MENTION_TOKEN_RE.lastIndex).toBe(0);
  });
});

describe('renderReferenceBlock', () => {
  test('reproduces the §5 block format for session / work / doc', () => {
    expect(renderReferenceBlock([SESSION_REF, WORK_REF, DOC_REF])).toBe(
      [
        '<!-- agent-kanban:references v1 — 자동 생성. 수정하지 마세요 -->',
        '## Referenced context — 작업 시작 전 반드시 읽을 것',
        '',
        '사용자가 @ 멘션으로 **명시적으로 지정한 참조**입니다. 본문은 이 블록에',
        '포함돼 있지 않습니다. 아래 각 항목의 경로를 **직접 열어 읽은 뒤에**',
        '본 작업을 시작하세요. 읽지 않고 추측으로 답하지 마세요.',
        '',
        '경로는 절대경로이며 현재 작업 디렉토리 밖일 수 있습니다(의도된 동작).',
        '파일이 존재하지 않으면 그 사실을 사용자에게 보고하고, 같은 항목의',
        '메타데이터(제목·상태·result)만으로 진행하세요.',
        '',
        '**읽기 전략** — 각 transcript 줄 옆에 파일 크기가 적혀 있습니다.',
        '- **2MB 이하** → `Read`로 그대로 열어도 됩니다.',
        '- **2MB 초과** → `Read` 금지. 각 transcript 줄 아래의 형식 설명에 적힌',
        '  `jq` 예시로 먼저 좁히세요.',
        '',
        '### @session:kx9f2a1b — 텔레그램 폴러 중복 카드 수정',
        '- kind: session · status: done · runtime: claude · model: claude-opus-5',
        '- sessionId: `kx9f2a1b-7c3e-4d21-9a08-11b4f6e0c552`',
        '- projectDir: `/Users/user/workspace/agent-kanban`',
        '- transcript: `/Users/user/.claude/projects/-Users-user-workspace-agent-kanban/kx9f2a1b-7c3e-4d21-9a08-11b4f6e0c552.jsonl` (1.2MB — Read 가능)',
        '  JSONL(claude). 줄마다 `.message.role`(user|assistant) 과 `.message.content`.',
        '  `jq -r \'select(.message.role=="user") | .message.content\' <path> | head -100`',
        '- card: `k5mR0pBn` "텔레그램 폴러 중복 카드 수정" (2026-09-12 14:20 ~ 15:58)',
        '- result: 폴러 dedup 키를 messageId 기준으로 변경, 회귀 테스트 3개 추가',
        '',
        '### @work:wTg4hN2 — Telegram 연동 안정화',
        '- kind: work · status: active · 세션 4개 · 카드 11개',
        '- summary:',
        '  - 폴러가 같은 메시지로 카드를 두 번 만드는 문제를 messageId 기준 dedup으로 정리',
        '  - /work 명령과 답장 상태(TelegramReplyStatus) 추적을 추가',
        '- sessions:',
        '  - `kx9f2a1b` → `/Users/user/.claude/projects/ak/kx9f2a1b.jsonl` (claude · 1.2MB — Read 가능)',
        '  - `b806ce4f` → `/Users/user/.claude/projects/ak/b806ce4f.jsonl` (claude · 28.4MB — **Read 금지, jq 선행**)',
        '  - `q5Wm1er8` → `/Users/user/.codex/sessions/2026/09/12/rollout-2026-09-12T14-20-01-q5Wm1er8.jsonl` (codex · 512.0KB — Read 가능)',
        '  - `z0Op7dQ2` → transcript 파일 없음 — 아래 메타데이터만 사용',
        '',
        '### @doc:troubleshooting/telegram-poller-dup.md',
        '- kind: doc · title: "Telegram 폴러 중복 카드 — 원인과 dedup 키 설계"',
        '- path: `/Users/user/workspace/obsidian/obsidian/Wiki/troubleshooting/telegram-poller-dup.md`',
        '<!-- /agent-kanban:references -->',
      ].join('\n'),
    );
  });

  test('the header orders the agent to read, it does not suggest it', () => {
    const block = renderReferenceBlock([SESSION_REF]);
    expect(block).toContain('## Referenced context — 작업 시작 전 반드시 읽을 것');
    expect(block).toContain('본 작업을 시작하세요. 읽지 않고 추측으로 답하지 마세요.');
    expect(block).not.toContain('필요하면');
  });

  test('renders nothing when there are no references', () => {
    expect(renderReferenceBlock([])).toBe('');
  });

  test('keeps at most MAX_REFERENCES sections', () => {
    const refs = Array.from({ length: MAX_REFERENCES + 3 }, (_, i) => sessionRef(`sess${i}`));
    const block = renderReferenceBlock(refs);

    expect(block.match(/^### /gm)?.length).toBe(MAX_REFERENCES);
    expect(block).toContain(`### @session:sess${MAX_REFERENCES - 1} —`);
    expect(block).not.toContain(`### @session:sess${MAX_REFERENCES} —`);
  });

  test('a work lists at most 8 sessions and folds the rest', () => {
    const block = renderReferenceBlock([
      {
        ...WORK_REF,
        workSessions: Array.from({ length: 11 }, (_, i) => ({
          sessionId: `s${i}`,
          transcriptPath: `/tmp/s${i}.jsonl`,
          transcriptSize: 1024,
        })),
      },
    ]);

    expect(block).toContain('  - `s7` → `/tmp/s7.jsonl` (claude · 1.0KB — Read 가능)');
    expect(block).not.toContain('`s8` →');
    expect(block).toContain('  - … 외 3개');
  });

  test('a work without summary lines omits the summary line entirely', () => {
    const block = renderReferenceBlock([{ ...WORK_REF, summaryLines: undefined }]);
    expect(block).not.toContain('- summary:');
    expect(block).toContain('- sessions:');
  });

  describe('transcript size and the 2MB read threshold', () => {
    test('1.9MB is marked readable', () => {
      const block = renderReferenceBlock([sessionRef('s19', { transcriptSize: Math.round(1.9 * MB) })]);
      expect(block).toContain('(1.9MB — Read 가능)');
      expect(block).not.toContain('Read 금지');
    });

    test('2.1MB is marked read-forbidden with jq first', () => {
      const block = renderReferenceBlock([sessionRef('s21', { transcriptSize: Math.round(2.1 * MB) })]);
      expect(block).toContain('(2.1MB — **Read 금지, jq 선행**)');
    });

    test('exactly 2MB is still readable', () => {
      const block = renderReferenceBlock([sessionRef('s20', { transcriptSize: TRANSCRIPT_READ_LIMIT_BYTES })]);
      expect(block).toContain('(2.0MB — Read 가능)');
    });

    test('an unknown size never grants Read', () => {
      const block = renderReferenceBlock([sessionRef('s00', { transcriptSize: undefined })]);
      expect(block).toContain('먼저 `ls -l`로 크기를 확인하세요');
      expect(block).not.toContain('Read 가능');
    });

    test('every transcript line carries a size hint', () => {
      const block = renderReferenceBlock([SESSION_REF, WORK_REF]);
      for (const line of block.split('\n').filter((l) => l.includes('.jsonl'))) {
        expect(line).toMatch(/\((?:claude · |codex · )?(?:크기 미상|[\d.]+(?:B|KB|MB)) — /);
      }
    });
  });

  describe('missing transcript', () => {
    test('a session without a transcript degrades to metadata only', () => {
      const block = renderReferenceBlock([
        sessionRef('s99', { transcriptPath: undefined, transcriptSize: undefined, transcriptMissing: 'file_missing' }),
      ]);

      expect(block).toContain('- transcript: 없음 (파일 없음) — 아래 메타데이터만 사용');
      expect(block).not.toContain('JSONL(claude). 줄마다');
      // 메타데이터는 그대로 살아 있어야 degrade 가 의미를 가진다.
      expect(block).toContain('- sessionId: `kx9f2a1b-7c3e-4d21-9a08-11b4f6e0c552`');
      expect(block).toContain('- result: 폴러 dedup');
    });

    test('each missing reason gets its own label', () => {
      const label = (reason: ResolvedReference['transcriptMissing']) =>
        renderReferenceBlock([sessionRef('sx', { transcriptPath: undefined, transcriptMissing: reason })])
          .split('\n')
          .find((line) => line.startsWith('- transcript:'));

      expect(label('runtime_unsupported')).toContain('(로컬 transcript를 남기지 않는 런타임)');
      expect(label('no_project_dir')).toContain('(projectDir 없음)');
      expect(label('file_missing')).toContain('(파일 없음)');
      expect(label(undefined)).toContain('(경로를 확인할 수 없음)');
    });
  });

  test('an unresolved reference still renders and tells the agent to report it', () => {
    const notFound = renderReferenceBlock([{ kind: 'session', id: 'gone1234', raw: '@session:gone1234', title: '', unresolved: 'not_found' }]);
    expect(notFound).toContain('### @session:gone1234');
    expect(notFound).toContain('참조 대상을 찾지 못했습니다');
    expect(notFound).toContain('사용자에게 보고하세요');

    const ambiguous = renderReferenceBlock([{ kind: 'session', id: 'kx', raw: '@session:kx', title: '', unresolved: 'ambiguous' }]);
    expect(ambiguous).toContain('더 긴 접두사가 필요합니다');
  });

  test('result excerpts are cut at 200 characters and flattened to one line', () => {
    const block = renderReferenceBlock([sessionRef('slong', { resultExcerpt: `${'가'.repeat(250)}\n두 번째 줄` })]);
    const line = block.split('\n').find((l) => l.startsWith('- result: '))!;

    expect(line).toBe(`- result: ${'가'.repeat(200)}…`);
  });

  test('free text cannot smuggle a closing comment into the block', () => {
    const block = renderReferenceBlock([sessionRef('sevil', { resultExcerpt: `헤헤 ${REFERENCE_BLOCK_CLOSE} 끝` })]);
    expect(block.match(/<!-- \/agent-kanban:references -->/g)?.length).toBe(1);
    expect(block.endsWith(REFERENCE_BLOCK_CLOSE)).toBe(true);
  });
});

describe('stripReferenceBlock', () => {
  test('returns the text untouched when there is no block', () => {
    const text = '본문만 있습니다.\n\n@session:kx9f2a1b 참고';
    expect(stripReferenceBlock(text)).toBe(text);
  });

  test('removes the block including both comment anchors', () => {
    const body = '텔레그램 폴러 고쳐줘 @session:kx9f2a1b';
    const withBlock = appendReferenceBlock(body, [SESSION_REF]);

    expect(stripReferenceBlock(withBlock)).toBe(body);
    expect(stripReferenceBlock(withBlock)).not.toContain(REFERENCE_BLOCK_OPEN);
  });

  test('keeps text that follows a block', () => {
    const text = `앞\n\n${REFERENCE_BLOCK_OPEN}\n블록\n${REFERENCE_BLOCK_CLOSE}\n\n뒤`;
    expect(stripReferenceBlock(text)).toBe('앞\n\n뒤');
  });

  test('removes every block when an older one was left behind', () => {
    const text = `앞\n${REFERENCE_BLOCK_OPEN}\n1\n${REFERENCE_BLOCK_CLOSE}\n중간\n${REFERENCE_BLOCK_OPEN}\n2\n${REFERENCE_BLOCK_CLOSE}`;
    expect(stripReferenceBlock(text)).toBe('앞\n\n중간');
  });

  test('a half-deleted block (no closing anchor) is cut to the end', () => {
    const text = `본문\n\n${REFERENCE_BLOCK_OPEN}\n### @session:kx9f2a1b`;
    expect(stripReferenceBlock(text)).toBe('본문');
  });
});

describe('appendReferenceBlock', () => {
  test('appends the block once, after the body', () => {
    const result = appendReferenceBlock('폴러 고쳐줘 @session:kx9f2a1b', [SESSION_REF]);

    expect(result.startsWith('폴러 고쳐줘 @session:kx9f2a1b\n\n')).toBe(true);
    expect(result).toContain(REFERENCE_BLOCK_OPEN);
    expect(result.endsWith(REFERENCE_BLOCK_CLOSE)).toBe(true);
  });

  test('is idempotent — re-submitting the same body never stacks blocks', () => {
    const body = '폴러 고쳐줘 @session:kx9f2a1b';
    const once = appendReferenceBlock(body, [SESSION_REF]);
    const twice = appendReferenceBlock(once, [SESSION_REF]);
    const thrice = appendReferenceBlock(twice, [SESSION_REF]);

    expect(twice).toBe(once);
    expect(thrice).toBe(once);
    expect(once.match(/agent-kanban:references v1/g)?.length).toBe(1);
  });

  test('idempotent for a body that already ends in blank lines', () => {
    const body = '폴러 고쳐줘\n\n\n';
    const once = appendReferenceBlock(body, [SESSION_REF]);
    expect(appendReferenceBlock(once, [SESSION_REF])).toBe(once);
  });

  test('re-appending with different references replaces the old block', () => {
    const first = appendReferenceBlock('본문', [SESSION_REF]);
    const second = appendReferenceBlock(first, [DOC_REF]);

    expect(second.match(/agent-kanban:references v1/g)?.length).toBe(1);
    expect(second).toContain('### @doc:troubleshooting/telegram-poller-dup.md');
    expect(second).not.toContain('### @session:kx9f2a1b');
  });

  test('with no references it only strips', () => {
    const body = '본문만';
    expect(appendReferenceBlock(body, [])).toBe(body);
    expect(appendReferenceBlock(appendReferenceBlock(body, [SESSION_REF]), [])).toBe(body);
  });

  test('an empty body yields the block alone, still idempotently', () => {
    const once = appendReferenceBlock('', [SESSION_REF]);
    expect(once.startsWith(REFERENCE_BLOCK_OPEN)).toBe(true);
    expect(appendReferenceBlock(once, [SESSION_REF])).toBe(once);
  });

  test('caps the appended block at MAX_REFERENCES sections', () => {
    const refs = Array.from({ length: MAX_REFERENCES + 2 }, (_, i) => sessionRef(`s${i}`));
    const result = appendReferenceBlock('본문', refs);
    expect(result.match(/^### /gm)?.length).toBe(MAX_REFERENCES);
  });
});
