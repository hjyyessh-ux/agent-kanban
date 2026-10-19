import type { KanbanStatus, Work } from '../../../src/core/types';

/**
 * UI copy — one home for the words the board repeats across screens.
 *
 * Rules (docs/design-system.md › "UI 문구"):
 * - UI 문구는 한국어. 고유명사·런타임·섹션 이름(Board, Works, Wiki, Claude,
 *   Codex, Skill, Telegram)과 도메인 용어 `unread`는 영어 그대로.
 * - 리터럴은 문장 대소문자로 쓴다. 대문자 표기가 필요하면 CSS
 *   `text-transform: uppercase`가 담당한다 — `'START TASK'`처럼 리터럴과 CSS가
 *   대문자를 이중으로 관리하지 않는다.
 * - 테스트·e2e는 이 상수를 import 하거나 같은 문자열을 셀렉터로 쓴다.
 */

/** Card status in words — board columns, Timeline legend, Work completion preview. */
export const STATUS_LABELS: Record<KanbanStatus, string> = {
  todo: '대기',
  in_progress: '진행중',
  complete: '검토 대기',
  done: '완료',
};

export const WORK_STATUS_LABELS: Record<Work['status'], string> = {
  active: '진행 중',
  done: '완료',
  discarded: '폐기',
};

/** Main tab strip — section names stay English (proper nouns). */
export const TAB_COPY = {
  board: 'Board',
  works: 'Works',
  wiki: 'Wiki',
  capabilities: 'Capabilities',
  scheduler: 'Scheduler',
  settings: 'Settings',
} as const;

/** Board toolbar (header row above the columns). */
export const TOOLBAR_COPY = {
  unreadOnly: 'Unread만',
  unreadOnlyTitle: 'unread 완료 카드만 보기 (세션 묶기에서는 unread가 있는 세션 묶음만)',
  unreadOnlyTimelineTitle: '리스트·보드 뷰에서 unread 카드만 보여줍니다 (타임라인에는 적용되지 않음)',
  filter: '필터',
  viewList: '리스트',
  viewBoard: '보드',
  viewTimeline: '타임라인',
  groupSessions: '세션 묶기',
  groupSessionsTitle: '검토 대기 카드를 세션별로 묶습니다',
  groupSessionsTimelineTitle: '리스트·보드 뷰에서 검토 대기 카드를 세션별로 묶습니다 (타임라인은 항상 세션 단위)',
} as const;

/** Card actions shared by BoardCard, the List row and Card detail. */
export const CARD_ACTION_COPY = {
  start: '▶ 시작',
  startNow: '▶ 지금 시작',
  starting: '시작 중…',
  /** Card detail's todo button — the dialog has room for the noun. */
  startTask: '▶ 작업 시작',
  /** in_progress → complete: the run stops and the card waits for review. */
  finish: '✓ 실행 종료',
  /** complete → done: the user signs the result off. */
  done: '✓ 완료',
  /** todo card that already has a result → complete. */
  markComplete: '검토 대기로',
  reopen: '다시 열기',
  queue: '큐 연결',
  dequeue: '큐 해제',
  delete: '삭제',
  /** done session group → wiki queue. */
  archive: '아카이브',
} as const;

/** Column header `⋯` menu. */
export const COLUMN_MENU_COPY = {
  hideAll: '모두 숨기기',
  collapseAll: '모두 접기',
  markAllRead: '모두 읽음',
  doneAll: '모두 완료',
  archiveAll: '모두 아카이브',
} as const;

/** Card detail — reasons a panel is disabled. */
export const CARD_DETAIL_COPY = {
  queueDisabledScheduled: '예약된 카드는 먼저 예약을 취소해야 큐에 연결할 수 있습니다.',
  scheduleDisabledQueued: '큐에 연결된 카드는 예약할 수 없습니다. 먼저 큐에서 해제하세요.',
  startNowHint: '지금 시작은 이 예약을 소비하고 즉시 한 번만 실행합니다.',
} as const;

export const SETTINGS_COPY = {
  newEntry: '+ 새 설정',
  edit: '✎ 편집',
} as const;

export const SCHEDULER_COPY = {
  deleteConfirm: (name: string) => `"${name}" 스케줄을 삭제할까요? 되돌릴 수 없습니다.`,
} as const;
