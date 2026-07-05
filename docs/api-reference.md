# API 레퍼런스

## 개요

서버는 `Bun.serve()` 기반이며 모든 `/api/*` 응답에 CORS 헤더를 포함합니다. 실패 응답은 `{ "error": string }` 형식을 사용합니다.

기본 URL은 `http://localhost:24680`이며, 포트 충돌 시 다음 포트를 순차적으로 시도할 수 있습니다.

## 공통 규칙

- Content-Type: `application/json` (스크린샷 업로드 제외)
- CORS: `Access-Control-Allow-Origin: *`
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
- `cron` 또는 `naturalLanguage`
- `timezone`
- `action` (required)

`action` shape:

```json
{
  "type": "shell",
  "command": "bun test"
}
```

또는

```json
{
  "type": "skill",
  "skillName": "example_skill",
  "skillInput": "..."
}
```

### `GET /api/schedulers/:id`

단일 스케줄러를 반환합니다.

### `PATCH /api/schedulers/:id`

스케줄러를 수정합니다. `cron`을 넘기면 유효성 검사를 하고, `naturalLanguage`만 넘기면 cron으로 변환합니다.

### `DELETE /api/schedulers/:id`

스케줄러를 삭제합니다.

### `POST /api/schedulers/:id/toggle`

`active` / `inactive` 상태를 토글합니다.

### `POST /api/schedulers/:id/run`

즉시 실행합니다.

### `GET /api/schedulers/:id/history`

실행 이력을 반환합니다.

### `POST /api/schedulers/parse-cron`

자연어 또는 raw cron 입력을 파싱/검증합니다.

요청:

```json
{ "input": "매일 오전 9시" }
```

응답 예시:

```json
{ "cron": "0 9 * * *", "description": "매일 오전 9시", "valid": true }
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
