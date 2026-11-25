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

/**
 * A session group on the board (`BoardSessionGroupCard`) — mockup
 * `docs/mockups/works-board-option-a-refined.html` (A′).
 */
/** LIST view (`BoardListView`) — slim table that follows the toolbar `GROUP`. */
export const LIST_COPY = {
  colTitle: '제목',
  colMeta: '프로젝트 · 런타임',
  colTime: '시각',
  colAction: '액션',
  expandAll: '▾ 모두 펼치기',
  collapseAll: '▴ 모두 접기',
  expandAllLabel: '모든 섹션·Work·세션 펼치기',
  collapseAllLabel: '모든 섹션·Work·세션 접기',
  hidden: (n: number) => `${n}개 숨김`,
  sectionToggle: (label: string, collapsed: boolean) => `${label} ${collapsed ? '펼치기' : '접기'}`,
  groupToggle: (title: string, collapsed: boolean) => `${title} ${collapsed ? '펼치기' : '접기'}`,
  empty: '카드 없음',
  addTask: '＋ Add Task',
  unassigned: 'Work 없는 세션',
  workTag: 'WORK',
  sessionMeta: (turns: number, duration: string | null) => (duration ? `${turns}턴 · 총 ${duration}` : `${turns}턴`),
  workMeta: (sessions: number, duration: string | null) => (duration ? `세션 ${sessions} · 총 ${duration}` : `세션 ${sessions}`),
  olderTurns: (n: number) => `이전 ${n}턴 더 보기`,
  openSession: '세션 대화 열기',
  openWork: 'Work 상세 열기',
} as const;

export const BOARD_SESSION_COPY = {
  fold: '▴ 접기',
  unfold: '▾ 펼치기',
  foldLabel: '세션 turn 목록 접기',
  unfoldLabel: '세션 turn 목록 펼치기',
  turnCount: (count: number) => `${count}턴`,
  lastRun: (stamp: string) => `마지막 ${stamp}`,
  olderTurns: (hidden: number) => `이전 ${hidden}턴 보기 ›`,
  hideOlderTurns: '이전 턴 접기 ▴',
  noPrompt: '(프롬프트 없음)',
  noResult: '(결과 없음)',
  unreadTurn: '안 읽은 turn',
  /** Native tooltip on the meta line — the exact stamps the short line abbreviates. */
  timesHint: (last: string, first: string, duration: string | null) =>
    [`마지막 수행 ${last}`, `시작 ${first}`, duration ? `소요 ${duration} (turn별 실행 시간 합계)` : null]
      .filter(Boolean)
      .join('\n'),
  turnHint: (title: string, at: string, duration: string | null) =>
    [title, duration ? `${at} · 실행 ${duration}` : at].join('\n'),
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
  sessionCount: (visible: number, total: number) =>
    visible === total ? `세션 ${total}` : `세션 ${visible}/${total}`,
  showMore: (hidden: number) => `＋ 세션 ${hidden}개 더 보기`,
  showLess: '세션 접기 ▴',
  unassignedHeading: 'Unassigned sessions',
  unassignedFold: 'Unassigned sessions 접기',
  unassignedUnfold: 'Unassigned sessions 펼치기',
  columnWorkCount: (count: number) => `Work ${count}`,
  collapse: 'Work 접기',
  expand: 'Work 펼치기',
  /** Header toggle — same `▴ 접기` / `▾ 펼치기` face as a session group; folded, it counts the sessions it hides. */
  toggleHide: '▴ 접기',
  toggleShow: (sessions: number) => `▾ 펼치기 · 세션 ${sessions}`,
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

/** Board card queue chip (`QueueTargetChip layout="card"`). The position
 *  reads the same as the queue settings panel's `⏭ NEXT` / `⏭ #N`. */
export const QUEUE_TARGET_COPY = {
  position: (position: number) => (position === 1 ? '⏭ NEXT' : `⏭ #${position}`),
  after: '완료 후 시작 ←',
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
  /** Board-wide turn order for every session group (was a per-session toggle). */
  turnOrderOldest: '대화 순서: 과거→최신으로',
  turnOrderNewest: '대화 순서: 최신→과거로',
} as const;

/** Card detail — reasons a panel is disabled. */
export const CARD_DETAIL_COPY = {
  queueDisabledScheduled: '예약된 카드는 먼저 예약을 취소해야 큐에 연결할 수 있습니다.',
  scheduleDisabledQueued: '큐에 연결된 카드는 예약할 수 없습니다. 먼저 큐에서 해제하세요.',
  startNowHint: '지금 시작은 이 예약을 소비하고 즉시 한 번만 실행합니다.',
} as const;

/** Result phase — re-pull a lost/truncated result from the session transcript (`useCardResultSync`). */
export const PROGRESS_COMMAND_TIME_COPY = {
  timezone: 'KST',
  unavailable: '명령 시작 시각 기록 없음',
} as const;

export const RESULT_SYNC_COPY = {
  action: '↻ Sync',
  syncing: 'Sync 중…',
  title: '세션 transcript에서 이 카드의 결과를 다시 가져옵니다',
  empty: '결과가 기록되지 않았습니다. 세션에는 결과가 있다면 ↻ Sync로 가져올 수 있습니다.',
  updated: (before: number, after: number) =>
    `결과를 다시 가져왔습니다 (${before.toLocaleString()} → ${after.toLocaleString()}자)`,
  unchanged: '이미 최신 결과입니다 — transcript보다 짧지 않습니다',
  fromRunEvents: ' · transcript가 없어 실행 기록에서 복구',
  turnIncomplete: ' · 세션에서도 이 턴은 끝까지 실행되지 않았습니다',
  markComplete: '완료로 표시',
  failed: (message: string) => `Sync 실패: ${message}`,
} as const;

/** `WorkPicker` — the shared Work chooser (board card, session group, card detail, NEW TASK). */
export const WORK_PICKER_COPY = {
  ariaLabel: 'Work 지정',
  none: 'Work 없음',
  /** Board card / session group trigger with no Work — quiet, sits in the card's top slot. */
  add: '＋ Work',
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

export const RESPONSE_GUIDELINES_COPY = {
  title: '공통 응답 지침',
  description: 'Claude·Codex 카드 실행(새 실행·재개·피드백)에 함께 전달됩니다. 각 도구의 사용자·프로젝트 지침은 그대로 유지되며, 카드 제목·내용·히스토리에는 표시되지 않습니다. 비워 두면 꺼집니다.',
  on: '켜짐', off: '꺼짐',
  placeholderPrefix: '비어 있으면 꺼짐 · 제안: ',
  useSuggestion: '제안 문구 넣기', clear: '비우기', save: '저장', saving: '저장 중…',
  savedOn: '저장했습니다. 다음 실행부터 적용됩니다.', savedOff: '비활성화했습니다. 다음 실행부터 전달하지 않습니다.',
  saveFailed: '저장하지 못했습니다.',
} as const;

export const SCHEDULER_COPY = {
  deleteConfirm: (name: string) => `"${name}" 스케줄을 삭제할까요? 되돌릴 수 없습니다.`,
} as const;

/** Settings — Card/Works History subscription (read-only owner summary). */
export const BOARD_HISTORY_COPY = {
  title: '카드·작업 이력 구독',
  description: '카드와 작업 묶음의 상태 변경을 기록하는 구독입니다. 여기서는 상태만 확인할 수 있습니다.',
  details: '기록 상세 보기',
  refresh: '상태 다시 읽기',
  refreshing: '읽는 중…',
  refreshSucceeded: '최신 상태를 확인했습니다.',
  loading: '상태를 불러오는 중…',
  checkedAt: '마지막으로 읽은 시각',
  never: '기록 없음',
  stateRegistered: '구독 등록됨',
  stateNotRegistered: '미등록 · 구독 OFF',
  stateInactive: '이 프로세스에서 비활성',
  stateUnavailable: '일시적 조회 실패',
  notRegisteredHelp: '등록된 소비자가 없어 카드·작업 변경을 기록하지 않습니다. 이 화면에서는 등록하지 않습니다.',
  inactiveHelp: '기존 세션·문서 컨텍스트 동기화가 켜져 있어 이 프로세스는 카드·작업 이력를 기록·제공하지 않습니다.',
  unavailableHelp: '등록 정보는 있지만 기록 파일을 지금 읽지 못했습니다. 구독이 꺼졌다는 뜻이 아닙니다. 잠시 뒤 다시 읽어 보세요.',
  continuous: '창 시작부터 연속 기록',
  declaredMissing: (count: number) => `공식 누락 ${count}건`,
  pendingBadge: '기록 확정 대기',
  preCaptureBadge: '설치 전 미기록 구간 있음',
  sectionWindow: '기록 범위',
  windowStart: '기록 창 시작 (설치 7일 전, 고정)',
  installedAt: '구독 등록(설치) 시각',
  captureStartedAt: '실제 기록 시작',
  captureNotStarted: '카드·작업 기준선이 아직 모두 잡히지 않음',
  preCaptureGap: '설치 전 미기록 구간',
  preCaptureNone: '없음 — 창 시작부터 기록됨',
  preCaptureHelp: '이 구간의 변경은 기록되지 않았고, 현재 상태로 만들어내지도 않습니다.',
  sectionGaps: '설치 이후 누락·대기',
  gaps: '공식 누락 구간 (gap)',
  gapsNone: '없음',
  gapsMore: (shown: number, total: number) => `최근 ${shown}건 표시 / 전체 ${total}건`,
  gapKindCard: '카드',
  gapKindWork: '작업 묶음',
  gapUnobserved: '기록을 거치지 않은 저장(이전 빌드·직접 수정)',
  gapInterrupted: '중단된 기록 후 복구',
  gapHelp: '누락 구간에서는 최종 상태는 전달되지만 중간 변경이 합쳐졌을 수 있습니다.',
  pending: '확정 대기 중인 기록 (pending)',
  pendingNone: '없음',
  pendingSince: (time: string) => `${time}부터 확정 대기`,
  sectionConsumer: '소비자 수신·확정',
  lastRead: '마지막 실제 수신 시각',
  lastAck: '마지막 확정(ACK) 시각',
  notCollected: '미수집 — 서버가 이 시각을 기록하지 않습니다',
  ackedThrough: '확정된 마지막 변경이 기록된 시각',
  ackedThroughHelp: 'ACK한 시각이 아니라, 확정 범위의 마지막 변경이 기록된 시각입니다.',
  ackedThroughNone: '아직 확정된 변경 없음',
  ackedThroughPruned: '보존 기간이 지나 확인 불가',
  awaitingAck: '전달 후 ACK 대기',
  yes: '예', no: '아니오',
  acked: '확정된 변경 수',
  ackedPartial: '집계 생략 — 일부 변경의 보존 기간(30일)이 지나 전체 수가 아닙니다',
  unacked: '아직 확정되지 않은 변경 수',
  unackedExpired: '집계 생략 — 수신 측의 동기화 위치가 만료되었습니다',
  cursorExpired: '동기화 위치 만료 — 수신 측에서 다시 동기화해야 합니다',
  sectionActivity: '기록 활동',
  lastChange: '마지막 변경 기록 시각',
  lastChangeNone: '아직 기록된 변경 없음 (구독은 켜져 있음)',
  lastSave: '마지막 저장 대조 시각',
  lastSaveHelp: '보드·작업 저장을 대조한 시각입니다. 변경이 없던 저장도 포함합니다.',
  metadataOnly: '이 구독은 상태·시각 메타데이터만 다룹니다. 제목·본문은 처음부터 수집하지 않으므로, 최근 변경이나 본문이 없다는 것은 구독 OFF와 다릅니다.',
  readBasis: '수치는 마지막 저장·소비자 조회 때 대조된 기준입니다. 이 화면의 읽기는 아무것도 기록하지 않습니다.',
  errorTitle: '상태 조회 실패',
  errorUnauthorized: '로컬 관리자 인증이 필요합니다. 이 컴퓨터의 localhost 주소로 열어 주세요.',
  errorLocalOnly: '이 상태는 이 컴퓨터(localhost)에서만 볼 수 있습니다.',
  errorTemporary: '일시적으로 상태를 읽지 못했습니다.',
  staleNote: (time: string) => `아래는 직전에 성공한 조회(${time}) 기준입니다.`,
  failedAt: (time: string) => `시도 시각 ${time}`,
} as const;
