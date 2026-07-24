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
- `include_archived=true`

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

단일 카드를 반환합니다.

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
- `resolution` (`completed` | `superseded`)
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

## LLM Wiki API

아카이브된 카드를 Obsidian 위키 문서로 분류·생성하는 파이프라인의 API입니다. 실제 처리는 플러그인의 `WikiWorker`가 비동기로 수행합니다.

### `GET /api/wiki/status`

워커 상태(`WikiWorkerStatus`)를 반환합니다: `enabled`, `running`, `pendingCount`, `processedInRun`, `totalInRun`, `promptVersion`, `vaultDir`, `lastError`, `lastFinishedAt`.

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

스크립트를 실행하고 실행 결과를 history에 남깁니다.

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
- [`./architecture.md`](./architecture.md)
