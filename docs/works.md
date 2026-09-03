# Works & Timeline

## 개요

**Work**는 여러 에이전트 세션을 하나로 묶는 *사람 의도 단위*의 작업 엔티티입니다.

카드(`KanbanCard`)는 "한 번의 실행"이고 세션은 "한 번의 대화"지만, 사람이 실제로 인식하는 작업 단위는 그보다 큽니다. 예를 들어 "Works 탭 만들기"라는 하나의 일이 `개발 세션 → 리뷰 세션 → 버그 수정 세션` 3개로 나뉘어도, 사람에게는 여전히 하나의 작업입니다. Work는 그 묶음을 1급 객체로 만듭니다.

- **세션 : Work = N : 1** — 한 세션은 최대 하나의 Work에만 소속됩니다. 서버가 재연결(re-link)을 거부합니다.
- **Work는 절대 자동 생성되지 않습니다.** 새 세션은 Works 탭의 **Inbox**에 쌓이고, 사용자가 배정하거나 폐기할 때까지 남아 있습니다.
- **카드 모델은 건드리지 않습니다.** Work는 `sessionId`로만 조인하며, 저장소도 별도입니다(`~/.agent-kanban/works.json`).

관련 타입은 모두 `src/core/types.ts`의 `Work` / `WorkSessionLink` / `WorkInboxSession` / `WorksConfig` 입니다.

### 상태 전이

| 상태 | 의미 | 카드에 대한 부수효과 |
|------|------|----------------------|
| `active` | 진행 중. `resolvedAt`이 없습니다 → Timeline 바가 오늘까지 연장됩니다 | 없음 |
| `done` | 완료. `resolvedAt` 자동 기록 | 산하 모든 카드를 `done`으로 바꾸고 **일괄 archive** (→ wiki 파이프라인으로 넘어감) |
| `discarded` | 폐기. `resolvedAt` 자동 기록 | 없음. 카드는 보드에 남고, `WikiWorker`가 이 Work의 세션을 건너뜁니다 |

`resolution`은 `completed` / `superseded` / `abandoned` 중 하나로, 터미널 상태 전이 시 자동으로 채워집니다(`done` → `completed`, `discarded` → `abandoned`).

> 완료의 일괄 archive는 되돌릴 수 없는 동작입니다. `works.done_confirm`을 켜면 확인 프롬프트를 거칩니다 — 자세한 규칙은 아래 [설정 키](#설정-키-works) 참고.

## 화면

### ① Works 탭

세 섹션이 위에서 아래로 쌓입니다.

- **📥 Inbox — 미배정 세션**: 아직 Work에 속하지 않고 무시되지도 않은 세션. `배정` 버튼을 누르면 행 아래로 인라인 패널이 펼쳐지고, `새 Work 만들기`(제목은 첫 프롬프트에서 자동 제안) 또는 `기존 Work에 연결`(같은 `projectDir`의 active Work를 우선 추천) 중 하나를 고릅니다. 세션 역할(`개발`/`리뷰`/`디버그`)도 함께 지정합니다.
- **🔵 Active Works**: 진행 중인 Work 목록. `works.stale_days`(기본 5일)를 넘긴 Work에는 `⚠ N일째 미완료` 배지가 붙습니다.
- **✅ Resolved**: 최근 7일 내 완료/폐기된 Work.

Inbox에 세션이 남아 있으면 상단 탭의 **Works** 라벨 옆에 미배정 개수 배지가 표시됩니다. 이 배지는 Works 탭이 비활성일 때도 갱신됩니다(Inbox만 10초 주기로 상시 폴링).

### ② 모두 배정하기 모달

Inbox 헤더의 `⚡ 모두 배정하기`는 미배정 세션을 카드 스택처럼 하나씩(`n / N` 카운터) 훑는 키보드 우선 모달입니다.

| 키 | 동작 |
|----|------|
| `N` | 새 Work 만들기로 전환 (제목 입력칸이 열리며 자동 제안값이 채워짐) |
| `1`–`9` | 추천 Work 중 n번째 선택 (같은 `projectDir` 우선, 그다음 최근 활동순) |
| `S` | 건너뛰기 — 이 세션은 Inbox에 그대로 남습니다 |
| `X` | 폐기 — 세션을 무시 목록에 넣습니다 (Work 없이 보관) |
| `Enter` | 현재 선택으로 연결하고 다음 세션으로 |

배정 mutation은 인라인 패널과 **완전히 동일한 함수**(`useWorks`의 `createWorkFromSession` / `linkSessionToWork` / `ignoreSession`)를 씁니다. 두 경로가 갈라지지 않게 하려면 항상 훅 쪽을 고쳐야 합니다.

### ③ Work 상세 (DialogSkeleton)

제목·상태·기간, 연결된 세션 목록(역할별), LLM Summary, 완료/폐기 버튼. Timeline의 바를 클릭해도 같은 다이얼로그가 열립니다(모달은 App의 `openWorkId` 하나만 소유).

레이아웃은 **한 줄에 한 관심사씩 쌓는 세로 스택**입니다: `상태 배지 → Summary → 기간 → 산출물 → 연결된 세션 → 완료 안내 → 푸터`. 예전에는 오른쪽 열에 산출물/타임라인 패널이 따로 있어 왼쪽 세션 목록과 같은 정보가 두 번 나왔는데, 각 관심사가 full-width 한 행을 갖도록 정리했습니다. 새 정보를 넣을 때도 오른쪽 열을 되살리지 말고 행을 추가하세요.

`기간` 행의 **날짜 입력**이 Timeline 드래그와 짝을 이루는 두 번째 편집 경로입니다.

- `시작`은 항상 편집 가능합니다.
- `종료` 라벨은 `active`일 때 **`종료 예정`** 으로 바뀌고, 값이 있으면 `예정일 지우기` 버튼이 함께 나타납니다.
- 값을 고르면 즉시 저장합니다. 종료 < 시작이면 PATCH 없이 인라인 오류를 띄웁니다.
- 입력이 빈 값일 때: `active`의 종료 예정이면 **지우기**(`resolvedAt: null`), 그 외에는 타이핑 도중으로 보고 무시합니다.

두 경로 모두 `useWorks`의 **같은 `updateWorkDates`** 를 호출하니 한쪽만 고치지 마세요.

### ④ Works 설정

Works 탭 헤더의 `⚙ 설정` 토글. 아래 `works.*` 키를 편집합니다. wiki의 LLM 설정과는 완전히 독립입니다.

### ⑤ Timeline 탭

행 = Work, 열 = 날짜인 간트 형태 뷰. **주간**(월~일 7열)과 **월간**(그 달을 덮는 월~일 정수 주, 28~35열)을 토글합니다.

- 미완료(`active`) Work의 바는 **오늘 열까지 연장**되고 오른쪽 끝이 점선으로 열려 있습니다(`▸ 진행중`). 단 종료 예정일을 찍어두면 그 날에서 끝납니다(`▸ M/D 예정`).
- 완료/폐기된 Work의 바는 `startedAt → resolvedAt`에 고정됩니다.
- 조회 범위를 벗어난 시작/종료는 `◂ M/D부터` / 점선 오른쪽 보더로 표시됩니다.
- 행 정렬: 미완료(시작 오래된 순) → 완료·폐기(종료 최근 순).
- **미배정 세션은 타임라인에 나타나지 않습니다.** Work가 아니기 때문이며, 이것이 Inbox triage를 유도하는 장치입니다.

차트/캘린더 라이브러리를 쓰지 않고 단일 CSS grid로 그립니다. 날짜 기하 계산은 전부 `web/src/components/Works/timelineModel.ts`(순수 함수, 유닛 테스트 완비)에 있고, `TimelineView.tsx`는 렌더만 합니다. 새 기하 규칙은 `timelineModel.ts`에 추가하세요.

#### 바 끝 드래그로 날짜 조정

바에 마우스를 올리면 양 끝에 손잡이(`.tl-bar-handle`)가 나타납니다. 잡아끌면 미리보기가 열 단위로 따라오고(`8/31 → 9/3` 칩), 놓는 순간 그 날짜로 `PATCH /api/works/:id`를 보냅니다.

| 규칙 | 동작 |
|------|------|
| 왼쪽 손잡이 | `startedAt` 변경 |
| 오른쪽 손잡이 | `resolvedAt` 변경. **`active` Work에서도 동작합니다** → [종료 예정일](#종료-예정일-active-work의-resolvedat) |
| 바 뒤집기 | 불가능. `resizeBar()`가 반대편 끝으로 collapse시킵니다(하루짜리 바) |
| 키보드 | 손잡이에 포커스를 두고 `←` / `→` → 하루씩 이동 후 즉시 저장 |
| 열이 안 바뀐 드롭 | PATCH를 보내지 않습니다 (드래그 없는 클릭이 쓰기를 유발하지 않도록) |

날짜는 **일 단위**로만 바뀝니다. 다만 시:분:초 처리는 시작과 종료가 다릅니다.

| | 저장되는 시각 | 이유 |
|---|---|---|
| 시작 (`startedAt`) | 원본의 시:분:초 유지 (`isoForColumn`) | 첫 카드의 실제 시작 시각이라는 실체가 있음. 예: `8/31 14:20` → 9/3 열로 드래그 → `9/3 14:20` |
| 종료 (`resolvedAt`) | 그 날의 **끝** `23:59:59.999` (`endIsoForColumn`) | 사용자가 찍은 종료일은 "이 날까지 진행했다"는 뜻이고 이어받을 실제 시각이 없음(active Work엔 `resolvedAt` 자체가 없음). 게다가 `updatedAt` 같은 임의 시각을 빌리면 `시작 9/1 14:00` + `종료 9/1 09:00`처럼 하루짜리 바가 역전 instant가 되어 store에 거부됨 |

> 자동 stamp(진짜 완료 시각)는 이 규칙과 무관하게 그 순간을 그대로 기록합니다. 손으로 찍은 날짜에만 end-of-day가 적용됩니다.

바 자체는 `<button>`(클릭 → Work 상세)이라 손잡이를 자식으로 넣을 수 없습니다. 그래서 grid 배치는 래퍼인 `.tl-bar-slot`이 갖고, 바와 손잡이는 그 안에서 형제입니다 — e2e에서 열 좌표를 읽을 때는 `.tl-bar`가 아니라 `.tl-bar-slot`을 봐야 합니다.

드래그는 window 리스너가 아니라 손잡이의 **pointer capture**로 돕니다(`setPointerCapture` → `onPointerMove` / `onLostPointerCapture`). `pointerdown` 안에서 동기적으로 잡히기 때문에 "눌렀는데 아직 리스너가 안 붙은" 구간이 없고, 포인터가 12px 손잡이를 벗어나도 계속 추적됩니다. 종료 신호는 `lostpointercapture` **하나만** 씁니다 — `pointerup`도 같이 듣으면 같은 preview를 두 번 커밋합니다.

포인터 기하는 헤더 셀의 `data-tl-col` 속성에서 매 move마다 측정합니다(`measureColumns`). 월간 뷰의 가로 스크롤 중에도 열 계산이 어긋나지 않게 하기 위한 것이니, 헤더에서 이 속성을 지우지 마세요.

#### 종료 예정일 (active Work의 `resolvedAt`)

`active` Work도 `resolvedAt`을 가질 수 있습니다. 완료 처리 전에 "이 날쯤 끝난다"를 먼저 찍어두는 용도입니다.

- **없으면** 바가 오늘까지 이어지고 `▸ 진행중`이 붙습니다 (기존 동작).
- **있으면** 바가 그 날에서 끝나고 `▸ M/D 예정`이 붙습니다. 상태는 여전히 `active`이므로 오른쪽 끝은 점선으로 열려 있습니다.
- 예정일이 **과거**여도 바를 오늘까지 다시 늘리지 않습니다. 직접 조작한 위치가 곧 화면이어야 하기 때문입니다.
- **비우면** 다시 오늘까지 이어집니다 (`resolvedAt: null`). 상세 다이얼로그의 `예정일 지우기` 버튼, 또는 날짜 입력을 비우면 됩니다.
- 나중에 **완료 처리하면 이 날짜가 그대로 종료일이 됩니다** — `updateWork`의 자동 stamp는 `resolvedAt`이 비어 있을 때만 `now`를 찍기 때문입니다. 사용자가 "날짜부터 정하고 나중에 완료" 순서로 일할 수 있는 근거가 이 규칙입니다.
- 단, `status: 'active'`로 **되돌리면** `resolvedAt`은 지워집니다(기존 재오픈 규칙). 재개된 Work의 예정일은 다시 찍어야 합니다.

## API 레퍼런스 (`/api/works*`)

전체 규칙(에러 형식, CORS, 인증)은 [`api-reference.md`](./api-reference.md)와 동일합니다. `workStore`가 서버에 주입되지 않은 환경에서는 모든 엔드포인트가 `503 Works not available`을 반환합니다.

### `GET /api/works`

Work 목록을 `updatedAt` 내림차순으로 반환합니다.

쿼리:

- `status=active|done|discarded` (선택) — 잘못된 값은 `400`

### `POST /api/works`

Work를 생성합니다. 항상 `status: 'active'`로 시작합니다.

```json
{ "title": "Works 탭 구현", "projectDir": "/Users/me/workspace/agent-kanban", "startedAt": "2026-09-01T03:00:00.000Z" }
```

- `title` (required, 공백만이면 `400`)
- `projectDir` (선택)
- `startedAt` (선택, 기본값 = 생성 시각)

`201`로 생성된 `Work`를 반환합니다.

### `GET /api/works/:id`

단일 Work. 없으면 `404 Work not found`.

### `PATCH /api/works/:id`

`WorkPatchInput`을 받습니다: `title`, `status`, `resolution`, `projectDir`, `startedAt`, `resolvedAt`, `summary`, `archivedAt`, 그리고 라우트 전용 플래그 `confirmArchive`.

- `status: 'done'`은 **산하 카드 일괄 done → archive** 부수효과를 함께 실행합니다. 카드 전이는 `store.updateCard`(순수 store 쓰기)를 쓰기 때문에 큐 자동 dispatch를 트리거하지 않습니다 — 작업을 닫는 행위가 새 에이전트 실행을 시작해서는 안 되기 때문입니다.
- `works.done_confirm`이 켜져 있으면 `confirmArchive: true`가 함께 오지 않는 한 상태 전이만 기록하고 sweep은 보류합니다.
- 반복된 `done` PATCH는 `archivedAt`이 이미 찍혀 있으면 재sweep하지 않습니다(idempotent).
- `status: 'active'`로 되돌리면 `resolvedAt` / `resolution`이 지워집니다.
- `startedAt` / `resolvedAt`만 담긴 **날짜 전용 PATCH**(바 끝 드래그, 상세 다이얼로그의 날짜 입력)는 상태를 건드리지 않으므로 완료 부수효과가 전혀 걸리지 않습니다. `active` Work에 `resolvedAt`을 넣는 것도 이 경로이며(종료 예정일), `resolvedAt: null`이 그것을 지웁니다. 파싱 불가능한 값은 `400`이고, 결과가 `resolvedAt < startedAt`이 되는 편집도 `400`입니다 — 단, 호출자가 날짜를 명시한 경우에만 검사하므로 이미 뒤집혀 저장된 레코드도 다시 고칠 수 있습니다.

### `DELETE /api/works/:id`

`204`. Work만 삭제되며 카드는 그대로입니다. 연결돼 있던 세션은 다시 Inbox로 돌아옵니다.

### `GET /api/works/inbox`

미배정·비무시 세션(`WorkInboxSession[]`)을 최근 활동순으로 반환합니다. `GET /api/sessions`와 동일한 세션 집계(`computeSessionAggregates`)를 공유하므로, 필드를 추가할 땐 라우트가 아니라 그 헬퍼를 고쳐야 합니다.

### `POST /api/works/:id/sessions`

세션을 Work에 연결합니다.

```json
{ "sessionId": "claude-abc123", "projectDir": "/Users/me/workspace/agent-kanban", "role": "review" }
```

- `sessionId` (required) — 이미 다른 Work에 붙어 있으면 `409`
- `role` — `dev` | `review` | `debug` (선택)
- Work의 **첫 연결**일 때는 그 세션의 가장 이른 카드 `startedAt`으로 Work의 `startedAt`을 back-date합니다(archive된 카드도 포함). Timeline 바가 "triage한 날"이 아니라 "실제로 시작한 날"부터 그려지게 하기 위한 처리입니다.

### `DELETE /api/works/:id/sessions/:sessionId`

연결을 끊습니다. 해당 세션은 다시 Inbox에 나타납니다.

### `POST /api/works/ignore-session`

세션을 Inbox에서 영구히 감춥니다(`{ "sessionId": "..." }` → `{ "ignoredSessionIds": [...] }`). 새로고침 후에도 유지됩니다.

### `POST /api/works/:id/summary`

연결된 모든 세션의 트랜스크립트를 모아 `works.summary_model` LLM으로 3~5줄 한국어 Summary를 생성하고 Work에 저장합니다. 완료된 Work의 카드는 이미 archive됐을 수 있으므로 archive된 카드까지 조회합니다.

응답은 `WorkSummaryResponse`(`work`, `summary`, `generatedSessions`, `skippedSessions`)입니다. 트랜스크립트를 하나도 못 읽으면 `422`.

### `GET` / `POST /api/works/config`

Works 설정 조회/저장. `GET`은 `WorksConfigDto`(설정값 + `configured` + 파생된 `route`)를 반환합니다. `POST`는 `WorksConfigInput`의 제공된 필드만 저장하며, 검증 실패는 `400`입니다(`summaryLines`는 3·4·5만, `staleDays`는 1 이상의 숫자, boolean 키는 boolean만).

> 라우트 순서 주의: `/api/works/config`는 `/api/works/:id` catch-all보다 **앞에** 있어야 합니다. 그렇지 않으면 `id`가 `"config"`로 잡힙니다.

## 설정 키 (`works.*`)

공유 settings store에 저장됩니다. 정의는 `src/plugin/works/works-config.ts`.

| 키 | 기본값 | 의미 |
|----|--------|------|
| `works.summary_model` | `DEFAULT_CLAUDE_MODEL` | Summary 생성 모델. `gpt-*` 접두사면 codex 경로, 그 외는 claude 경로로 라우팅 |
| `works.summary_lines` | `4` | Summary 줄 수 (`3` \| `4` \| `5`) |
| `works.assign_prefer_same_dir` | `true` | 배정 추천에서 같은 `projectDir`의 Work를 우선 |
| `works.assign_suggest_resume_chain` | `true` | 이어붙인 세션 체인을 추천에 반영 |
| `works.stale_days` | `5` | active Work에 `⚠ 미완료` 경고를 붙이는 경과일 임계값 |
| `works.done_confirm` | `false` | 완료 시 일괄 archive 전에 확인 프롬프트 |

`works.*`는 wiki의 LLM 설정(`wiki.*`)과 완전히 분리되어 있습니다. Summary 모델을 바꿔도 wiki 파이프라인에는 영향이 없습니다.

## 데이터 저장

`~/.agent-kanban/works.json` (`WorkStoreState`). 다른 도메인 store와 같은 규약을 따릅니다 — temp 파일 rename 기반 atomic write + in-process mutex와 `FileLock`의 이중 락. `ignoredSessionIds`도 같은 파일에 함께 저장됩니다.

## 코드 위치

| 관심사 | 파일 |
|--------|------|
| 공유 타입 | `src/core/types.ts` (Works & Timeline 섹션) |
| 영속화 | `src/core/work-store.ts` |
| 완료 라이프사이클 / 일괄 archive | `src/plugin/works/work-lifecycle.ts` |
| 설정 키 로드/저장 | `src/plugin/works/works-config.ts` |
| Summary 생성 | `src/plugin/works/works-summary.ts` |
| REST 라우트 | `src/server/routes.ts` (Works Routes 섹션) |
| 데이터 흐름 (웹) | `web/src/hooks/useWorks.ts`, `web/src/hooks/useWorksApi.ts` |
| UI | `web/src/components/Works/` |
| Timeline 기하 (순수) | `web/src/components/Works/timelineModel.ts` |
| 유닛 테스트 | `src/__tests__/work-store.test.ts`, `work-lifecycle.test.ts`, `works-config.test.ts`, `web/src/components/Works/timelineModel.test.ts` |
| e2e | `e2e/works.e2e.ts` |

## 관련 문서

- [`api-reference.md`](./api-reference.md) — 전체 REST 레퍼런스
- [`kanban-board.md`](./kanban-board.md) — 카드 라이프사이클 (Work가 묶는 대상)
- [`design-system.md`](./design-system.md) — UI 작업 전 필수
