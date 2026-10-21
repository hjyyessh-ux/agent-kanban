# 메인 보드 Works 묶기 — 구현 보고서

- 작성일: 2026-10-21
- 브랜치: `feat/ui-audit-improvements` (커밋 전, 작업트리 변경 상태)
- 스펙: 승인된 목업 `docs/mockups/works-on-board.html` **B안** (Work 안에 최신 세션 카드 2개)
- 작업 단위: 칸반 큐 체인 카드 1/5 ~ 5/5. 이 문서는 5/5(목업 대조 · 전체 검증)의 결과입니다.

## 개요

Board 툴바에 `GROUP: CARD | SESSION | WORKS` 세그먼트를 추가하고, `WORKS`를 고르면 검토 대기·완료 컬럼의 세션 그룹을 **Work 컨테이너**로 묶어 보여 줍니다. 세션을 Work에 넣기·옮기기·빼기는 드래그 & 드롭, 하단 트레이, `⋯ → Work로 이동` 메뉴로 하고, 모든 변경은 되돌리기 알림을 띄웁니다.

| 카드 | 범위 |
|---|---|
| 1/5 | 토큰(`--kv2-work-*`, `--kv2-session-tab-*`, `--kv2-toolbar-*`) · 툴바 통일 · GROUP 3-way · SESSION 탭 |
| 2/5 | Works 뷰모델(`board-works.ts`) · `useWorks` 데이터 연결 · `WORK:` 필터 |
| 3/5 | Work 컨테이너 렌더(B안) · Work 태그 · `UNASSIGNED SESSIONS` · unread 점프 |
| 4/5 | 드래그 & 드롭 · 트레이 · 되돌리기 · `⋯ → Work로 이동` |
| 5/5 | 목업 대조 · 차이 수정 · 전체 테스트 · 이 보고서 |

모델·API 설명은 `docs/works.md` ⑥, 컴포넌트별 책임은 `web/src/components/Board/AGENTS.md`에 있습니다.

## 스펙 항목별 구현 내역

| 스펙 항목 (목업 B안) | 구현 | 파일 |
|---|---|---|
| 툴바 34px · 영어 라벨 · 통일 스타일 (`● N UNREAD` · `≡ FILTER` · `LIST/BOARD/TIMELINE` · `GROUP`) | 공용 셸 `.kv2-toolbar-ctl` / `.kv2-toolbar-seg`, 라벨은 `TOOLBAR_COPY` | `web/src/App.tsx`, `web/src/styles/kv2/board.css`, `web/src/constants/copy.ts` |
| GROUP 3-way + 기존 설정 이관 | `BoardGroupMode`, `parseBoardGroupMode`(옛 `'true'` → `session`) | `web/src/components/Board/board-group-mode.ts` |
| SESSION 폴더 탭 · 그룹 간격 | `.kv2-session-tab`, `--kv2-session-tab-height`만큼 간격 확보 | `BoardCompleteSessionView.tsx`, `kv2/board.css` |
| WORK 탭 · 3px Work 블루 테두리 · 틴트 면 · 겹친 종이 그림자 | `BoardWorkContainer` + `--kv2-work-*` 토큰 | `web/src/components/Board/BoardWorkContainer.tsx`, `web/src/styles/kanban-v2.tokens.css` |
| 최신 2개 세션 + `＋ Show N more sessions · ● k unread` / `Show less ▴` | `WORK_VISIBLE_SESSIONS = 2`, 숨긴 unread 수 | `board-works.ts`, `BoardWorkContainer.tsx` |
| 메타 줄: 프로젝트 칩 · `x / y sessions` · `★ N` · `진행중 1 ↗` | `selectWorkFragments`의 `sessionCount`/`totalSessionCount`/`favoriteCount`/`elsewhere` | `board-works.ts`, `BoardWorkContainer.tsx` |
| Work 접기 → 헤더 + 메타 줄만 (피드백으로 미니 막대 제거) · `⋯ → 세션 접기 / 세션 펼치기` | 컨테이너 로컬 state, 펼치면 최신 2개부터 | `BoardWorkContainer.tsx` |
| `UNASSIGNED SESSIONS n` 구분선 · 미배정 세션 | `.kv2-works-unassigned-head` + `BoardCompleteSessionView groups={unassigned}` | `BoardColumn.tsx` |
| 컬럼 헤더 `WORK n` | `workCount` | `BoardColumnHeader.tsx` |
| 대기·진행중 카드의 Work 태그 / `Work 미배정 · 드래그해서 넣기` | `BoardCard`의 `workTag` | `BoardCard.tsx` |
| 세션 헤더 `★ N`, `Show N more · ★ k` | `summarizeGroupFavorites`, `.kv2-favorite-pill` | `BoardCompleteSessionView.tsx`, `board-works.ts` |
| 제목 hover → 같은 Work 강조, `↗` 칩 → 다른 컬럼 점프 | `.kv2-work-peer`, `.kv2-work-flash` | `BoardWorkContainer.tsx`, `kv2/board.css` |
| `⋯` Work 메뉴 (상세 / 이름 변경 / 병합 / 완료) | `WorkDetailDialog initialIntent` | `BoardWorkContainer.tsx`, `web/src/components/Works/WorkDetailDialog.tsx` |
| `FILTER` 안 `WORK: All / Unassigned / <Work>` | `BoardWorkFilter`, `filterCardsByWork` | `BoardFilterBar.tsx`, `board-works.ts`, `App.tsx` |
| UNREAD 토글이 Works 모드에서도 동작 | `filterBoardCards` → `filterCardsByWork` → `filterUnreadOnly` 순서 | `BoardScreen.tsx` |
| 드래그 & 드롭 (넣기 · 옮기기 · 같은 컬럼 UNASSIGNED로 빼기) | 순수 함수 `resolveWorkDrop`, `BoardWorkDnDContext` | `board-works.ts`, `board-work-dnd.tsx`, `BoardScreen.tsx` |
| 하단 트레이 (`Work로 넣기 ▸` · `(현재)` · `＋ 새 Work` · `⊘ Work에서 빼기`) | `BoardWorkDropTray`, `BoardNewWorkDialog` | `BoardWorkDropTray.tsx`, `BoardNewWorkDialog.tsx` |
| 되돌리기 토스트 | `applyWorkDropAction` → `WorkSessionNotice` | `board-work-actions.ts`, `App.tsx` |
| 키보드 대안 | `⋯ → Work로 이동` | `BoardWorkMoveMenu.tsx` |
| unread 점프(`u`)가 화면 순서를 따름 | `selectBoardNavOrder`의 `layout.works` | `unread-navigation.ts` |
| 다크 토큰 | 모든 새 토큰 라이트·다크 쌍, AA 대비 테스트 | `kanban-v2.tokens.css`, `web/src/styles/token-contrast.test.ts` |

## 목업 vs 구현 스크린샷

뷰포트는 모두 1600×1000입니다. 구현 쪽은 격리된 test-server(`scripts/test-server.ts`, 별도 데이터 디렉터리)에 목업과 같은 데이터를 넣고 찍었습니다. 데이터는 Work 3개, 세션 15개(턴 59장), unread 5개, 즐겨찾기 3개입니다.

> 앱은 헤더·컬럼 폭·글자 크기가 목업과 원래 다릅니다(목업은 툴바를 탭 줄에 올리고 컬럼이 약 1.2배 넓음). 그래서 픽셀 단위가 아니라 **구성 요소 단위**로 비교했습니다.

### GROUP: WORKS — 라이트

| 목업 (B안) | 구현 |
|---|---|
| ![](assets/works-on-board/mock-works-light.png) | ![](assets/works-on-board/app-works-light.png) |

전체 페이지: [목업](assets/works-on-board/mock-works-light-full.png) · [구현](assets/works-on-board/app-works-light-full.png)

### GROUP: WORKS — 다크

| 목업 (`?theme=dark`) | 구현 |
|---|---|
| ![](assets/works-on-board/mock-works-dark.png) | ![](assets/works-on-board/app-works-dark.png) |

### GROUP: SESSION (구현만 — 목업은 WORKS 화면 기준)

| 라이트 | 다크 |
|---|---|
| ![](assets/works-on-board/app-session-light.png) | ![](assets/works-on-board/app-session-dark.png) |

### 드래그 중 (트레이 노출, 미배정 세션을 검토 대기 Work 위로)

| 목업 | 구현 |
|---|---|
| ![](assets/works-on-board/mock-drag-light.png) | ![](assets/works-on-board/app-drag-light.png) |
| ![](assets/works-on-board/mock-drag-dark.png) | ![](assets/works-on-board/app-drag-dark.png) |

### 드롭 후 되돌리기 알림

| 목업 | 구현 |
|---|---|
| ![](assets/works-on-board/mock-toast-light.png) | ![](assets/works-on-board/app-toast-light.png) |
| ![](assets/works-on-board/mock-toast-dark.png) | ![](assets/works-on-board/app-toast-dark.png) |

### UNREAD 활성

| 목업 | 구현 |
|---|---|
| ![](assets/works-on-board/mock-unread-light.png) | ![](assets/works-on-board/app-unread-light.png) |
| ![](assets/works-on-board/mock-unread-dark.png) | ![](assets/works-on-board/app-unread-dark.png) |

### FILTER 열림 (WORK 섹션)

| 목업 | 구현 (본문을 WORK 섹션까지 스크롤) |
|---|---|
| ![](assets/works-on-board/mock-filter-light.png) | ![](assets/works-on-board/app-filter-light.png) |
| ![](assets/works-on-board/mock-filter-dark.png) | ![](assets/works-on-board/app-filter-dark.png) |

### 항목별 대조 결과

| 항목 | 결과 | 비고 |
|---|---|---|
| 툴바 (34px · 영어 라벨 · 통일 스타일) | 일치 | 다크의 활성 하단 줄, UNREAD 빨강 · WORKS 블루 모두 같음. 위치만 다름(아래 의도적 차이 1) |
| WORK 탭 · 테두리 · 겹친 그림자 | 일치 | 라이트·다크 모두 |
| SESSION 탭과 간격 | 일치 | 탭 왼쪽 띠가 본체 상태 띠와 이어짐 |
| 최신 2개 + Show more | 일치 | `＋ Show 2 more sessions · ● 1 unread` 문구·색 동일 |
| 메타 줄 (`★ N`, `x / y sessions`, `↗` 칩) | 일치 | UNREAD 활성 때 `y`도 필터를 따르는 점까지 목업과 같음 |
| UNASSIGNED 구분선 | 일치 | 비어 있으면 `UNASSIGNED SESSIONS 0` + 빈 영역(목업과 같음) |
| Work 태그 (대기·진행중 카드) | 일치 | `[W 제목]` / 점선 `Work 미배정 · 드래그해서 넣기` |
| 트레이 | 일치 | `Work로 넣기 ▸` · Work 버튼 · `＋ 새 Work`. 드롭 힌트 표시 범위만 다름(의도적 차이 4) |
| 되돌리기 토스트 | 차이 | 기존 `WorkSessionNotice` 재사용(의도적 차이 5) |
| 다크 토큰 | 일치 | 새 토큰은 모두 라이트·다크 쌍. 목업 값이 AA에 못 미치는 3곳만 값 조정(의도적 차이 6) |
| **Work 안 세션 헤더의 프로젝트 칩** | **불일치 → 수정** | 아래 "5/5에서 고친 것" |

## 5/5에서 고친 것

**Work 안 세션 헤더의 프로젝트 칩이 `ag` 두 글자로 줄어듦**

- **증상**: Work 컨테이너 안은 맨 컬럼보다 약 40px 좁습니다. 세션 헤더 row ①의 오른쪽 묶음(`● N` · `★ N` · `#s-b0933a` · `⋯`)은 줄지 않게 되어 있어서, 남은 폭이 전부 프로젝트 칩에서 빠졌습니다. 목업은 `agent-kanban`을 다 보여 줍니다.
- **수정** (`web/src/styles/kv2/board.css`, `.kv2-work` 범위에서만):
  - 프로젝트 칩에 `min-width: min(9ch, 45%)` 바닥을 줬습니다.
  - 세션 `IdChip`이 먼저 줄어들게 했습니다(말줄임, 복사 아이콘 숨김). 클릭하면 전체 id가 복사되는 동작은 그대로입니다.
  - 3/5에서 Work 헤더의 id 칩에 적용한 규칙과 같습니다.
- **결과**: `ag` → `agent-kanba…`, id는 `#s…`로 줄어듭니다. 컬럼 바로 아래의 미배정 세션과 `GROUP: SESSION` 화면은 바뀌지 않습니다.
- 문서: `docs/works.md` ⑥ "목업 대조 (5/5)", `web/src/components/Board/AGENTS.md`(`BoardWorkContainer` 행).

## 사용자 피드백 반영 (5/5 이후)

1. **세션 접기 (Work별 `⋯` 메뉴)**: 각 Work의 `⋯` 메뉴 첫 항목이 `세션 접기`입니다. 접은 뒤에는 같은 자리가 `세션 펼치기`로 바뀝니다. ▾/▸와 같은 동작입니다.
   - 접으면 헤더(제목·`⋯`)와 메타 줄만 남습니다.
   - 펼치면 **최신 2개 세션만** 보입니다. 나머지는 `＋ Show N more sessions`를 한 번 더 눌러야 보입니다. 접을 때 `Show more` 상태를 초기화하므로, 다시 펼쳐도 항상 2개부터 시작합니다.
   - 접힘 상태는 Work 조각마다 따로이고 새로고침하면 펼친 상태로 돌아옵니다.
   - Work를 접었을 때 보이던 "세션당 상태색 미니 막대"는 "메타 데이터만 보이게"라는 요청에 맞춰 뺐습니다. 목업 B안과 다른 점입니다.
   - 처음에는 툴바 전역 토글(`Hide sessions`)로 넣었는데, 피드백에 따라 걷어내고 Work별 메뉴로 옮겼습니다.
2. **제목 잘림 해소**: `● N`과 Work id 칩을 제목 옆에서 메타 줄 오른쪽 끝으로 내렸습니다(`프로젝트 칩 · x / y sessions · ★ N ··· ● N · #id`).
   - `진행중 1 ↗` 칩은 그 아래 줄로 분리했습니다.
   - 메타 줄은 4컬럼 1600px에서도 한 줄을 유지하고, 좁으면 프로젝트 칩과 id 칩이 먼저 줄어듭니다.
   - 결과: `Agent-kanban…` → `Agent-kanban UI 개선 점검`.

| 세션 펼침 (기본) | 첫 Work를 `세션 접기`로 접고 `⋯` 메뉴를 연 상태 |
|---|---|
| ![](assets/works-on-board/app-works-light.png) | ![](assets/works-on-board/app-fold-light.png) |
| ![](assets/works-on-board/app-works-dark.png) | ![](assets/works-on-board/app-fold-dark.png) |

- 테스트: `BoardWorkContainer.test.tsx`(헤더/메타 배치, 접힘 = 헤더 + 메타, `⋯` 메뉴 항목 순서와 접기/펼치기 라벨), `e2e/board-works.e2e.ts`의 "⋯ 세션 접기" 1건(접기 → 펼치면 2개 → Show more로 3개 → 다시 접고 펼치면 2개)을 추가했습니다.

## 의도적 차이와 사유

1. **툴바 위치**: 목업은 툴바를 탭 줄 오른쪽에 둡니다. 앱은 원래부터 툴바를 탭 아래 둘째 줄에 둡니다. 이번 범위는 툴바 컨트롤의 모양 통일이고 앱 헤더 레이아웃은 아니어서 그대로 뒀습니다.
2. **세션 헤더 버튼**: 앱의 세션 헤더에는 기존 `SHOW`/`HIDE` · `✓ 완료` · `아카이브` 버튼이 항상 있어서 목업보다 조금 높습니다. "세션 그룹 동작 변경 없음" 조건을 지키려고 그대로 뒀습니다(3/5 결정).
3. **Work 안 세션 기본값 · Work 헤더 배치**: 피드백으로 Work 헤더에는 제목과 `⋯`만 두고 `● N`·id는 메타 줄로 옮겼습니다(목업은 제목 옆). 목업 데모는 세션 하나(`b0933a`)를 펼친 상태로 시작합니다. 앱은 스펙 문구("기본은 헤더만 보여서 3단 중첩이 상시로 생기지 않음")대로 Work 안 세션을 접어서 시작합니다. 목업의 `SMS Whitelist` Work가 접혀 있는 것도 데모 초기값이고, 앱은 펼쳐서 시작합니다.
4. **드래그 중 드롭 힌트 범위**: 목업은 드래그하는 동안 모든 컬럼의 Work를 점선으로 표시합니다. 앱은 **같은 컬럼**의 Work만 대상으로 표시합니다. 보드에 컬럼 간 상태 변경 DnD가 없어서, 다른 컬럼에 놓으면 아무것도 바뀌지 않기 때문입니다(4/5 결정, `resolveWorkDrop`이 `null`). 다른 컬럼 Work에 넣는 길은 트레이입니다.
5. **되돌리기 알림**: 목업은 오른쪽 아래 어두운 토스트(`세션 ‘…’ : 미배정 → ‘Work’` + 노란 버튼)입니다. 앱은 Works 탭과 같은 `WorkSessionNotice`(왼쪽 아래, `세션을 "Work"에 연결했습니다.` + `되돌리기` + `×`)를 씁니다. 같은 동작에 알림이 두 종류가 되지 않게 하려고 기존 컴포넌트를 재사용했습니다.
6. **색 값 조정 (AA 대비)**: 목업 값 그대로면 대비 4.5:1에 못 미치는 곳이 3곳 있어 값을 바꿨습니다(1/5). `token-contrast.test.ts`가 검증합니다.

   | 자리 | 목업 값 대비 | 바꾼 것 |
   |---|---|---|
   | 라이트 FILTER 활성 | 3.7:1 | `--kv2-btn-primary-bg` → 4.9:1 |
   | 다크 WORK 탭 | 3.8:1 | 면을 어둡게 섞음 → 6.0:1 |
   | 다크 꺼진 UNREAD 글자 | 4.4:1 | `--kv2-toolbar-unread-fg` → 5.0:1 |

   라이트 즐겨찾기 pill 글자도 amber 원색이 흰 면에서 2:1이라 잉크 쪽으로 당겼습니다(3/5).
7. **FILTER 패널**: 목업은 FILTER 버튼 아래 작은 팝오버입니다. 앱은 기존의 크기 조절 가능한 어두운(inverse) 필터 패널(`Board tools / Filter cards`)을 그대로 쓰고, 맨 아래에 `WORK` 섹션만 더했습니다. 기존 필터(키워드 · 세션 이름 · 세션 ID · 날짜)가 목업보다 많아서 패널 형태를 유지했습니다. 높이 1000px에서는 WORK 섹션이 패널 본문 스크롤 아래에 있습니다.
8. **id 표기**: 목업은 `#7f2a` 같은 짧은 id를 씁니다. 실제 Work id는 21자 nanoid라서 Work 헤더·세션 헤더 모두 id 칩이 먼저 줄어듭니다(클릭하면 전체 복사).

## 테스트 결과

### 실행 방법과 환경

- 칸반 데몬(:24680)과 원래 떠 있던 오래된 test-server(:24681, 2026-10-19부터 실행 중)는 **건드리지 않았습니다**.
- e2e는 새 test-server를 **:24682**에 띄워 돌렸습니다. 저장소를 가리키는 심볼릭 링크 디렉터리(`.omc/wob/root`, gitignore 대상)에서 포트만 바꾼 `playwright.config.ts` 복사본으로 실행해서, `.e2e-data`·`.e2e-home`도 기존 서버와 겹치지 않습니다.

```bash
# macOS zsh, 저장소 루트
bun run build:web
cd .omc/wob/root && E2E_SKIP_BUILD=true E2E_BASE_URL=http://127.0.0.1:24682 bunx playwright test
```

- 기존부터 깨져 있던 실패인지 가리려고, `git archive HEAD`로 푼 **변경 전 코드**(`.omc/wob/base`, :24683)에서 실패한 스펙 파일 8개를 같은 방식으로 다시 돌렸습니다. git 상태(브랜치·stash·worktree)는 바꾸지 않았습니다.

### 결과

| 명령 | 결과 |
|---|---|
| `bunx tsc --noEmit` | 에러 0 |
| `bun run build:web` | 성공 |
| `bun test` | 2024개 중 2023 pass / 1 fail / 1 error (아래 참고) |
| `bunx playwright test` (전체, :24682) | **239 passed / 17 failed / 5 did not run** (9.1분) |
| 같은 실패 스펙 8개를 변경 전 코드(`HEAD`)로 | 60 passed / **같은 17 failed** / 5 did not run |

이번 기능과 직접 관련된 스펙은 모두 통과했습니다.

| 스펙 | 통과 |
|---|---|
| `board-works.e2e.ts` (드래그·트레이·되돌리기·`⋯` 이동·필터) | 8 / 8 |
| `board-drag-reorder.e2e.ts` | 1 / 1 |
| `works.e2e.ts` | 41 / 41 |
| `theme.e2e.ts` | 3 / 3 |
| `board.e2e.ts` | 5 / 5 |
| `quick-actions.e2e.ts` | 8 / 8 |
| `deck-capture.e2e.ts` | 12 / 12 |
| `works-review-capture.e2e.ts` | 4 / 4 |
| `v2-visual-audit.e2e.ts` | 2 / 4 (실패 2건은 기존 실패) |

### 기존부터 깨져 있던 실패 (이번 변경과 무관)

변경 전 코드(`HEAD` = `cbadf1a`)에서도 **같은 테스트가 같은 메시지로** 실패합니다.

| 스펙 | 실패 수 | 증상 |
|---|---|---|
| `agent-type.e2e.ts` (Settings 모델 필터) | 2 | `locator.textContent` 20초 타임아웃 |
| `capabilities-runtime.e2e.ts` | 1 (+5 did not run, serial) | 요소 없음 |
| `capabilities.e2e.ts` | 1 | Placement Targets 개수 불일치 |
| `mention.e2e.ts` | 1 | 참조 블록 미포함 |
| `runtime-integration.e2e.ts` | 2 | 카드 수 불일치 / 모바일 요소 없음 |
| `v2-visual-audit.e2e.ts` | 2 | 생성 모달 에이전트 칩 `Expected 4, Received 0` / 대화 턴 라벨 색 `rgb(166,107,123)` 기대 ↔ `rgb(255,59,107)` |
| `wiki-archive-cards.e2e.ts` | 3 | 요소 없음 / click 타임아웃 |
| `works-review-regression.e2e.ts` | 5 | click 20초 타임아웃 |

`bun test`의 1 fail(`scheduled-dispatch-service.test.ts` › "race between timer scan and manual dispatch…")과 1 error(`schedulers.json` ENOENT, 테스트 사이 임시 디렉터리 정리)는 백엔드 테스트입니다. 이번 작업은 `src/`를 바꾸지 않았습니다. 이 파일만 따로 3번 돌리면 1번 실패하는 **타이밍 의존(flaky)** 테스트입니다.

## 남은 이슈 · 후속 제안

- **기존 e2e 실패 17건**: 위 표의 스펙들은 이 기능과 별개로 깨져 있습니다. 대부분 Settings·Capabilities·Wiki·Works 탭 쪽 셀렉터나 기대값이 낡은 것으로 보입니다. 별도 카드로 정리하기를 권합니다.
- **flaky 단위 테스트**: `scheduled-dispatch-service.test.ts`의 race 테스트가 실제 시계에 의존합니다. 가짜 시계로 바꾸는 것을 제안합니다.
- **오래된 :24681 test-server**: 2026-10-19부터 떠 있어 백엔드가 낡았습니다(예: `/api/cards/completion-seen` 404). `reuseExistingServer: true`라서 그냥 `bun run test:e2e`를 돌리면 이 서버를 재사용합니다. 사용자가 직접 종료한 뒤 다시 돌리는 것을 권합니다(이번 작업에서는 종료하지 않음).
- **e2e 스펙 필터**: `bun run test:e2e -- <spec>`은 스펙을 거르지 못하고 전체를 돌립니다. 특정 스펙만 돌릴 때는 `bunx playwright test e2e/<file>`을 쓰세요.
- **컬럼 간 드래그**: 보드에 컬럼 간 상태 변경 DnD가 생기면 `resolveWorkDrop`의 `null`(다른 컬럼) 규칙과 함께 설계해야 합니다.
- **되돌리기 불가 케이스**: Work의 마지막 세션을 옮기면 서버가 원본 Work를 지우므로 되돌리기가 없습니다(경고 알림만). 필요하면 서버에서 빈 Work를 잠시 유지하는 방식을 검토할 수 있습니다.
- **FILTER 패널 높이**: 1000px 높이에서는 `WORK` 섹션이 패널 본문 스크롤 아래에 있습니다. WORKS 모드에서는 WORK 섹션을 위로 올리는 것을 검토할 수 있습니다.
- **스크린샷 용량**: `assets/works-on-board/` PNG 24장, 약 4.7MB입니다. 저장소 크기가 부담되면 커밋 전에 줄이거나 일부만 남기세요.
