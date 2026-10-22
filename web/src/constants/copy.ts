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
  columnWorkCount: (count: number) => `Work ${count}`,
  collapse: 'Work 접기',
  expand: 'Work 펼치기',
  /** Footer toggle — same `hide` / `show` face as a session group; folded, it counts the sessions it hides. */
  toggleHide: 'hide',
  toggleShow: (sessions: number) => `show ${sessions}`,
  hiddenNote: (sessions: number, unread: number) => `숨긴 세션 ${sessions}${unread > 0 ? ` · unread ${unread}` : ''}`,
  titleHint: '클릭: Work 상세',
  favoriteHint: 'Work 완료 시에도 보드에 남는 즐겨찾기 카드',
  elsewhereHint: '다른 컬럼의 같은 Work로 이동',
  menuLabel: (title: string) => `${title} Work actions`,
  menuOpen: 'Work 상세 열기',
  menuRename: '이름 변경',
  menuMerge: '다른 Work와 병합…',
  menuComplete: 'Work 완료…',
  /** BoardCard footer, every group mode (`BoardCardWorkField`). */
  tagIcon: 'W',
  tagHint: 'Work 상세',
  /** `BoardCardWorkField` — the always-on Work picker on a todo/in-progress card. */
  workFieldHintEmpty: '눌러서 Work 지정',
  workFieldHintPlanned: '예약됨 — 시작하면 이 Work에 연결 · 눌러서 변경',
  workFieldHintLinked: 'Work에 연결됨 · 눌러서 변경',
  /** Drag & drop (4/5): hints are overlays, the tray rises from the bottom. */
  dragHint: '드래그: Work로 넣기 / 옮기기',
  trayLabel: 'Work로 넣기 ▸',
  /** Tray label while the pointer is over a target — board targets draw no text over the Work title. */
  trayHoverPrefix: '놓으면',
  trayHoverLink: (title: string) => `넣기 → ${title}`,
  trayHoverMove: (title: string) => `옮기기 → ${title}`,
  trayHoverUnlink: 'Work에서 빼기 (미배정)',
  trayHoverNew: '새 Work 만들어 넣기',
  trayAria: 'Work 드롭 트레이',
  trayCurrent: '(현재)',
  trayNew: '＋ 새 Work',
  trayOut: '⊘ Work에서 빼기',
  trayNoSession: '세션이 없는 카드는 Work에 넣을 수 없습니다',
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
  noticeCreatedPlanned: (title: string) => `＋ 새 Work "${title}"를 만들고 이 카드에 예약했습니다.`,
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
  /** `GROUP: WORKS` — folds / unfolds every Work container in the column at once. */
  collapseWorks: '모든 Work 세션 접기',
  expandWorks: '모든 Work 세션 펼치기',
} as const;

/** Card detail — reasons a panel is disabled. */
export const CARD_DETAIL_COPY = {
  queueDisabledScheduled: '예약된 카드는 먼저 예약을 취소해야 큐에 연결할 수 있습니다.',
  scheduleDisabledQueued: '큐에 연결된 카드는 예약할 수 없습니다. 먼저 큐에서 해제하세요.',
  startNowHint: '지금 시작은 이 예약을 소비하고 즉시 한 번만 실행합니다.',
} as const;

/** `WorkPicker` — the shared Work chooser (board card, session group, card detail, NEW TASK). */
export const WORK_PICKER_COPY = {
  ariaLabel: 'Work 지정',
  none: 'Work 없음',
  planned: '예약',
  searchPlaceholder: 'Work 검색…',
  /** Search box placeholder after `새 Work 만들기` was picked with nothing typed. */
  namePlaceholder: '새 Work 이름 입력 후 Enter',
  createNew: '새 Work 만들기',
  createNamed: (name: string) => `새 Work 만들기: "${name}"`,
  createAsk: '새 Work 만들기 — 위에 이름을 입력하세요',
  noMatch: '일치하는 Work가 없습니다',
  sessionCount: (count: number) => `${count} 세션`,
} as const;

/** Card detail's Work line under the title — `CardWorkLine` (pre-dispatch, editable) and its read-only form afterward — plus NEW TASK's Work field hint. */
export const CARD_WORK_COPY = {
  label: 'Work',
  emptyHint: '눌러서 Work 지정 — 세션이 시작되면 그 Work에 연결',
  /** `plannedWorkId` set, no session yet. */
  plannedHint: '예약 · 세션 시작 시 연결 · 눌러서 변경',
  /** The card's session already belongs to a Work. */
  linkedHint: '세션이 이 Work에 연결됨 · 보드의 Work 칸에서 변경',
  readOnlyHint: '세션이 시작된 카드는 보드의 Work 칸에서 지정합니다',
  /** NEW TASK — under the Work field. */
  createHint: 'Work를 고르면 Directory가 그 Work의 프로젝트로 채워지고, 세션이 시작될 때 자동으로 연결됩니다.',
} as const;

export const SETTINGS_COPY = {
  newEntry: '+ 새 설정',
  edit: '✎ 편집',
} as const;

export const SCHEDULER_COPY = {
  deleteConfirm: (name: string) => `"${name}" 스케줄을 삭제할까요? 되돌릴 수 없습니다.`,
} as const;
