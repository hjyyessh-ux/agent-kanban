# 칸반 보드

## 개요

칸반 보드는 opencode/Codex/Claude runtime에서 발생하는 AI 코딩 작업을 카드 형태로 추적하는 시스템이다. 각 작업은 하나의 카드로 표현되며, 4개의 컬럼으로 구성된 보드 위에서 상태가 관리된다.

opencode에서 새 세션이 시작되면 카드가 자동으로 생성된다. 사용자가 직접 카드를 만들 때는 runtime을 선택할 수 있다. 카드는 작업의 진행 상황을 추적하고, 여러 세션에 걸쳐 작업 맥락을 보존한다. 완료된 카드는 월별 아카이브로 이동해 보드를 깔끔하게 유지할 수 있다.

---

## 보드 컬럼

보드는 4개의 컬럼으로 구성된다. 각 컬럼은 카드의 현재 상태를 나타낸다. 상태 전환에는 제한이 없어서 어떤 상태에서도 다른 상태로 바로 이동할 수 있다.

### `todo` — 대기 중

새로 생성된 카드의 기본 상태다. 아직 작업이 시작되지 않은 카드들이 여기에 모인다. TODO 컬럼 내에서는 드래그 앤 드롭으로 카드 순서를 조정할 수 있다. 큐 시스템을 통해 TODO 카드를 특정 순서로 자동 디스패치할 수도 있다.

### `in_progress` — 진행 중

현재 runtime 실행이 활성화되어 작업이 진행 중인 상태다. 카드가 디스패치되거나 사용자가 수동으로 상태를 변경하면 이 컬럼으로 이동한다. runtime별 actual continuation id가 `sessionId`로 카드에 연결된다.

### `complete` — AI 완료, 검토 대기

AI가 작업을 완료했지만 아직 사용자가 결과를 확인하지 않은 상태다. opencode 세션이 종료되거나 작업이 완료 처리되면 이 상태로 전환된다. 사용자가 결과를 확인하고 최종 승인을 내리기 전까지 이 컬럼에 머문다.

### `done` — 완료

사용자가 결과를 확인하고 최종 완료 처리한 상태다. 이 컬럼의 카드는 아카이브로 이동할 수 있다.

---

## 카드 구조

카드는 `src/core/types.ts`의 `KanbanCard` 인터페이스로 정의된다. 상태, 세션, parent-child, feedback, queue, screenshot, Telegram 컨텍스트를 함께 담는다.

### 식별자 필드

| 필드 | 타입 | 설명 |
|------|------|------|
| `id` | `string` | UUID, 카드 생성 시 자동으로 부여된다. |
| `messageId` | `string` (선택) | 메시지 ID. `chat.message` 훅에서 중복 카드 생성을 방지하는 데 사용된다. 같은 `messageId`를 가진 카드가 이미 존재하면 새 카드를 만들지 않는다. |
| `sessionId` | `string` (선택) | runtime별 actual continuation id. `opencode`는 opencode session id, `codex`는 `thread_id`, `claude`는 `session_id`다. 하나의 세션에 여러 카드가 속할 수 있으며, `findCardBySessionId()`는 가장 최근에 생성된 카드를 반환한다. |
| `sessionTitle` | `string` (선택) | 세션 제목. Telegram/웹 UI 표시용이다. |
| `sessionCreatedAt` | `string` (선택) | 세션 생성 시각. |

### 내용 필드

| 필드 | 타입 | 설명 |
|------|------|------|
| `title` | `string` | 카드 제목. 자동 생성 시 첫 번째 사용자 메시지에서 추출되며, 시스템 마커는 제거된다. |
| `description` | `string` | 카드 설명. 필수 필드다. 비어 있을 수 없다. 디스패치 시 이 내용이 AI에게 전달되는 작업 프롬프트가 된다. |
| `status` | `KanbanStatus` | 현재 상태. `todo`, `in_progress`, `complete`, `done` 중 하나다. |
| `progressSummary` | `string` (선택) | 작업 진행 상황 요약. 세션 중간에 업데이트될 수 있다. |
| `result` | `string` (선택) | 작업 최종 결과. 작업이 완료된 후 기록된다. 동일 세션 최신 카드에 대체된 카드에는 `Superseded` 안내와 최종 결과 카드 ID가 기록될 수 있다. |
| `resolution` | `completed \| superseded` (선택) | `session.idle` 완료 분류 메타데이터. 최신 완료 카드는 `completed`, 대체된 카드는 `superseded`로 기록된다. |
| `supersededByCardId` / `supersededAt` | 선택 | `resolution=superseded`일 때 어떤 카드로 대체됐는지와 시점을 기록한다. |

### 컨텍스트 필드

| 필드 | 타입 | 설명 |
|------|------|------|
| `projectDir` | `string` (선택) | 프로젝트 디렉토리 경로. 디스패치 시 AI가 작업할 디렉토리를 지정하는 데 사용된다. |
| `model` | `string` (선택) | 카드와 연결된 세션에서 사용된 AI 모델 이름. |
| `agentRuntime` | `opencode \| codex \| claude` (선택) | 실행 runtime. legacy card처럼 값이 없으면 `opencode`로 취급한다. |
| `codexOptions` | `CodexOptions` (선택) | Codex dispatch 옵션. `reasoningEffort`, `sandbox`, `skipGitRepoCheck`를 담는다. |
| `command` | `string` (선택) | 카드 생성에 사용된 슬래시 커맨드. 예: `/start-work`. |
| `skills` | `string[]` (선택) | 도구나 수동 생성 경로에서 명시적으로 기록한 스킬 목록이다. `chat.message` 자동 생성 경로에서 항상 채워지는 필드는 아니다. |
| `sourceContext` | `string` (선택) | 소스 컨텍스트. 카드가 어떤 맥락에서 만들어졌는지 기록한다. |

### 계층 구조 필드

| 필드 | 타입 | 설명 |
|------|------|------|
| `parentCardId` | `string` (선택) | 부모 카드의 ID. 서브에이전트 카드에 자동으로 설정된다. 이 필드가 있으면 해당 카드는 다른 카드의 서브태스크다. |
| `agentType` | `string` (선택) | 에이전트 유형. 예: `explore`, `oracle`, `librarian`. 서브에이전트 카드에 자동으로 기록된다. |
| `feedbackForCardId` | `string` (선택) | feedback 카드가 어떤 원본 카드에 대한 재작업인지 나타낸다. feedback session reuse의 기준 필드다. |

### 큐 필드

| 필드 | 타입 | 설명 |
|------|------|------|
| `queuedAfterCardId` | `string` (선택) | 큐에서 이 카드 앞에 있는 카드의 ID. 순차 실행 큐에서 사용된다. |
| `queuePosition` | `number` (선택) | 큐 내 위치 번호. 낮을수록 먼저 실행된다. |
| `queueSessionMode` | `new_session \| continue_queued_after_session` (선택) | queue로 시작될 때 새 세션을 열지, queued-after 카드 세션을 이어갈지 명시한다. |

### 카드 1회 예약 필드

| 필드 | 타입 | 설명 |
|------|------|------|
| `scheduledDispatch.scheduledAt` | `string` | 한 번만 자동 dispatch할 UTC 시각. UI는 항상 KST로 표시한다. |
| `scheduledDispatch.status` | `scheduled \| dispatching \| dispatched \| failed` | 예약 상태. `scheduled -> dispatching -> dispatched/failed`로 이동한다. |
| `scheduledDispatch.dispatchedAt` | `string` (선택) | runtime이 dispatch를 수락한 시각 |
| `scheduledDispatch.error` | `string` (선택) | 자동 dispatch 실패 이유 |
| `schedulerId` / `schedulerRunId` / `schedulerName` | 선택 | 반복 스케줄러가 만든 scheduler-origin 카드에만 채워진다. 카드 1회 예약과는 별도다. |

### 시각 필드

| 필드 | 타입 | 설명 |
|------|------|------|
| `createdAt` | `string` | 카드 생성 시각. ISO 8601 형식. 자동으로 기록된다. |
| `updatedAt` | `string` | 카드 마지막 수정 시각. ISO 8601 형식. 변경이 있을 때마다 갱신된다. |
| `dispatchType` | `instant \| manual` (선택) | Telegram 자동 디스패치 같은 instant flow를 구분한다. |
| `telegramChatId` | `number` (선택) | Telegram chat과 연결된 카드일 때 응답/후속 추적에 사용된다. |
| `screenshots` | `Screenshot[]` (선택) | 카드 첨부 스크린샷 목록이다. |
| `staleStatus` / `staleDetectedAt` | 선택 | orphan/stuck stale 상태 추적 필드다. 다만 top-level parent가 direct child 실행을 기다리는 동안에는 orphan stale을 보류한다. |

---

## 자동 카드 생성

opencode에서 새 세션이 시작되고 첫 번째 메시지가 전송되면 `chat.message` 훅이 실행된다. 이 훅은 메시지 내용을 바탕으로 카드를 자동으로 생성한다.

### 생성 과정

1. 메시지가 들어오면 훅이 `sessionId`, `messageId`, dispatch-tracker 상태를 확인한다.
2. 같은 `messageId`가 이미 처리됐거나 dispatch lifecycle 재생성으로 판단되면 카드를 새로 만들지 않는다.
3. 새 카드가 필요하면 sanitize된 제목/설명을 만들고 카드를 생성한다.
4. `sessionId`, `model`, `messageId`, 필요 시 `agentType`, `parentCardId`, `command`, `sourceContext`가 카드에 기록된다. `skills`는 자동 생성 경로의 기본 필드는 아니다.

### 콘텐츠 정제 (Sanitization)

자동 생성된 카드의 제목과 설명에서 시스템 마커가 자동으로 제거된다. opencode 내부에서 사용하는 특수 마커나 시스템 프롬프트 조각이 카드에 노출되지 않도록 정제 과정을 거친다.

### 서브에이전트 카드

알려진 서브에이전트 유형이 새 세션을 시작하면, 훅은 먼저 부모 카드를 찾는다. 부모가 잡히면 child 카드로 연결되고 제목은 `AgentName#N` 형식으로 자동 설정된다. 부모 후보가 없으면 top-level 카드로 남는다.

`session.created` 이벤트로 child-session registry가 먼저 등록되면, 이 명시적 parent mapping이 project heuristic보다 우선한다. registry가 stale이면 제거 후 fallback 규칙이 다시 적용된다.

---

## 작업 큐 (Task Queue)

TODO 상태의 카드를 순서대로 자동 실행하는 큐 시스템이 내장되어 있다.

### 큐 구성 방식

카드를 큐에 넣을 때 `queuedAfterCardId`, `queuePosition`, `queueSessionMode`를 설정한다. `queuedAfterCardId`는 이 카드 앞에서 실행되어야 할 카드의 ID고, `queuePosition`은 전체 큐에서의 위치 번호다. 위치 번호가 낮을수록 먼저 실행된다. `queueSessionMode`는 실행 시 새 세션을 열지, 이전 카드 세션을 이어갈지 결정한다.

### 자동 디스패치

현재 진행 중인 카드가 완료 상태로 전환되면, 다음 큐 위치의 카드가 자동으로 디스패치된다. 이를 통해 여러 작업을 순서대로 자동 실행할 수 있다. 이때 session mode가 `continue_queued_after_session`이면 바로 앞 카드가 이미 실행을 마친 경우에만 같은 세션을 재사용하고, 아직 진행 중이거나 세션 정보가 없으면 새 세션으로 fallback한다.

### 큐 순서 유지

`getQueuedCards()`는 `queuePosition` 기준으로 정렬된 카드 목록을 반환한다. `getNextQueuePosition()`은 새 카드를 큐에 추가할 때 올바른 위치 번호를 계산한다. 큐는 TODO 컬럼 내 드래그 앤 드롭으로도 순서를 조정할 수 있다.

선행 카드가 `session.idle`을 통해 `complete`로 전환되면, 그 카드 뒤에 queue된 `todo` 카드 중 가장 앞선 카드 하나를 자동으로 dispatch한다.

## 카드 1회 예약 (Scheduled Dispatch)

top-level `todo` 카드 하나를 **미래의 KST 시각에 한 번만** 자동 dispatch하는 기능이다. 반복 실행이 필요하면 스케줄러를 쓰고, 카드 하나를 정확히 한 번 시작하려면 이 기능을 쓴다.

예시:

- `2026-07-18 09:30 KST`에 카드 하나만 시작하려면 card schedule
- 평일마다 `09:30 KST`에 같은 작업을 만들려면 scheduler

### 동작 규칙

- 예약 가능한 카드는 top-level `todo` 카드뿐이다.
- queued 카드(`queuedAfterCardId`가 있는 카드)는 예약할 수 없다.
- 예약된 카드(`scheduled`/`dispatching`)는 Queue에 넣을 수 없다.
- `Start Now`는 현재 예약을 **소비**하고 즉시 dispatch한다.
- background due scan과 `Start Now`가 경합해도 dispatch는 한 번만 일어난다.
- `dispatching` 상태에서 프로세스가 죽어도 재시작 시 stale claim이 복구되고 overdue 카드는 다시 한 번만 scan된다.
- dispatch 실패 시 카드는 `todo`로 남고 `progressSummary`에 `[failed] ...` 흔적이 남으며, 예약 상태는 `failed`가 된다.

### 상태 예시

1. `2026-07-17`에 카드 B를 만들고 `2026-07-18 09:35 KST`로 예약한다.
2. `2026-07-18 09:35 KST`가 되면 singleton runtime owner가 claim을 잡고 `dispatching`으로 바꾼다.
3. runtime이 수락하면 카드 상태는 `in_progress`, 예약 상태는 `dispatched`가 된다.
4. 사용자가 `2026-07-18 09:34:59 KST`에 `Start Now`를 눌렀다면 같은 예약을 먼저 소비하므로 due scan은 중복 dispatch하지 않는다.

---

## 카드 디스패치

디스패치는 TODO 카드를 실제 runtime 세션으로 실행하는 과정이다. runtime 선택은 `agentRuntime`으로 결정하며, 값이 없으면 `opencode` adapter를 사용한다.

### 동작 방식

`dispatchCard()` 함수가 실행되면 다음 순서로 진행된다.

1. 카드의 `description`이 작업 프롬프트로 사용된다.
2. `projectDir`이 설정되어 있으면 해당 디렉토리에서 세션이 시작된다.
3. feedback 카드면 `feedbackForCardId`를 따라 원본 session을 우선 재사용한다. 그렇지 않으면 일반 카드는 새 세션을 만들고, queue session mode가 `continue_queued_after_session`인 queued 카드만 queued-after 카드 session을 재사용할 수 있다.
4. runtime registry가 `opencode`, `codex`, `claude` adapter 중 하나를 선택한다.
5. opencode adapter는 카드 상태와 `sessionId`를 먼저 `in_progress`로 업데이트하고 dispatch-tracker를 등록한 뒤 prompt를 전송한다. 이 순서(`store.updateCard -> trackDispatch -> promptAsync`)는 hook race로 인한 중복 카드 생성을 막는 불변식이다.
6. Codex/Claude adapter는 실제 continuation id를 stdout stream에서 확보한 뒤에만 card `sessionId`를 저장하고 dispatch response를 반환한다.
7. 이때 stale/orphan 플래그가 남아 있었다면 dispatch 시 함께 초기화된다.

성공 응답은 항상 `{ sessionId, runId, startedAt }` shape다. `runId`는 `RuntimeRunStore` run artifact를 찾는 키이고, `sessionId`는 후속 실행에 쓰는 continuation id다.

### Runtime별 continuation id

| Runtime | `sessionId` 의미 | Resume 방식 |
|---------|------------------|-------------|
| `opencode` | opencode session id | opencode SDK session reuse |
| `codex` | Codex `thread_id` | `codex exec resume <threadId>` |
| `claude` | Claude `session_id` | Claude `--resume <sessionId>` |

Codex/Claude는 actual id 확보 전까지 `sessionId`를 저장하지 않는다. `runId`, `pending-*`, 빈 문자열은 `sessionId` 대체값이 될 수 없다.

### 실패 처리

runtime 실행이 실패하거나 Codex `thread_id` / Claude `session_id` timeout이 발생하면 card는 `todo`로 돌아간다. `progressSummary`에는 `[failed] ...` 형태의 실패 요약이 남아 사용자가 같은 card를 다시 시작할 수 있다.

Codex/Claude run artifact는 `KANBAN_DATA_DIR/runtime-runs/<runId>/` 아래에 보관된다. `runs.json`은 전체 run index이고 각 run directory에는 `prompt.md`, `events.jsonl`, `stderr.log`, `last-message.md`가 남는다.

## stale 표시

- `Signal Lost` / `Stalled` 배지는 `in_progress` 카드에서만 표시된다.
- `StaleCardChecker`는 opencode native session list를 legacy/opencode card에만 적용한다.
- Codex/Claude의 stale run은 `RuntimeRunStore.reconcileStale(store)`가 plugin start 시 failed run으로 정리하고 card를 `todo`로 되돌린다.
- top-level parent 카드에 direct child/subagent 카드가 아직 `in_progress`이면 parent는 stale/orphan(`Signal Lost`) 대상으로 보지 않는다.
- 따라서 `Complete`나 `Done` 컬럼에서는 stale 빗금과 배지가 더 이상 보이지 않는다.

### 디스패치 조건

카드가 디스패치되려면 `description`이 있어야 한다. 설명이 없으면 AI에게 전달할 작업 내용이 없으므로 디스패치가 의미를 잃는다.

---

## 아카이브

완료된 카드를 보드에서 제거하고 월별 파일로 보관하는 기능이다.

### 아카이브 구조

아카이브 파일은 기본적으로 `~/.agent-kanban/archive/` 디렉토리에 `YYYY-MM.json` 형식으로 저장된다. `KANBAN_DATA_DIR`을 설정한 경우 해당 경로가 우선한다. 예를 들어 2026년 2월에 아카이브된 카드는 `~/.agent-kanban/archive/2026-02.json`에 저장된다.

### 아카이브 과정

`done` 상태의 카드만 아카이브할 수 있다. 아카이브가 실행되면 카드가 활성 보드(`active.json`)에서 제거되고 해당 월의 아카이브 파일에 추가된다. 이미 해당 월의 아카이브 파일이 존재하면 카드가 추가되고, 없으면 새 파일이 만들어진다.

아카이브는 보드를 깔끔하게 유지하는 데 유용하다. 오래된 완료 작업을 보드에서 제거하면서도 기록은 파일 시스템에 보존된다.

---

## 완료 전환과 결과 기록

`session.idle` 이벤트는 아무 때나 카드를 완료시키지 않는다. 현재 프로세스에서 실제 세션 활동이 관측된 경우에만, 같은 세션의 `in_progress` 카드를 completion 대상으로 본다.

- 같은 세션의 `in_progress` 카드가 여러 장이면 모두 `complete`로 전환된다.
- 이때 최신 카드는 `resolution=completed`로 최종 결과를 갖고, 이전 카드들은 `resolution=superseded` + `supersededByCardId`로 대체 처리된다.
- 대체된 카드의 `result`에는 사용자 인지를 위한 `Superseded` 안내와 최종 결과 카드 ID가 포함된다.

- top-level parent 카드에 직접 연결된 child/subagent 카드가 아직 `in_progress`면 parent 완료를 보류한다.
- child가 더 이상 `in_progress`가 아니면 이후 idle 재평가에서 parent가 완료될 수 있다.
- 같은 이유로, direct child가 아직 `in_progress`인 top-level parent는 stale/orphan(`Signal Lost`) 표시도 보류된다.

- 일반 카드는 idle 전환 시 description sanitize가 보정될 수 있다.
- feedback 카드는 wrapper 텍스트를 유지해야 하므로 sanitize 예외다.
- 중복 `session.idle` 이벤트는 idempotent해야 한다.

## Telegram follow-up / feedback 흐름

- Telegram에서 이미 선택된 session이 있으면 일반 텍스트 후속 메시지는 기존 session으로 전달된다.
- selected session은 runtime metadata를 함께 가진다. runtime-aware follow-up 정책은 opencode/Codex/Claude session을 각각 올바른 runtime adapter로 resume하는 것이다.
- 현재 안전 가드는 Telegram `/sessions` 후보를 opencode session으로 제한한다. Codex/Claude selected-session follow-up을 릴리즈하려면 `src/plugin/telegram-poller.ts`의 opencode-only 필터와 invalid 처리, adapter resume 테스트를 함께 갱신해야 한다.
- selected session이 stale/invalid이면 새 session을 몰래 만들지 않고 실패 응답을 보낸다.
- follow-up 성공 시에도 추적 가능성을 위해 새 `in_progress` 카드가 생성된다.
- `/new_session`은 selected session/card만 지우고 sticky default agent/model/runtime은 보존한다.
- `/claude_model_list`와 `/codex_model_list`는 현재 `src/core/runtime-config.ts`에 등록된 사용 가능 model id를 보여준다.
- `/claude_model <model id>`와 `/codex_model <model id>`는 정확히 등록된 id만 sticky default로 저장하며, 알 수 없는 id는 저장하지 않고 사용 가능한 목록을 안내한다.
- feedback 카드는 description wrapper가 아니라 `feedbackForCardId`를 기준으로 원본 session을 찾는다.

## 서브태스크 계층

카드는 부모-자식 관계를 가질 수 있다. 서브에이전트가 생성한 카드가 자동으로 부모 카드에 연결되는 방식이다.

### 알려진 서브에이전트 유형

다음 에이전트 유형은 서브에이전트로 인식된다.

- `explore`
- `librarian`
- `oracle`
- `plan`
- `metis`
- `momus`
- `multimodal-looker`
- `sisyphus-junior`

이 목록에 없는 유형(`build`, `general`, 또는 유형이 지정되지 않은 경우)은 최상위 카드로 생성되며 `parentCardId`가 설정되지 않는다.

### 부모 카드 탐색 순서

서브에이전트 카드가 생성될 때 부모 카드를 찾는 우선순위는 다음과 같다.

1. `session.created`로 등록된 explicit child-session registry
2. 같은 세션에서 `in_progress` 상태인 카드
3. 같은 세션에서 활성 컨텍스트 카드
4. 같은 프로젝트에서 `in_progress` 상태인 카드
5. 같은 프로젝트에서 활성 상태인 카드

이 순서대로 후보를 찾아 부모를 지정한다. same-session active parent는 same-project parent보다 우선한다.

### 서브태스크 제목 형식

부모 카드가 잡힌 서브에이전트 카드의 제목은 `AgentName#N` 형식으로 자동 설정된다. 같은 부모 카드 아래에서 같은 유형의 에이전트가 여러 번 실행되면 번호가 순차적으로 증가한다. 예를 들어 첫 번째 `explore` 에이전트는 `Explore#1`, 두 번째는 `Explore#2`가 된다.
