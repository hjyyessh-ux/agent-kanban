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

/**
 * Board toolbar (header row above the columns). The control labels are English
 * on purpose — one uppercase strip (`● N UNREAD` · `≡ FILTER` · LIST|BOARD|TIMELINE ·
 * GROUP: CARD|SESSION|WORKS) read as one instrument; tooltips stay Korean.
 * Literals are sentence case — `.kv2-toolbar-ctl` uppercases them.
 */
export const TOOLBAR_COPY = {
  unread: 'unread',
  unreadOnlyTitle: '눌러서 unread 완료 카드만 보기 (SESSION·WORKS 묶기에서는 unread가 있는 세션 묶음만) · u / Shift+U로 이동',
  unreadOnlyActiveTitle: 'unread만 보는 중 — 다시 누르면 전체 보기 · u / Shift+U로 이동',
  unreadOnlyTimelineTitle: '리스트·보드 뷰에서 unread 카드만 보여줍니다 (타임라인에는 적용되지 않음)',
  filter: 'Filter',
  viewModeLegend: 'Board view mode',
  viewList: 'List',
  viewBoard: 'Board',
  viewTimeline: 'Timeline',
  groupLabel: 'Group',
  groupLegend: 'Group by',
  groupCard: 'Card',
  groupSession: 'Session',
  groupWorks: 'Works',
  groupCardTitle: '검토 대기 카드를 낱장으로 봅니다',
  groupSessionTitle: '검토 대기 카드를 세션별로 묶습니다',
  groupWorksTitle: '세션을 Work 단위로 묶어 봅니다',
  /** FILTER popover `WORK:` section — only offered in `GROUP: WORKS`. */
  workFilterLegend: 'Work',
  workFilterAll: 'All',
  workFilterUnassigned: 'Unassigned',
  groupTimelineTitle: '리스트·보드 뷰에만 적용됩니다 (타임라인은 항상 Work·세션 단위)',
} as const;

/** Container tabs on board groups — sentence case, uppercased by CSS. */
export const BOARD_GROUP_COPY = {
  sessionTab: 'Session',
  workTab: 'Work',
} as const;

/**
 * `GROUP: WORKS` on the board — the Work container (`BoardWorkContainer`), the
 * UNASSIGNED divider, the column `WORK n` count and the card's Work tag.
 * Counts and `Show N more` stay English like the session group's own
 * `Show N more` / `N cards`; actions and hints are Korean.
 */
export const BOARD_WORKS_COPY = {
  sessionCount: (visible: number, total: number) => {
    const noun = total === 1 ? 'session' : 'sessions';
    return visible === total ? `${total} ${noun}` : `${visible} / ${total} ${noun}`;
  },
  showMore: (hidden: number) => `＋ Show ${hidden} more ${hidden === 1 ? 'session' : 'sessions'}`,
  showLess: 'Show less ▴',
  unassignedHeading: 'Unassigned sessions',
  unassignedEmpty: 'No unassigned sessions',
  columnWorkCount: (count: number) => `Work ${count}`,
  collapse: 'Work 접기',
  expand: 'Work 펼치기',
  titleHint: '클릭: Work 상세',
  favoriteHint: 'Work 완료 시에도 보드에 남는 즐겨찾기 카드',
  elsewhereHint: '다른 컬럼의 같은 Work로 이동',
  menuLabel: (title: string) => `${title} Work actions`,
  menuOpen: 'Work 상세 열기',
  menuRename: '이름 변경',
  menuMerge: '다른 Work와 병합…',
  menuComplete: 'Work 완료…',
  /** `⋯` first item: fold the Work to header + meta / open it (newest 2 sessions, then Show more). */
  menuCollapseSessions: '세션 접기',
  menuExpandSessions: '세션 펼치기',
  /** BoardCard footer in `GROUP: WORKS`. */
  tagIcon: 'W',
  tagHint: 'Work 상세',
  unassignedTag: 'Work 미배정 · 드래그해서 넣기',
  /** Drag & drop (4/5): hints are overlays, the tray rises from the bottom. */
  dropHint: '여기에 놓아 이 Work에 넣기',
  unassignHint: '여기에 놓으면 Work에서 빼기 (미배정)',
  dragHint: '드래그: Work로 넣기 / 옮기기',
  trayLabel: 'Work로 넣기 ▸',
  trayAria: 'Work 드롭 트레이',
  trayCurrent: '(현재)',
  trayNew: '＋ 새 Work',
  trayOut: '⊘ Work에서 빼기',
  trayNoSession: '세션이 없는 카드는 Work에 넣을 수 없습니다',
  /** `⋯ → Work로 이동` (keyboard path for the same actions). */
  moveMenuLabel: (title: string) => `${title} — Work로 이동`,
  moveMenuTitle: 'Work로 이동…',
  moveTo: (title: string) => `→ ${title}`,
  moveNew: '＋ 새 Work 만들어 넣기…',
  moveOut: '⊘ Work에서 빼기',
  /** New-Work name dialog. */
  newWorkTitle: '새 Work 만들기',
  newWorkLabel: 'Work 이름',
  newWorkSubmit: '만들어 넣기',
  newWorkCancel: '취소',
  /** Notices — the undo is one of `useWorks`'s own mutations in reverse. */
  undo: '되돌리기',
  noticeMoved: (from: string, to: string) => `✓ 세션을 "${from}"에서 "${to}"(으)로 옮겼습니다.`,
  noticeMovedEmptied: (to: string, from: string) => `✓ 세션을 "${to}"(으)로 옮기고, 비워진 Work "${from}"를 삭제했습니다.`,
  noticeUnlinked: (from: string) => `⤺ 세션을 "${from}"에서 뺐습니다 (미배정).`,
  noticeFailed: 'Work 변경에 실패했습니다',
  /** Session header `★ N` — favorites survive the Work completion sweep. */
  sessionFavoriteHint: (count: number) => `즐겨찾기 카드 ${count}장 — Work 완료 시 보드에 남음`,
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
