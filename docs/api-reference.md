# API 레퍼런스

## 개요

서버는 `Bun.serve()` 기반이며 실패 응답은 `{ "error": string }` 형식을 사용합니다.

기본 URL은 `http://localhost:24680`이며, 포트 충돌 시 다음 포트를 순차적으로 시도할 수 있습니다.

## 공통 규칙

- Content-Type: `application/json` (스크린샷 업로드 제외)
- 브라우저 보안: wildcard CORS는 사용하지 않는다. same-origin 요청만 허용한다.
- 수정 계열 카드/스케줄러/설정/스크립트 업데이트는 `PATCH`
- 삭제 성공 응답은 보통 `204 No Content`

## 카드 / 보드 API

### `GET /api/board`

전체 보드 상태를 반환합니다.

### `GET /api/cards`

카드 목록을 반환합니다.

쿼리:

- `status=todo|in_progress|complete|done`
- `include_archived=true` — 월별 archive 파일까지 함께 스캔합니다
- `session_id=<sessionId>` — 한 세션의 카드만 남깁니다. `include_archived=true`와 함께 쓰면
  이미 archive된 세션(완료된 Work의 세션, 보드보다 오래된 Timeline 레일)의 대화를 열 수 있습니다

### `POST /api/cards`

카드를 생성합니다.

주요 필드:

- `title` (required)
- `description` (required)
- `projectDir`
- `model`
- `agentRuntime` (`opencode` | `codex` | `claude`, optional; 없으면 `opencode`)
- `codexOptions` (`reasoningEffort`, `sandbox`, `skipGitRepoCheck`)
- `agentType`
- `feedbackForCardId`
- `queueSessionMode`
- `resumeSessionId`
- `telegramChatId`

### `GET /api/cards/:id`

단일 카드를 반환합니다. 기본은 **라이브 보드만** 조회하므로 archive된 카드는 `404`입니다.

쿼리:

- `include_archived=true` — 보드에 없으면 월별 archive 파일을 최신 월부터 훑어 첫 번째로 찾은
  카드를 반환합니다. 완료된 Work의 카드는 정의상 보드에 없으므로, Timeline 날짜 칸이나 Works
  Inbox의 `대화 보기` 같은 딥링크는 이 플래그를 씁니다. 어디에도 없으면 그대로 `404`이고,
  `store.loadArchives()`(전체 스캔)는 쓰지 않습니다.

### `PATCH /api/cards/:id`

카드를 수정합니다.

자주 쓰는 필드:

- `status`
- `title`
- `description`
- `model`
- `agentRuntime`
- `codexOptions`
- `progressSummary`
- `result`
- `sessionId`
- `queuedAfterCardId`
- `queuePosition`
- `queueSessionMode`
- `resolution` (`completed` | `superseded` | `failed`; `failed`는 terminal Script 실행 실패)
- `supersededByCardId`
- `supersededAt`

`description`, `progressSummary`, `result` 문자열은 애플리케이션에서 길이를 제한하거나 잘라 저장하지 않습니다.
`GET /api/cards/:id/progress`도 전체 단계와 tool detail/body를 반환합니다. UI의 접힌 상태는 일부만
보여줄 수 있지만 펼치면 서버가 반환한 전체 내용을 표시합니다.

### `DELETE /api/cards/:id`

카드를 active view에서 숨기고 `deletedAt`을 기록합니다. 응답은 `204 No Content`입니다.

### `GET /api/cards/deleted`

soft-delete된 카드 목록을 반환합니다.

### `POST /api/cards/:id/restore`

soft-delete된 카드의 `deletedAt`을 제거하고 active view로 복구합니다.

### `POST /api/cards/:id/dispatch`

`todo` 카드만 디스패치합니다. 성공 시 `{ sessionId, runId, startedAt }`를 반환합니다. feedback card는 원본 세션을 우선 재사용하고, queued card는 `queueSessionMode=continue_queued_after_session`일 때 queued-after 카드 세션 재사용을 시도한 뒤 필요하면 새 세션으로 fallback합니다.

응답 예시:

```json
{
  "sessionId": "thread-or-session-id",
  "runId": "codex-1779800000000-AbCdEf12",
  "startedAt": "2026-05-26T12:00:00.000Z"
}
```

`sessionId`는 runtime별 actual continuation id입니다. `opencode`는 opencode session id, `codex`는 `thread_id`, `claude`는 `session_id`를 의미합니다. Codex/Claude는 actual id를 확보하기 전까지 임시 `sessionId`를 저장하거나 반환하지 않습니다.

Codex `thread_id` timeout 또는 Claude `session_id` timeout은 실패 응답을 반환합니다. 이때 card는 `todo`로 돌아가고 `progressSummary`에는 `[failed] ...` 요약이 남습니다.

예약된 카드(`scheduledDispatch.status='scheduled'`)에 이 엔드포인트를 호출하면 같은 예약 claim wrapper를 사용해 **Start Now**가 된다. background due scan과 경합해도 dispatch는 한 번만 허용된다.

## Quick Actions API

### `GET /api/quick-actions`

저장된 Quick Action 목록을 pinned/order 순으로 반환합니다. `pinned=true`는 비고정 action보다 먼저 표시하라는 정렬 표시이고, `enabled=false`는 action을 삭제하지 않은 채 실행만 막습니다. 각 항목은 단일 emoji grapheme `icon`을 가지며 `available`, `unavailableReason`, `effectiveProjectDir`가 포함될 수 있습니다. Script action에는 현재 연결된 `scriptName`이 함께 반환됩니다. `available=false`인 action과 icon 없는 legacy action도 관리·복구할 수 있도록 목록에서 제거하지 않습니다.

### `POST /api/quick-actions`

Prompt 또는 Script Quick Action을 생성합니다. Prompt action은 `cardTitleTemplate`, `promptTemplate`, `projectDir`, `agentRuntime`이 필수이며 일반 카드와 같은 `model`, `agentType`, `command`, `argumentsTemplate`, `codexOptions`, `claudeOptions`를 저장할 수 있습니다. `argumentsTemplate`은 `command`가 있을 때만 허용되며 실행 파라미터로 렌더링됩니다.

Prompt의 `projectDir`는 빈 값일 수 없고 실행 시 실제 absolute directory여야 합니다. Script의 `projectDir`는 선택 사항이며 없으면 연결된 script의 directory, 그마저 없으면 프로세스 cwd를 사용합니다. parameter key는 `[A-Za-z_][A-Za-z0-9_]*` 형식이고 type은 `string`, `number`, `boolean`, `select`, `secret` 중 하나입니다. `secret`에는 default를 저장할 수 없고 `select`에는 중복 없는 options가 필요합니다.

`icon`은 선택 입력입니다. 생략하면 shared 기본 팔레트에서 미사용 icon을 원자적으로 배정합니다. custom 값은 표시 가능한 emoji 한 grapheme이어야 하고 전체 action에서 중복될 수 없습니다. 중복 또는 기본 팔레트 소진은 `409`, 잘못된 grapheme은 `400`입니다.

### `GET/PATCH/DELETE /api/quick-actions/:id`

단일 action을 조회·수정·삭제합니다. `PATCH`에서 `icon`을 바꾸면 생성과 같은 emoji grapheme·전체 고유성 검증을 적용합니다. 참조 중인 ScriptEntry를 직접 삭제하면 `409`를 반환하지만 외부 directory sync로 script가 사라진 action은 삭제하지 않고 `available=false`로 반환합니다. 저장 파일에 `icon`이 없는 legacy entry도 조회에서 버리지 않고 정렬 순서에 따른 결정적 fallback icon을 반환합니다.

### `POST /api/quick-actions/:id/run`

Prompt Quick Action은 카드를 만든 뒤 기존 agent dispatch 경로로 실행합니다. Script Quick Action은 같은 요청 schema를 검증한 뒤 일반 script card와 `ScriptRun`을 먼저 저장하고 비동기 실행합니다.

`enabled=false`인 action의 실행 요청은 `409 Quick action is disabled`로 거부됩니다. `pinned`는 목록 정렬에만 영향을 주며 실행 권한이나 동작을 바꾸지 않습니다.

요청:

```json
{
  "clientRequestId": "stable-id-for-this-click-and-retries",
  "parameterValues": {
    "days": 3,
    "scope": "all"
  }
}
```

parameter는 저장된 `parameterDefinitions`의 required/type/select/unknown-key 규칙으로 검증합니다. template은 정확한 `{{parameterKey}}` placeholder만 지원하며, 값이 없거나 형식이 잘못된 placeholder가 남으면 실행하지 않습니다. 저장된 `projectDir`가 실제 directory가 아니거나 action이 disabled/unavailable여도 실행하지 않습니다.

required `string`/`secret`은 공백만 있는 값을 허용하지 않습니다. 서로 다른 parameter key가 환경변수 정규화 후 같은 이름이 되는 경우(예: `fooBar`, `foo_bar` → `AK_PARAM_FOO_BAR`) action 등록을 거부합니다.

Script parameter는 명령 문자열에 렌더링하지 않고 `AK_PARAM_<UPPER_SNAKE_KEY>` 환경변수로만 전달합니다. camelCase 경계는 `_`로 바뀌며 영숫자가 아닌 문자는 `_`로 정규화됩니다. Settings entry 중 유효한 env key는 script environment에 전달하지만 system/interpreter/internal reserved key와 `AK_PARAM_*` key는 무시합니다. secret parameter와 masked Settings 값은 card/run/history/stdout/stderr/error에서 `[REDACTED]` 처리되며 `parameterSnapshot`에도 secret은 포함되지 않습니다. stored language는 고정 interpreter argv allowlist로만 해석하고 요청에서 interpreter를 받지 않습니다.

성공 응답:

```json
{
  "cardId": "card-id",
  "status": "in_progress",
  "dispatch": {
    "sessionId": "thread-or-session-id",
    "runId": "runtime-run-id",
    "startedAt": "2026-08-16T00:00:00.000Z"
  }
}
```

`quickActionId + clientRequestId`가 idempotency key입니다. 같은 요청을 동시에 보내거나 재시도해도 새 카드/dispatch를 만들지 않고 동일한 저장 결과를 반환합니다. dispatch 접수 실패 시에도 응답에는 `cardId`, `status: "todo"`, `dispatch: null`, `failureSummary`, `error`가 포함되고 카드는 삭제되지 않습니다.

Script 접수 응답은 `202 Accepted`입니다.

```json
{
  "cardId": "card-id",
  "runId": "script-run-id",
  "status": "in_progress",
  "runStatus": "running",
  "dispatch": null
}
```

이후 `GET /api/cards/:cardId`와 script history를 polling합니다. exit code 0이면 card는 `complete`/`resolution=completed`, spawn 또는 nonzero exit이면 `complete`/`resolution=failed`가 됩니다. 실패는 다음 queue card를 자동 실행하지 않습니다.

Quick Action 실행 카드는 `originChannel=quick_action`, `quickActionId`, `executionKind`를 기록합니다. Script 실행 카드는 실행 당시의 `scriptName`, `scriptRunId`, secret을 제외한 `parameterSnapshot`도 기록하므로, 원본 script 이름이 바뀌거나 사라져도 Card Detail에서 실행 대상을 확인할 수 있습니다.

변경 및 실행 endpoint는 서버가 발급한 loopback 로컬 토큰을 요구합니다. 읽기 endpoint는 non-secret read 정책을 유지하며 wildcard CORS는 허용하지 않습니다.

### `PUT /api/cards/:id/schedule`

top-level `todo` 카드를 **KST 기준 미래 시각**에 한 번만 자동 dispatch하도록 예약한다.

요청:

```json
{ "scheduledAt": "2026-07-18T09:35" }
```

응답 예시:

```json
{
  "id": "card_123",
  "status": "todo",
  "scheduledDispatch": {
    "scheduledAt": "2026-07-18T00:35:00.000Z",
    "status": "scheduled",
    "updatedAt": "2026-07-17T12:00:00.000Z"
  }
}
```

규칙:

- 입력은 KST 로컬 datetime 문자열이어야 한다.
- 현재(`Friday, July 17, 2026`)보다 미래여야 한다.
- child 카드, `in_progress` 카드, queued 카드는 거부된다.

### `DELETE /api/cards/:id/schedule`

카드의 1회 예약을 취소한다. `scheduledDispatch` 필드가 제거된다.

### `GET /api/cards/:id/queue`

해당 카드 뒤에 연결된 queued 카드 목록을 반환합니다.

### `POST /api/archive`

`done` 카드들을 월별 archive 파일로 이동합니다. 아카이브된 top-level 카드에는 `wiki.status = 'pending'`이 기록되어 LLM Wiki 처리 큐에 들어갑니다. `parentCardId`가 있는 child 카드는 archive에는 남지만 Wiki 처리 대상에서는 제외됩니다.

요청 본문:

```json
{ "cardIds": ["optional-card-id"] }
```

## Works API

여러 세션을 하나로 묶는 작업 단위(`Work`) API입니다. 세션 : Work = N : 1이며, Work는 자동 생성되지 않고 Inbox triage를 통해서만 만들어집니다. 도메인 전체 설명은 [`./works.md`](./works.md)를 참고하세요.

서버에 `workStore`가 주입되지 않은 환경에서는 아래 모든 엔드포인트가 `503 Works not available`을 반환합니다.

### `GET /api/works`

Work 목록을 반환합니다. 기본 순서는 `updatedAt` 내림차순입니다.

| 쿼리 | 설명 |
|------|------|
| `status=active\|done\|discarded` | 잘못된 값은 `400 Invalid status` |
| `projectDir=<절대경로>` | **정확 일치**입니다(접두/접미 일치가 아님) |
| `q=<문자열>` | 제목 · `projectDir` · `notes` · `summary.lines`를 대소문자 무시 부분 일치. 공백만이면 필터로 취급하지 않습니다 |
| `sort=updated\|stale\|planned` | 기본 `updated`. 잘못된 값은 `400 Invalid sort` — 조용히 기본 순서로 돌아가지 않습니다 |

| `sort` | 순서 |
|--------|------|
| `updated` | `updatedAt` 내림차순 (최근 활동 먼저) |
| `stale` | `updatedAt` 오름차순 (가장 오래 방치된 것 먼저) |
| `planned` | `resolvedAt` 오름차순, **예정일 없는 Work는 전부 뒤로**(그 안에서는 `updated` 순). 예정일 없음을 "가장 급함"으로 정렬하면 목록이 뒤집힙니다 |

모든 비교자는 `id` 비교로 끝나 **전순서**입니다 — 타임스탬프가 같은 두 Work가 요청마다 자리를 바꾸지 않습니다. 파싱 불가능한 날짜는 던지지 않고 뒤로 가라앉습니다.

규칙은 순수 함수 `selectWorks()`(`src/core/work-list.ts`) 하나이고 **웹 Active 목록이 같은 함수를 씁니다**. 웹은 요청을 좁히지 않습니다 — Timeline 그룹핑·배정 추천·이동 다이얼로그가 모든 Work를 필요로 하므로 목록 전체를 폴링하고, 좁히기는 클라이언트에서 같은 함수로 합니다([`works.md`](./works.md#active-목록의-검색--필터--정렬)).

### `POST /api/works`

Work를 생성합니다. 항상 `status: 'active'`로 시작합니다.

필드:

- `title` (required, 문자열이 아니거나 공백만이면 `400`)
- `projectDir` (문자열이 아니면 `400`)
- `startedAt` (기본값: 생성 시각). 파싱 불가능하면 `400`이고, 저장 시 **UTC `Z`로 정규화**됩니다

### `GET /api/works/:id`

단일 Work를 반환합니다.

### `PATCH /api/works/:id`

`WorkPatchInput`을 받습니다: `title`, `status`, `resolution`, `projectDir`, `startedAt`, `resolvedAt`, `summary`, `notes`, `confirmArchive`.

모든 필드는 store에 닿기 전에 타입 검증을 거칩니다.

| 필드 | 규칙 | 위반 시 |
|------|------|---------|
| `title` | 문자열 | `400 title must be a string` |
| `projectDir` | 문자열 또는 `null` | `400 projectDir must be a string or null` |
| `summary` | `{ lines: string[], generatedAt: string, model: string }` 또는 `null` | `400` |
| `status` / `resolution` | enum. **클라이언트가 쓸 수 있는 `resolution`은 `completed` \| `abandoned` 둘뿐입니다** | `400 Invalid status` / `400 Invalid resolution` |
| `notes` | 문자열 또는 `null`, 최대 `WORK_NOTES_MAX_LENGTH = 4000`자 | `400 notes must be a string or null` / `400 notes must be at most 4000 characters` |
| `startedAt` / `resolvedAt` | 파싱 가능한 ISO 8601 (`resolvedAt`은 `null` 허용) | `400 Invalid startedAt` / `400 Invalid resolvedAt` |
| `archivedAt` · `wikiDocPath` · `supersededByWorkId` | **서버 소유 — 받지 않습니다** | `400 archivedAt is set by the server and cannot be patched` |

- 검증이 없던 시절 `{"title": 7}`은 `400 .trim is not a function`으로 돌아왔습니다 — 내부 스택 조각이 사용자 문구였습니다.
- **`archivedAt`은 클라이언트가 쓸 수 없습니다.** 이 값은 sweep의 idempotence와 세션 이동 게이트를 동시에 결정하므로, 임의 문자열이 들어가면 두 경로가 되돌릴 UI 없이 영구히 막혔습니다. 스탬프는 `WorkStore.claimArchiveSweep()`만 찍습니다. `wikiDocPath`도 같은 이유로 `WikiWorker` 전용입니다.
- **`notes`는 Work의 유일한 사람 소유 필드입니다.** `summary`는 `POST /api/works/:id/summary`가 통째로 덮어쓰므로 사람이 적은 문장을 담을 수 없습니다. `''`와 `null`은 같은 뜻(= 메모 없음)이며 저장된 빈 문자열을 남기지 않습니다. 상태를 건드리지 않으므로 종료된 Work에도 쓸 수 있습니다. 길이 위반은 `400`이고 **아무것도 저장하지 않습니다.**
- **`supersededByWorkId`와 `resolution: 'superseded'`는 `POST /api/works/:id/merge`만 씁니다.** 둘은 짝일 때만 의미가 있어서(= "세션이 어디로 갔는지"), 클라이언트가 한쪽만 써 넣으면 아무 곳도 가리키지 않는 `병합됨` Work가 됩니다.
- 날짜는 **`new Date(v).toISOString()`으로 정규화해 저장**합니다. `2026-09-01T09:00:00+09:00`은 같은 순간인 `...T00:00:00.000Z`보다 문자열로는 *뒤에* 정렬되므로, 정규화하지 않으면 `startedAt` clamp가 필요 없는 clamp를 실행합니다.

`title` / `projectDir`만 담은 patch는 상태 전이가 아니므로 완료 부수효과(일괄 archive, `resolvedAt` 자동 스탬프)와 무관합니다 — 종료된 Work도 이름을 고칠 수 있습니다. Work 상세 다이얼로그의 `기본 정보` 인라인 편집이 이 경로를 씁니다(`useWorks.updateWorkMeta`).

응답은 `WorkPatchResponse` = 갱신된 `Work` + 이번 patch가 sweep을 실행(또는 의도적으로 생략)했을 때의 `sweep` 리포트입니다. `Work`에 `sweep` 필드가 없으므로 기존 클라이언트에는 순수 추가입니다.

```json
{ "id": "AbC123", "status": "done", "archivedAt": "...",
  "sweep": { "archivedCount": 4, "archiveMonth": "2026-09", "failed": [] } }
```

| `sweep` 필드 | 설명 |
|--------------|------|
| `archivedCount` / `archiveMonth` | `store.archiveCards()`의 결과 |
| `skipped` | sweep을 실행하지 않은 이유 — `not-a-completion` \| `already-archived` \| `awaiting-confirmation` \| `no-cards` \| `favorites-only` |
| `failed[]` | `{ cardId, message }`. sweep은 카드마다 독립적인 store 쓰기이므로 **부분 성공이 정상 결과**입니다. 예: 읽기와 쓰기 사이에 카드가 삭제되면 그 카드만 실패하고 나머지는 archive됩니다 |
| `keptFavoriteCardIds[]` | 즐겨찾기(`favorite`)라서 보드에 남긴 최상위 카드. 없으면 필드 자체가 생략됩니다 |

- `status: 'done'`은 산하 모든 세션의 카드를 `done`으로 바꾼 뒤 일괄 archive합니다(→ Wiki 처리 큐로 넘어감). 카드 전이는 순수 store 쓰기이므로 큐 자동 dispatch를 트리거하지 않습니다.
- **산하 카드 중 하나라도 실행 중인 에이전트(`RuntimeRun`이 `starting`/`running`)를 갖고 있으면 `409`로 거부합니다.** 응답 본문은 `{ error, runningCardIds }`이며 상태 전이도 기록되지 않습니다 — 실행 중인 카드를 archive하면 그 카드의 완료 훅이 `Card not found`로 실패하고 wiki가 미완성 트랜스크립트로 문서를 만듭니다. 미리 확인하려면 [`GET /api/works/:id/completion-preview`](#get-apiworksidcompletion-preview)를 씁니다.
- `works.done_confirm`(**기본값 `true`**)이 켜져 있으면 `confirmArchive: true` 없이는 상태만 기록하고 archive는 보류합니다(`skipped: 'awaiting-confirmation'`). 그 상태로 남은 Work(= `status: 'done'`인데 `archivedAt`이 없음)는 **`status` 없이 `{ "confirmArchive": true }`만 보내도** sweep을 끝낼 수 있습니다. 설정을 읽을 수 없는 환경에서도 기본값은 `true`입니다 — 읽기 실패가 파괴적 경로를 열어서는 안 되기 때문입니다.
- `archivedAt`이 이미 있으면 재sweep하지 않습니다(idempotent). 판정과 스탬프는 `WorkStore.claimArchiveSweep()` **하나의 락 구간**에서 일어나므로 동시 `done` PATCH 두 건도 archive를 한 번만 실행합니다(진 쪽은 `skipped: 'already-archived'`).
- sweep이 **한 장도** archive하지 못하면 `archivedAt`을 되돌려 Work를 재시도 가능한 상태로 남깁니다 — 일어나지 않은 archive를 광고하지 않습니다.
- **즐겨찾기 카드는 archive하지 않습니다.** `favorite`은 "이 카드를 보드에 고정한다"는 뜻이고 `store.archiveCards()`는 cascade 대상 자식에 대해 이미 그것을 지킵니다 — Work sweep만이 자기 seed를 직접 넘겨 그 표시를 지나쳤습니다. 해당 카드는 `done` 전환도 하지 않고(다음 일반 archive에 쓸려가지 않도록) `sweep.keptFavoriteCardIds`로 보고됩니다. 보드에 남은 카드가 **전부** 즐겨찾기면 `skipped: 'favorites-only'`이고 `archivedAt`을 찍지 않으므로 나중에 다시 완료할 수 있습니다.
- `status: 'discarded'`는 카드를 건드리지 않습니다. `WikiWorker`는 이 Work의 **그룹핑만 해제**하고(세션이 `workIndex`에서 빠짐) 카드는 세션 단위로 **일반 wiki 흐름을 그대로** 탑니다 — 폐기는 Work 상태이지 카드의 wiki 상태가 아닙니다.
- `startedAt` / `resolvedAt`만 담긴 날짜 전용 PATCH는 상태를 바꾸지 않으므로 완료 부수효과가 전혀 걸리지 않습니다. Timeline의 바 끝 드래그와 Work 상세의 날짜 입력이 이 경로를 씁니다.
- `active` Work에도 `resolvedAt`을 넣을 수 있습니다(종료 예정일). 이후 `status: 'done'` PATCH는 그 값을 유지하며, `resolvedAt: null`로 지우면 Timeline 바가 다시 오늘까지 이어집니다.
- 파싱 불가능한 날짜는 `400 Invalid startedAt` / `400 Invalid resolvedAt`, 결과가 `resolvedAt < startedAt`이 되는 편집은 `400`입니다(기존에 뒤집혀 저장된 레코드는 다시 정상 범위로 고칠 수 있도록, 호출자가 날짜를 건드린 경우에만 검사합니다).

### `POST /api/works/:id/reopen`

`done` / `discarded` Work를 `active`로 되돌리고, 완료 sweep이 일괄 archive한 카드를 보드로 복원합니다. 본문 없음.

```json
{ "work": { "id": "AbC123", "status": "active" },
  "restoredCardIds": ["c1", "c2"], "scannedMonths": ["2026-08", "2026-09"] }
```

완료는 **일방통행이었습니다.** `PATCH`는 `status: 'active'`를 받아줬지만 archive된 카드는 돌아오지 않았고 `archivedAt`이 계속 찍힌 채였습니다 — 그래서 sweep 멱등 가드와 세션 이동 게이트가 영구히 닫혔고, 유일한 탈출구는 레코드를 버리는 `DELETE`였습니다.

- 이미 `active`면 `409 Work is already active: "<제목>"`이고 아무것도 쓰지 않습니다. Work가 없으면 `404 Work not found`.
- **카드 복원이 상태 쓰기보다 먼저입니다.** 반대로 하면 복원 실패가 "카드는 archive에 있는데 `active`인 Work"를 남기고, 다음 완료가 `skipped: 'no-cards'`를 보고합니다.
- `status: 'active'`, `archivedAt` / `resolvedAt` / `resolution` / `supersededByWorkId` 제거. Summary·메모·`wikiDocPath`·세션 링크는 그대로입니다.
- 복원된 카드는 **`done`으로 돌아옵니다.** sweep이 전부 `done`으로 바꿨고 직전 status를 어디에도 기록하지 않으므로 복구할 정보가 없습니다. 보드의 done 칼럼에 놓이고 다음 `POST /api/archive`에 다른 done 카드와 똑같이 쓸려갑니다.
- **subagent 서브트리가 함께 돌아옵니다** — `store.archiveCards()`가 `parentCardId` cascade로 가져가므로 복원도 같은 cascade를 밟습니다. 자식만 archive에 남으면 보드가 그릴 수 없는 분리 상태입니다.
- **큐 자동 dispatch를 트리거하지 않습니다.** 카드 복원은 순수 store 쓰기(`unarchiveCards`)입니다 — 작업을 다시 여는 행위가 에이전트 실행을 시작해서는 안 됩니다.
- `wiki` 상태: `pending` 스탬프는 **지웁니다**(보드로 나온 카드는 worker가 볼 수 없고, 남겨두면 다시 archive해도 큐에 안 들어갑니다). `kept`/`skipped`/`failed`는 **그대로 둡니다**(같은 문서를 두 번 쓰지 않도록).
- `discarded` Work도 재개할 수 있습니다. 폐기는 archive를 하지 않으므로 `restoredCardIds`가 빈 배열입니다.
- `scannedMonths`는 실제로 파싱한 archive 월 파일입니다(`workCardScanFloor(work)` + `timelineArchiveMonths`). 전체 archive 스캔을 하지 않습니다.

### `POST /api/works/:id/merge`

이 Work의 세션을 다른 Work로 옮기고, 이 Work를 `병합됨`으로 닫습니다.

```json
{ "intoWorkId": "XyZ789" }
```

```json
{ "from": { "id": "AbC123", "status": "discarded",
            "resolution": "superseded", "supersededByWorkId": "XyZ789", "sessionLinks": [] },
  "to": { "id": "XyZ789", "sessionLinks": [ /* 합쳐진 링크 */ ], "startedAt": "..." },
  "movedSessionIds": ["ses-1"], "skippedSessionIds": ["ses-2"] }
```

이전에는 두 Work를 합치는 유일한 방법이 세션을 하나씩 옮겨 원본을 비우는 것이었고, 비워진 Work는 `PATCH /api/works/sessions/:sessionId`가 *삭제*하므로 Summary·메모·Timeline 이력이 되돌리기 없이 함께 사라졌습니다.

- `intoWorkId`가 없거나 문자열이 아니면 `400 intoWorkId is required`, 자기 자신이면 `400 Cannot merge a work into itself`, 대상이 없으면 `404 Work not found`.
- 양쪽 중 **하나라도 `archivedAt`이 찍혔거나 완료 중이면 `409`** 입니다 — 세션 이동과 같은 게이트를 씁니다.
- 링크는 `linkedAt`과 `role`을 그대로 갖고 이동합니다. **대상이 이미 갖고 있는 세션은 건너뜁니다**(`skippedSessionIds`) — 살아남는 쪽의 링크와 역할을 조용히 덮어쓰지 않습니다. 세션 : Work = N : 1 불변식이 유지됩니다.
- 대상의 `startedAt`은 **하나의 락 구간 안에서** 병합 후 링크 집합으로 재계산합니다(`WorkStartedAtResolver`). 다른 링크 변경 경로와 같은 계약이므로 TOCTOU가 없습니다.
- **원본은 삭제되지 않습니다.** `status: 'discarded'` + `resolution: 'superseded'` + `supersededByWorkId`이고, `resolvedAt`이 없으면 그때 찍습니다. 목록이 "폐기"가 아니라 `병합됨`으로 표시하고 어디로 갔는지 말할 수 있습니다.
- 원본을 `POST /api/works/:id/reopen`하면 `supersededByWorkId`가 지워집니다 — 세션은 대상에 남으므로 포인터만 무효가 되기 때문입니다.

### `DELETE /api/works/:id`

`204`. 카드는 그대로 남고(완료된 Work였다면 archive 상태도 그대로), 연결됐던 세션은 Inbox로 돌아옵니다.

**status 가드가 없습니다** — `done` Work도 삭제되며, 그것이 완료된 Work의 세션을 Inbox로 되돌리는 유일한 경로입니다. UI 진입점은 Work 상세 푸터의 `삭제…`이고 상태별 확인 문구를 거칩니다([`works.md`](./works.md#푸터-액션과-work-삭제)).

### `GET /api/works/inbox`

아직 triage되지 않은 세션(`WorkInboxSession[]`)을 **최근 활동순**으로 반환합니다. `GET /api/sessions`와 세션 집계 헬퍼(`computeSessionAggregates`)를 공유합니다.

| 쿼리 | 기본값 | 설명 |
|------|--------|------|
| `since` | `30` (일) | 잘라낼 기준. 일수(`since=7`), ISO 8601 시각(`since=2026-08-01T00:00:00.000Z`), 또는 `all`/`0`으로 해제 |
| `limit` | `200` | 최근 순 상한. 최대 `1000`, `all`로 해제 |

파싱되지 않는 값은 `400`입니다(`since must be a day count, an ISO 8601 timestamp, or "all"` / `limit must be a positive integer or "all"`).

Inbox는 보관소가 아니라 **정리 대기열**이므로, 다음 네 가지는 응답에서 제외됩니다.

1. 이미 Work에 연결된 세션, 그리고 폐기(`ignoredSessionIds`)한 세션
2. **카드가 하나도 없는 세션** — 피어 런타임은 열려 있는 세션을 전부 보고하므로, 예전에는 `(No linked card)` 행이 무제한으로 쌓이고 Works 탭 배지가 영구히 켜져 있었습니다
3. **부모가 이미 배정된 subagent 세션** — 부모의 Work가 이미 소유합니다(`POST /api/works/:id/sessions` 참고)
4. `since` 창을 벗어난 세션. 단 **실행 중(`cardStatus === 'in_progress'`)인 세션은 창과 무관하게 남습니다**

주요 필드:

- `cardStatus` — 대표 카드의 상태. Inbox 행의 상태 칩(`실행 중` / `미실행`)이 이 값으로 그려집니다
- `sessionKind` — `'main' | 'subagent'`. subagent 세션이지만 부모가 아직 미배정이면 `'subagent'`로 내려오고 행에 칩이 붙습니다
- `relatedSessionIds` — 그 세션의 계보(subagent 부모 / 큐 체인 / 이어받은 세션, archive된 카드 포함). 배정 UI의 `🔗 이어진 세션` 신호이며, **두 집계 경로(카드 파생 / 네이티브) 모두에서 채워집니다** — [`works.md`](./works.md) 참고

### `POST /api/works/reconcile-subagents`

subagent 승계가 도입되기 전에 연결된 Work들을 위한 **1회성 보정** 경로입니다. 모든 Work의 링크된 세션에서 subagent 자손을 찾아, 어디에도 연결되지 않은 것만 같은 Work에 붙입니다. 멱등이므로 반복 호출해도 안전합니다.

```json
{ "linked": [{ "workId": "AbC123", "sessionIds": ["claude-…"] }], "linkedCount": 1 }
```

### `GET /api/timeline`

Timeline 뷰(Board 탭의 `타임라인`)가 그릴 **실행된 세션**들을 창(window) 단위로 반환합니다.

| 쿼리 | 필수 | 설명 |
|------|------|------|
| `from` | ✅ | ISO 8601. 그리드 첫날 00:00(로컬) |
| `to` | ✅ | ISO 8601. 그리드 마지막날 23:59:59.999(로컬) |
| `subagents` | | `1`이면 `parentCardId`가 있는 카드도 포함. 기본은 제외 |

폐기한 세션(`ignoredSessionIds`)은 **제외하지 않고 `ignored: true`로 표시**합니다. 그 세션도 실제로 실행됐으므로 행은 남아야 하지만, Inbox에 없으므로 `배정` 버튼은 열 대상이 없습니다 — UI는 이 플래그로 버튼 대신 `폐기` 배지를 그립니다. Work 저장소가 주입되지 않은 서버에서는 필드가 없습니다.

`from`/`to`가 파싱되지 않거나 `to < from`이면 `400`. **창 길이가 `TIMELINE_MAX_WINDOW_DAYS`(400일)를 넘으면 `400 window must not exceed 400 days`** 입니다 — 창은 이 라우트가 파싱하는 아카이브 양을 제한하는 **유일한** 장치이고 인증 없는 GET이라, `from=1970&to=2030` 한 번으로 디스크의 모든 아카이브 월을 읽을 수 있었습니다. 그리드가 요청하는 최대치는 월간 35열이므로 400일은 충분히 여유가 있습니다. 검증은 순수 함수 `checkTimelineWindow(from, to)`(`src/core/timeline-aggregate.ts`)에 있습니다.

응답은 `TimelineSnapshot`:

```json
{
  "from": "2026-08-31T00:00:00.000Z",
  "to": "2026-09-06T23:59:59.999Z",
  "includesSubagents": false,
  "scannedMonths": ["2026-08", "2026-09"],
  "sessions": [
    {
      "sessionId": "claude-...",
      "sessionTitle": "…",
      "projectDir": "/w/agent-kanban",
      "agentRuntime": "claude",
      "startedAt": "2026-09-01T09:00:00.000Z",
      "endedAt": "2026-09-02T03:04:00.000Z",
      "truncatedBefore": true,
      "cards": [
        { "id": "…", "title": "…", "status": "done",
          "startedAt": "…", "completedAt": "…", "isSubagent": false }
      ]
    }
  ]
}
```

규칙:

- **실행된 카드만** 들어갑니다 — `startedAt`(없으면 `completedAt`)이 있어야 하고, 생성일은 쓰지 않습니다. `sessionId`가 없는 카드와 삭제된 카드도 빠집니다.
- 세션은 창과 **겹치기만** 하면 포함됩니다(창 안에서 시작해야 하는 게 아님). `endedAt`은 세션의 카드 중 하나라도 아직 실행 중이면 생략됩니다.
- **`truncatedBefore: true`는 "이 세션에는 창보다 먼저 끝난 카드가 더 있다"** 는 뜻입니다. 그 카드들은 요청한 창 밖이라 `cards`에 없고, 그래서 `startedAt`(= 도착한 카드들의 min)은 **세션의 실제 시작이 아닙니다**. 이 플래그가 없으면 클라이언트는 "이 그리드에서 시작했다"와 "그리드가 열릴 때 이미 돌고 있었다"를 구분할 수 없어서, 일주일째 돌던 세션 위에 닫힌 왼쪽 끝을 그렸습니다. UI는 이것을 잘린 span과 똑같이(`◂`, 점선 왼쪽 보더) 취급합니다 — 실제로 잘린 것이고, 다만 자르기가 데이터 도착 전에 일어났을 뿐입니다. `startedAt` 자체가 이미 창보다 앞이면(그때는 `columnOf`가 알아서 clip합니다) 플래그를 붙이지 않습니다.
- 읽는 아카이브 월은 `timelineArchiveMonths()`가 고릅니다(`src/core/timeline-aggregate.ts`): 창의 월 −1개월 이상인 월 전부. `store.loadArchives()`는 쓰지 않으므로 wiki/Telegram의 전체 스캔 경로에는 영향이 없습니다.
- **Work 그룹핑은 응답에 없습니다.** 웹이 `/api/works`를 이미 폴링하므로 세션 → Work 매핑은 클라이언트가 합니다.

집계 로직은 `src/core/timeline-aggregate.ts`의 순수 함수이고, 행 그룹핑은 `web/src/components/Works/timelineRows.ts`입니다 — [`works.md`](./works.md)의 Timeline 절 참고.

### `GET /api/works/:id/completion-preview`

완료가 **무엇을 파괴하는지** 미리 알려주는 읽기 전용 엔드포인트입니다(`WorkCompletionPreview`). 완료 확인 다이얼로그가 액션을 제공하기 전에 이 값을 읽습니다.

```json
{ "workId": "AbC123", "cardCount": 5, "sweepCardCount": 3,
  "byStatus": { "todo": 1, "in_progress": 1, "complete": 1, "done": 2 },
  "favoriteCardIds": ["k9"],
  "runningCardIds": ["k1"], "runningCardTitles": ["리팩터링 진행"],
  "sessionCount": 2, "alreadyArchived": false, "scannedMonths": ["2026-09"] }
```

| 필드 | 설명 |
|------|------|
| `cardCount` / `byStatus` | 연결된 모든 세션의 카드 수와 상태별 수. **archive 포함** — 이미 sweep된 Work가 "카드 0장"으로 보이면 안 되기 때문입니다 |
| `sweepCardCount` | 아직 보드에 남았고 **즐겨찾기가 아닌** 카드 수 = 지금 완료하면 실제로 archive될 수. 다이얼로그가 약속하는 숫자와 sweep이 하는 일이 어긋나면 안 됩니다 |
| `favoriteCardIds` | 즐겨찾기라서 보드에 남을 카드. 확인 다이얼로그가 `⭐ 즐겨찾기 카드 N장은 보드에 그대로 남습니다`로 알립니다 |
| `runningCardIds` / `runningCardTitles` | 실행 중인 에이전트를 가진 보드 카드(같은 순서). 비어 있지 않으면 `PATCH ... status: 'done'`이 `409`로 거부됩니다. **즐겨찾기 카드는 세지 않습니다** — sweep이 가져가지 않으므로 그 실행이 완료를 막을 이유가 없습니다 |
| `sessionCount` | `work.sessionLinks.length` |
| `alreadyArchived` | `work.archivedAt`이 있음 = 다시 완료해도 no-op |
| `scannedMonths` | 읽은 archive 월 파일 — 범위 휴리스틱 진단용 |

- 읽을 월은 `GET /api/works/:id/sessions`와 **같은 휴리스틱**(`workCardScanFloor` + `timelineArchiveMonths`)이며 `store.loadArchives()`는 쓰지 않습니다.
- 순수 계산은 `buildWorkCompletionPreview()`(`src/plugin/works/work-lifecycle.ts`)입니다.
- Work가 없으면 `404 Work not found`. `RuntimeRunStore`가 주입되지 않은 환경에서는 `runningCardIds`가 항상 비어 있습니다(서버는 항상 주입합니다).

### `GET /api/works/:id/sessions`

Work 상세 다이얼로그의 데이터 소스입니다. 연결된 세션별 요약과 Work 전체 합계를
**라이브 보드 + 월별 archive**로 계산해 반환합니다(`WorkSessionsResponse`).

Work를 완료하면 산하 카드가 전부 archive되므로, 웹이 폴링하는 보드 목록만으로 집계하면
"되돌아볼" 대상인 Work가 정확히 `카드 0 · done 0`으로 보입니다. 그래서 이 계산은 서버가 합니다.

| 필드 | 설명 |
|------|------|
| `sessions[]` | `linkedAt` 오래된 순. `sessionId`, `role`, `linkedAt`, `projectDir` |
| `sessions[].title` | 그 세션 최초 카드의 제목(없으면 `sessionTitle`, 둘 다 없으면 `''` → UI가 짧은 세션 id로 폴백) |
| `sessions[].cardCount` / `doneCount` / `inProgressCount` | 카드 수와 상태별 수 |
| `sessions[].firstCardAt` / `lastActivityAt` | 최초 실행 시각(`startedAt`, 없으면 `createdAt`)과 마지막 `updatedAt` |
| `sessions[].archived` | 그 세션 카드가 **전부** 보드에서 빠졌다 = archive 완료. 카드가 0건인 세션은 `false` |
| `sessions[].archivedCardCount` | 그 세션 카드 중 archive에 있는 것의 수. `archived`가 여기서 파생됩니다 |
| `sessions[].cardsMissingAt` | 그 세션에 카드가 **하나도 없다**고 관측된 시각(`WorkSessionLink.cardsMissingAt`의 echo). 이 읽기는 월 단위로 제한되므로 "창 안에 카드가 없음"과 "아예 없음"은 다른 사실입니다 — 이 필드가 후자이고, `POST /api/works/reconcile-links`가 씁니다 |
| `sessions[].cardIds` | 오래된 순 카드 id |
| `sessions[].wikiDocPaths` / `wikiPending` | `decision='kept'` 문서 경로들 / 아직 `status='pending'`인 카드 존재 여부 |
| `cardCount` · `doneCount` · `inProgressCount` · `archivedCardCount` · `lastActivityAt` · `wikiDocPaths` · `wikiPending` | 전 세션 합계(`lastActivityAt`은 카드가 없으면 Work의 `updatedAt`) |
| `scannedMonths` | 읽은 archive 월 파일 — 범위 휴리스틱 진단용 |

- 읽을 월은 `/api/timeline`과 **같은 휴리스틱**(`timelineArchiveMonths`)으로 고르고, 창 시작은
  `workCardScanFloor(work)` = `min(startedAt, createdAt, ...linkedAt)`입니다. `store.loadArchives()`
  (전체 스캔)는 쓰지 않습니다.
- 순수 계산은 `buildWorkSessionsResponse()`(`src/core/timeline-aggregate.ts`)이며, 카드가 라이브와
  archive 양쪽에 보이면(sweep과 읽기가 겹친 경우) 한 번만 셉니다.
- `archivedCardCount`는 **`POST /api/works/:id/reopen` 확인 문구가 "카드 N장 복원"을 말하기 위한 값**입니다. 전용 라우트를 새로 만드는 대신 이 집계에 붙였습니다 — Work 상세 다이얼로그가 이미 이 응답을 들고 있으므로 같은 월별 읽기를 두 번 하지 않습니다.
- Work가 없으면 `404 Work not found`.

### `POST /api/works/:id/sessions`

세션을 Work에 연결합니다.

- `sessionId` (required) — 이미 다른 Work에 연결돼 있으면 `409`
- `role` — `dev` | `review` | `debug`
- `projectDir`

**대상 Work가 `active`가 아니면 `409`입니다** (`Cannot link a session to a done work: "<title>"`). `done` Work는 이미 카드를 wiki 파이프라인에 넘겼고 `discarded` Work는 세션을 내보내기 위해서만 존재하므로, 둘 다 실행한 적 없는 세션을 새로 받아서는 안 됩니다. 클라이언트가 추천을 active Work로 거르지만 패널이 열린 사이 상태가 바뀔 수 있으므로(Works 폴링 10초) 서버가 다시 검사합니다.

> **같은 Work가 이미 가진 세션의 재연결은 예외입니다.** 그것이 `⋯` 메뉴의 역할 변경 경로이고 그룹핑을 바꾸지 않으므로 종료된 Work에서도 허용됩니다. 데이터 보정용 `POST /api/works/reconcile-subagents`도 이 가드를 받지 않습니다(과거 데이터의 Work는 상태가 무엇이든 자손을 흡수해야 합니다).

연결 후 Work의 `startedAt`을 **연결된 모든 세션의 최초 카드 시각의 `min()`** 으로 재계산합니다(archive된 카드 포함, 카드가 없는 세션은 그 링크의 `linkedAt` 폴백). 첫 연결만의 특례가 아니라 **모든** 연결에 적용되므로, 더 오래된 세션을 나중에 붙이면 Timeline 바가 왼쪽으로 당겨집니다.

재계산은 라우트가 아니라 **store의 락 안에서** 일어납니다. 라우트는 카드 스냅샷 하나를 `createWorkStartedAtResolver(cards)`로 감싸 넘기고(`src/plugin/works/work-lifecycle.ts`), `WorkStore.addSession` / `removeSession` / `moveSession` / `pruneMissingSessions`가 각자 방금 쓴 링크 집합에 대고 그것을 실행합니다. 라우트가 먼저 계산해 값을 넘기던 시절에는 동시 연결 두 건이 각각 "상대 세션이 없는 링크 집합"의 `min()`을 계산했고, 나중에 쓴 쪽이 상대의 답을 덮어썼습니다.

**subagent 자손도 함께 연결됩니다.** subagent 세션은 독립된 작업이 아니라 부모 카드가 낳은 것이므로, 부모 세션이 Work를 가지면 자식도 같은 Work에 들어갑니다(`parentCardId` 체인, transitive). 이미 다른 Work에 연결된 세션은 건너뜁니다 — 1:N 불변식은 저장소의 것이고 이 경로가 우회 수단이 되어서는 안 됩니다. 사용자가 고른 `role`/`projectDir`은 **고른 그 세션에만** 붙고, 승계된 세션은 기본값을 씁니다.

응답은 `WorkAddSessionResponse` = `Work` + `cascadedSessionIds`(승계된 세션 id 배열)입니다. `WorkPatchResponse`와 같은 이유로 envelope이 아닌 superset입니다 — 기존 호출자는 그대로 `Work`로 읽습니다.

### `DELETE /api/works/:id/sessions/:sessionId`

연결을 해제합니다. 해당 세션은 다시 Inbox에 나타납니다. 같은 `min()` 규칙으로 `startedAt`을 재계산하므로, 가장 오래된 세션을 떼면 남은 세션 중 가장 이른 시각으로 밀립니다. **링크 변경은 손으로 찍은 `startedAt`을 덮어씁니다** — 연결/해제/이동/정리 후의 시작일은 항상 파생값입니다.

- **그 Work가 갖고 있지 않은 세션에 대한 DELETE는 아무것도 쓰지 않는 no-op입니다** — 재계산도, `updatedAt` 갱신도 하지 않습니다. 예전에는 no-op에서도 재계산해서, 이미 해제된 세션을 다시 지우는 요청이 사용자가 바 드래그로 맞춰둔 날짜를 파생값으로 되돌렸습니다.
- 실패는 다른 Works 라우트와 같은 규칙으로 **서버의 원래 이유**를 돌려줍니다(`404 Work not found` 등). 전부 `500 Failed to remove session`으로 뭉개지 않습니다.

### `POST /api/works/:id/sessions/batch`

triage에서 고른 세션 **여러 개를 한 요청으로** 연결합니다. 각 항목은 `POST /api/works/:id/sessions`와 같은 규칙(1:N, `active` 대상, subagent 자손 승계)을 그대로 통과합니다.

```json
{ "sessions": [{ "sessionId": "claude-a" }, { "sessionId": "claude-b", "role": "review" }],
  "role": "dev" }
```

- `sessions` (required) — 비어 있으면 `400 sessions must be a non-empty array`. 각 항목의 `sessionId`는 필수, `projectDir`/`role`은 선택
- 최상위 `role`은 자기 `role`이 없는 항목에만 적용됩니다
- 잘못된 body는 store를 건드리기 전에 `400`

응답은 `WorkBatchAddSessionsResponse`입니다.

```json
{ "work": { … }, "linkedSessionIds": ["claude-a"], "cascadedSessionIds": [],
  "failed": [{ "sessionId": "claude-b", "message": "Session is already linked to work …" }] }
```

- **부분 성공이 정상 결과입니다.** 1:N 불변식은 세션 단위이므로, 이미 다른 Work에 속한 세션 하나가 성공한 링크들을 되돌려서는 안 됩니다. 실패한 세션만 Inbox에 남아 그대로 재시도할 수 있습니다.
- **원자적인 것은 각 링크입니다** — `min()` 재계산이 store의 락 안에서 일어납니다. 배치 전체가 all-or-nothing인 것은 아닙니다.
- 이 동사가 존재하는 이유는 스캔 비용입니다. 웹이 세션 하나씩 순차 POST하던 시절에는 요청마다 **아카이브 전체 스캔**이 일어나, 20개를 배정하는 클릭 한 번이 20회 이상의 전체 스캔이 됐습니다. 배치는 카드 스냅샷 **하나**를 모든 링크와 subagent 트리 계산이 공유합니다.

> 라우트 순서: 3세그먼트 경로이므로 `/api/works/:id/sessions`(2세그먼트)보다 **앞**에 등록해야 합니다.

### `POST /api/works/:id/prune-sessions`

`cardsMissingAt`이 찍힌 링크를 전부 끊습니다 — 그 세션에는 Work가 도달할 수 있는 어디에도 카드가 남아 있지 않습니다.

```json
{ "work": { … }, "removedSessionIds": ["claude-gone"] }
```

- 스탬프를 찍는 것은 `reconcileWorkSessionLinks`이고, **제거는 언제나 사용자의 명시적 행동**입니다. 카드 삭제는 soft delete이고 `POST /api/cards/:id/restore`로 되돌아오므로, 자동으로 링크를 끊으면 되돌릴 수 있던 동작이 되돌릴 수 없게 됩니다.
- 남은 링크로 `startedAt`을 재계산합니다.
- **링크가 0개가 돼도 Work는 삭제하지 않습니다.** `PATCH /api/works/sessions/:sessionId`가 비워진 원본을 지우는 것은 그 이동에 명확한 목적지가 있는 병합이기 때문입니다. 정리 버튼에는 목적지가 없고, 레코드·Summary·Timeline 이력까지 부수효과로 없애서는 안 됩니다 — 비워진 Work는 그대로 보이고 `DELETE /api/works/:id`로 지울 수 있습니다.
- UI 진입점은 Work 상세 푸터의 `🧹 끊긴 세션 정리 (N)`이며 확인을 거칩니다.

### `POST /api/works/reconcile-links`

모든 Work의 링크에 `cardsMissingAt`을 찍거나 지우는 **1회성 보정**입니다. 멱등이며 서버 부팅 시에도 한 번 자동 실행됩니다.

```json
{ "scanned": 12,
  "marked": [{ "workId": "AbC123", "sessionIds": ["claude-gone"] }],
  "cleared": [] }
```

- 카드 삭제는 예전에 Works에 아무것도 알리지 않았습니다. 그래서 카드를 전부 지운 세션의 링크가 그대로 남고, `resolveWorkStartedAt`이 그 링크의 `linkedAt`으로 조용히 폴백해 **Timeline 바가 작업 시작일이 아니라 triage 시각에서 시작**했습니다. 상세의 `대화` 버튼도 사라진 세션을 가리켰습니다.
- 지금은 `DELETE /api/cards/:id`와 `POST /api/cards/:id/restore`가 그 카드의 세션을 소유한 Work **하나만** 좁혀서 같은 패스를 돌립니다(best-effort — 정리 실패가 카드 쓰기를 실패시키지 않습니다). 이 라우트는 그 이전 데이터를 위한 전체 보정입니다.
- 읽기는 Work마다 `workCardScanFloor` + `timelineArchiveMonths`로 제한된 월 단위 스캔입니다. `store.loadArchives()`는 쓰지 않습니다.

> 라우트 순서: 리터럴 세그먼트이므로 `/api/works/:id` catch-all보다 **앞**에 있어야 합니다.

### `PATCH /api/works/sessions/:sessionId`

세션의 링크를 다른 Work로 **옮깁니다**. 이동은 링크를 새로 만드는 것이 아니라 부모를 바꾸는 것이므로 별도 동사를 가지며, `POST /api/works/:id/sessions`의 재연결 `409` 불변식은 **그대로 유지**됩니다.

```json
{ "toWorkId": "AbC123", "role": "review" }
```

- `toWorkId` (required) — 없거나 공백이면 `400 toWorkId is required`, 존재하지 않으면 `404 Work not found`
- `role` — `dev` | `review` | `debug` (선택). 생략하면 기존 링크의 역할을 유지하고, 잘못된 값은 `400 Invalid role`
- 어느 Work에도 붙어 있지 않은 세션(= Inbox)은 `404`
- **`409` 조건**: 원본·대상 **양쪽 중 하나라도 완료 중이거나 완료된 Work면** 거부하고 Work 제목이 포함된 사람이 읽을 수 있는 메시지를 돌려줍니다. 두 가지입니다 — `archivedAt`이 있으면 `Cannot move a session into an archived work: "<title>"`, `status: 'done'`인데 `archivedAt`이 없으면(= `works.done_confirm`이 sweep을 보류한 상태) `Cannot move a session out of a completing work: "<title>"`. 후자를 막는 이유: 곧 실행될 archive와 경합해 이미 결정된 문서 그룹핑으로 세션이 재배치됩니다. `active ↔ active`, `discarded → active`는 허용합니다. 이동 대화상자를 열어둔 사이 상태가 바뀔 수 있으므로(Works 폴링 10초) 클라이언트 필터를 신뢰하지 않고 서버가 양쪽을 다시 검사합니다
- 이미 대상 Work에 속한 세션을 다시 이동시키면 역할만 갱신하는 no-op입니다

응답은 `MoveWorkSessionResponse`입니다.

```json
{ "from": { "id": "…", "startedAt": "…" } , "to": { "id": "…", "startedAt": "…" } }
```

링크 이동 → **양쪽** `startedAt` 재계산 → 비워진 원본 삭제까지가 하나의 dual lock 트랜잭션입니다. 마지막 세션이 빠져나가 원본에 링크가 남지 않으면 합병으로 간주해 원본 Work를 삭제하고 `from`은 `null`이 됩니다.

> 라우트 순서: `/api/works/sessions/:sessionId`는 `/api/works/:id` catch-all보다 **앞**에 있어야 하고, 두 번째 세그먼트가 Work id인 `/api/works/:id/sessions/:sessionId`와 혼동되지 않도록 배치해야 합니다(이쪽은 리터럴 `sessions`).

### `POST /api/works/ignore-session`

세션을 Inbox에서 제외합니다(`ignoredSessionIds`에 추가, 멱등).

```json
{ "sessionId": "claude-abc123" }
```

응답: `{ "ignoredSessionIds": ["..."] }`

### `GET /api/works/ignored-sessions`

무시 목록을 **읽습니다**. `WorkIgnoredSession[]`이며 최근 활동순입니다.

```json
[
  {
    "sessionId": "claude-abc123",
    "session": { "sessionId": "claude-abc123", "cardTitle": "…", "relatedCardCount": 3, "updatedAt": "…" },
    "returnsToInbox": true
  }
]
```

- `session` — Inbox 행과 **같은 DTO**(`WorkInboxSession`, 같은 매퍼 `toInboxSession`)라 목록이 세션을 첫 프롬프트로 식별할 수 있습니다. 요약할 카드가 남지 않은 id는 이 필드가 없고 행만 남습니다 — 여전히 무시 상태이고, 목록에서 빠지는 방법은 복원뿐입니다.
- `returnsToInbox` — 복원했을 때 실제로 Inbox에 다시 나타나는지. **Inbox와 같은 술어**(`isInboxTriageMaterial`, `since`는 Inbox 기본값 30일)로 계산하므로 두 라우트가 어긋날 수 없습니다.
- 이 라우트가 없던 동안 `ignoredSessionIds`는 추가만 가능하고 읽을 수도 없는 목록이었습니다 — `폐기` 한 번이 세션을 모든 화면에서 영구히 지웠고 복구는 `works.json` 수기 편집뿐이었습니다.

> 라우트 순서: 리터럴 세그먼트이므로 `/api/works/:id` catch-all보다 **앞**에 있어야 합니다.

### `DELETE /api/works/ignore-session/:sessionId`

세션을 무시 목록에서 제거합니다(= 복원). 응답은 남은 `{ "ignoredSessionIds": [...] }`입니다.

- **목록에 없던 id는 `404`** (`Session is not in the ignore list: …`)입니다. 멱등하게 성공을 돌려주면 오래된 목록을 든 UI가 이미 빠진 행을 "복원했다"고 보고할 수 있습니다.
- 복원은 링크를 만들지 않습니다. 세션이 Inbox 필터를 통과하면 다시 나타나고, 아니면 어디에도 나타나지 않습니다 — `GET /api/works/ignored-sessions`의 `returnsToInbox`가 그것을 미리 알려줍니다.

### `POST /api/works/:id/summary`

연결된 모든 세션의 트랜스크립트를 모아 `works.summary_model` LLM으로 3~5줄 Summary를 생성해 저장합니다. 응답은 `WorkSummaryResponse`(`work`, `summary`, `generatedSessions`, `skippedSessions`)이며, 읽을 트랜스크립트가 없으면 `422`입니다.

### `GET /api/works/config`

`WorksConfigDto`(`works.*` 설정값 + `configured` + 파생 `route`)를 반환합니다.

### `POST /api/works/config`

`WorksConfigInput`의 제공된 필드만 저장합니다. 검증 실패는 `400`입니다.

- `summaryModel`, `summaryLines`(`3`|`4`|`5`), `assignPreferSameDir`, `assignSuggestResumeChain`, `staleDays`(>= 1), `doneConfirm`

두 `assign*` 플래그는 서버 저장값일 뿐이고, 추천 순서를 실제로 계산하는 것은 웹의 순수 함수 `recommendWorksForSession`입니다 — `WorksView`가 이 DTO를 읽어 옵션으로 넘깁니다. 설정을 읽지 못했을 때의 폴백은 문서상 기본값인 `true`입니다.

설정 키 목록과 기본값은 [`./works.md`](./works.md#설정-키-works)에 있습니다.

> 라우트 순서: `/api/works/config`와 `/api/works/sessions/:sessionId`처럼 리터럴 세그먼트를 가진 경로는 `/api/works/:id` catch-all보다 앞에 있어야 합니다(그러지 않으면 `id`가 `"config"` / `"sessions"`로 잡힙니다).

## LLM Wiki API

아카이브된 카드를 Obsidian 위키 문서로 분류·생성하는 파이프라인의 API입니다. 실제 처리는 플러그인의 `WikiWorker`가 비동기로 수행합니다.

### `GET /api/wiki/config`

현재 위키 설정을 반환합니다. 응답에는 `configured`, `enabled`, `model`, `route`(`codex` 또는 `claude`), `effort`, `vaultDir`가 포함됩니다.

### `POST /api/wiki/config`

위키 설정을 부분 갱신합니다. 모델을 바꿀 때는 실행할 CLI가 모델 이름에 의해 잘못 추론되지 않도록 `model`과 `route`를 함께 보내는 것을 권장합니다.

```json
{
  "model": "gpt-5.6-sol",
  "route": "codex",
  "effort": "medium",
  "vaultDir": "/path/to/obsidian/AgentKanbanWiki",
  "enabled": true
}
```

### `GET /api/wiki/status`

워커 상태(`WikiWorkerStatus`)를 반환합니다: `enabled`, `running`, `pendingCount`, `processedInRun`, `totalInRun`, `promptVersion`, `vaultDir`, `model`, `route`, `effort`, `lastError`, `lastFinishedAt`.

추가로 전체 아카이브 집계(`stats`: `total`/`kept`/`skipped`/`failed`/`pending`/`unprocessed`/`docCount`/`byType`)와 최근 워커 활동 로그(`recentLogs`: 최대 50줄, `{ at, level, message }`)를 포함합니다.

### `GET /api/wiki/archive?month=YYYY-MM`

해당 월의 아카이브 카드 목록과 전체 월 목록을 반환합니다. `month` 생략 시 최신 월을 반환합니다 (Settings UI의 "더보기"가 월 단위로 페이지네이션).

```json
{ "months": ["2026-06", "2026-05"], "month": "2026-06", "cards": [] }
```

### `POST /api/wiki/backfill`

wiki 상태가 없거나, `failed`이거나, `promptVersion`이 현재보다 낮은 top-level 아카이브 카드를 pending으로 큐잉합니다. child 카드는 제외됩니다. `{ "queued": n }`을 반환합니다.

### `POST /api/wiki/reprocess`

특정 top-level 카드를 강제로 재처리 큐에 넣습니다. child 카드는 제외됩니다. 기존 `docPath`가 있으면 문서를 같은 경로에 덮어씁니다.

요청 본문:

```json
{ "cardIds": ["card-id"] }
```

### `POST /api/wiki/restart`

워커의 재진입 가드(`processing`)와 `lastError`를 리셋하고 인터벌 타이머를 재시작한 뒤 즉시 처리 패스를 트리거합니다. 워커가 hung LLM 호출 등으로 멈춘 상태에서 복구할 때 사용합니다. 갱신된 `WikiWorkerStatus`를 반환합니다.

## 스크린샷 API

### `POST /api/cards/:id/screenshots`

`multipart/form-data`로 스크린샷을 업로드합니다. `file` 필드가 필요합니다.

### `DELETE /api/cards/:id/screenshots/:screenshotId`

스크린샷 메타데이터와 파일을 삭제합니다.

### `GET /api/screenshots/:filename`

업로드된 스크린샷 파일을 반환합니다.

## 스케줄러 API

### `GET /api/schedulers`

스케줄러 목록을 반환합니다.

### `POST /api/schedulers`

스케줄러를 생성합니다.

요청 본문 핵심 필드:

- `name` (required)
- `description`
- `scheduleInput` (`simple` 또는 `cron` 모드) 또는 `cron`
- `timezone`
- `action` (required)

`action` shape:

```json
{
  "type": "bash",
  "command": "bun test"
}
```

또는

```json
{
  "type": "prompt",
  "prompt": "새벽 점검 결과를 요약해 주세요.",
  "agentRuntime": "codex",
  "model": "gpt-5.4"
}
```

### `GET /api/schedulers/:id`

단일 스케줄러를 반환합니다.

### `PATCH /api/schedulers/:id`

스케줄러를 수정합니다. `scheduleInput` 또는 `cron`을 넘기면 유효성 검사 후 저장합니다.

### `DELETE /api/schedulers/:id`

스케줄러를 삭제합니다.

### `POST /api/schedulers/:id/toggle`

`active` / `inactive` 상태를 토글합니다.

### `POST /api/schedulers/:id/run`

즉시 실행한다.

- `bash` action: `stdout` / `stderr` / `exitCode`를 포함한 `SchedulerRun`을 반환한다.
- `prompt` action: 먼저 scheduler-origin `todo` 카드를 만들고 기존 runtime dispatch를 호출한다. 성공 시 `cardId`, `dispatched`, `dispatchAcceptedAt`가 채워진다.

### `GET /api/schedulers/:id/history`

실행 이력을 반환합니다.

### `POST /api/schedulers/parse-cron`

raw cron 입력을 파싱/검증합니다. `mode`는 `cron`만 지원합니다.

요청:

```json
{ "input": "0 9 * * *", "mode": "cron" }
```

응답 예시:

```json
{ "cron": "0 9 * * *", "description": "KST 실행: 매일 09:00", "valid": true }
```

## 설정 API

### `GET /api/settings`
### `POST /api/settings`
### `PUT /api/settings/by-key/:key`
### `GET /api/settings/:id`
### `PATCH /api/settings/:id`
### `DELETE /api/settings/:id`

설정 항목은 `key`, `value`, `description`, `category`, `masked`를 사용합니다. `network_exposed` 설정이 바뀌면 서버 바인딩 호스트 재시작이 연동됩니다.

`PUT /api/settings/by-key/:key`는 `SettingsStore.upsertByKey()`를 사용해 단일 key를 atomic read-modify-write로 생성/수정합니다.

요청:

```json
{
  "value": "codex",
  "description": "Default for runtime",
  "category": "agent.defaults",
  "masked": false
}
```

runtime UI는 다음 key를 사용합니다.

| Key | 설명 |
|-----|------|
| `agent.defaults.runtime` | New Task 기본 runtime |
| `agent.defaults.codex` | Codex 기본 모델 |
| `agent.defaults.claude` | Claude 기본 모델 |
| `agent.defaults.opencode.<agentType>` | opencode preset별 기본 모델 |
| `agent.claude.permission_mode` | Claude permission mode |
| `agent.claude.dangerously_skip_permissions` | Claude dangerous skip permissions 설정 |

## 스크립트 API

### `GET /api/scripts`
### `POST /api/scripts`
### `GET /api/scripts/:id`
### `PATCH /api/scripts/:id`
### `DELETE /api/scripts/:id`

스크립트 항목은 `name`, `description`, `content`, `language`, `projectDir`를 사용합니다.

### `POST /api/scripts/sync`

`KANBAN_DATA_DIR/scripts/` 디렉터리(기본값 `~/.agent-kanban/scripts/`)를 `ScriptStore`와 동기화합니다.

### `POST /api/scripts/:id/run`

Script Quick Action과 동일한 `ScriptExecutionService`로 실행합니다. effective cwd와 stored language를 검증하고 content/language revision·cwd를 snapshot으로 고정한 뒤 일반 card와 `ScriptRun(status=running)`을 저장합니다. HTTP 요청은 완료를 기다리지 않고 `202`와 다음 응답을 반환합니다.

```json
{
  "cardId": "card-id",
  "runId": "script-run-id",
  "status": "running",
  "startedAt": "2026-08-16T00:00:00.000Z"
}
```

같은 script의 동시 실행은 `409`이며, running entry는 삭제할 수 없습니다. 완료 상태는 `GET /api/cards/:cardId` 또는 `GET /api/scripts/:id/history`로 polling합니다.

### `GET /api/scripts/:id/history`

실행 이력을 반환합니다.

## Capabilities / MCP Scope API

`McpInventoryItem`, 각 placement, placement target은 `runtime`(`claude` | `codex`)을 포함합니다. inventory identity는 `runtime:name`이고 exact placement identity는 runtime/name/config path/적용 디렉터리를 포함하므로 같은 이름의 Claude/Codex 서버나 같은 서버의 여러 directory layer가 합쳐지지 않습니다. runtime이 없던 기존 target과 기존 API 요청은 Claude로 해석됩니다.

Codex directory target은 git/project root부터 target directory까지 존재하는 `.codex/config.toml` chain을 순서대로 스캔합니다. 같은 이름은 가까운 directory 정의가 우선하며 placement의 `appliesToDir`, `configLayer`, `precedence`, `effective`, `overriddenBy`로 적용 관계를 표시합니다. Project config는 trust가 필요하지만 API는 신뢰 여부를 추측하지 않고 `projectTrust=required-status-unknown`과 `diagnostics.mcpDiscovery.codex.projectTrust.status=unknown`을 반환합니다.

누락된 TOML은 빈 layer로 취급하고, 잘못된 TOML은 `diagnostics.mcpDiscovery.codex.issues`에 기록합니다. Codex layer 하나가 실패해도 Claude MCP와 Claude/Codex/OpenCode Skill 목록은 그대로 반환됩니다. 기존 `userScopeMcpCount`와 `alwaysLoadCount`는 계속 Claude MCP만 집계합니다.

- `GET /api/scope/inventory`: Claude `~/.claude.json`/`.mcp.json`과 Codex `~/.codex/config.toml`/`<dir>/.codex/config.toml` inventory를 함께 반환합니다.
- `GET|POST /api/scope/targets`, `DELETE /api/scope/targets/:id`: runtime별 placement target을 관리합니다. 같은 디렉터리도 runtime이 다르면 별도 target으로 등록할 수 있습니다.
- `POST /api/scope/mcp/:name/copy`
- `POST /api/scope/mcp/:name/move`
- `DELETE /api/scope/mcp/:name`
- `POST /api/scope/cold/freeze`, `POST /api/scope/cold/restore`: MCP 요청은 선택적 `runtime`을 받으며 생략 시 Claude입니다.

MCP mutation body는 `runtime`, `inventoryIdentity`, 원본 `sourcePlacementIdentity`/`placementIdentity`, 목적지 `targetId`를 받을 수 있습니다. `?preview=1`은 파일을 쓰지 않고 `changes[]` diff만 반환하며, apply 요청은 runtime을 명시 분기합니다. Codex writer는 선택한 `[mcp_servers.*]` table만 수정하고 model/hooks/skills 등 다른 TOML 내용과 순서를 보존합니다. Claude JSON parser/writer와 CLI fallback 계약은 기존 형식을 유지합니다. `alwaysLoad` capability는 Claude 전용입니다.

MCP cold manifest는 원 runtime과 exact source placement를 저장합니다. restore 목적지를 생략하면 해당 원위치를 사용하며, placement가 없는 legacy manifest/registry는 기존처럼 Claude와 `sourceScope`로 해석됩니다. freeze/restore도 `?preview=1`에서 config diff를 먼저 반환합니다.

### Runtime별 설정과 UI 필터

| Runtime | User MCP | Directory MCP | 지원 옵션 |
|---|---|---|---|
| Claude | `~/.claude.json` | local은 `~/.claude.json`의 `projects[dir]`, project는 `<dir>/.mcp.json` | 기존 stdio/http/SSE, env, `alwaysLoad`, Claude CLI fallback |
| Codex | `~/.codex/config.toml` | `<dir>/.codex/config.toml` | stdio/http, env/env_vars, headers, enabled, enabled_tools/disabled_tools, timeout/required 옵션. `alwaysLoad`는 지원하지 않음 |

Capabilities UI의 All/Claude/Codex/OpenCode 필터는 MCP와 Skill에 같은 방식으로 적용됩니다. OpenCode 필터에는 OpenCode Skill이 표시되며 현재 MCP inventory runtime은 Claude/Codex입니다. All은 기존 MCP와 Claude/Codex/OpenCode Skill을 누락 없이 합칩니다.

Codex directory config는 project root에서 선택한 target/current directory까지 chain으로 평가하고 가까운 layer가 같은 이름을 override합니다. 실제 Codex 클라이언트에서 project config가 로드되려면 trusted project여야 합니다. API는 trust 여부를 추측하지 않고 `required-status-unknown`만 반환하며, 변경 후에는 새 세션 또는 Codex 클라이언트 재시작이 필요할 수 있습니다.

## Runtime / 모델 / 질문 API

### `GET /api/runtimes`

UI runtime selector에 필요한 runtime catalog를 반환합니다.

응답 shape:

```json
{
  "runtimes": [
    {
      "runtime": "opencode",
      "label": "Opencode",
      "selection": "preset"
    },
    {
      "runtime": "codex",
      "label": "Codex",
      "selection": "model",
      "models": [{ "id": "gpt-5.3-codex", "label": "GPT-5.3 Codex", "tier": "codex" }]
    },
    {
      "runtime": "claude",
      "label": "Claude",
      "selection": "model"
    }
  ]
}
```

### `GET /api/models`

opencode SDK에서 제공하는 모델 목록을 반환합니다. opencode preset/model panel에서 사용합니다.

### `GET /api/sessions`

카드에 연결된 session 목록을 반환합니다. session picker는 `agentRuntime`을 함께 표시합니다.

주요 필드:

- `sessionId`
- `sessionTitle`
- `cardId`
- `cardTitle`
- `cardStatus`
- `agentRuntime`
- `agentType`
- `model`
- `updatedAt`
- `relatedSessionIds` / `parentSessionIds` / `sessionKind` — 세션 계보. 카드 파생·네이티브 두 집계 경로 **모두**에서 채워집니다(`computeSessionAggregates`가 분기 위에서 한 번 계산)

### `GET /api/questions`

현재 pending question 목록을 반환합니다.

### `POST /api/questions/:id/reply`

질문에 답변합니다.

```json
{ "answers": [["Option A"], ["Option B"]] }
```

### `POST /api/questions/:id/reject`

질문을 거절합니다.

### 개발용 mock 질문 엔드포인트

- `POST /api/questions/mock`
- `DELETE /api/questions/mock`

UI 테스트용 question 주입/정리에 사용됩니다.

## 관련 문서

- [`./kanban-board.md`](./kanban-board.md)
- [`./works.md`](./works.md)
- [`./architecture.md`](./architecture.md)
