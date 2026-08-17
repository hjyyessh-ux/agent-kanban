# 스케줄러

## 개요

스케줄러는 **반복 작업**을 KST 기준으로 실행하는 기능이다. 현재 action은 두 가지다.

- `bash`: `Bun.spawn(['bash', '-lc', ...])`로 직접 실행한다. LLM 토큰을 쓰지 않는다.
- `prompt`: 스케줄러가 **scheduler-origin `todo` 카드**를 먼저 만들고, 그 카드를 기존 runtime dispatch로 넘긴다. `agentRuntime`, `model`, `codexOptions`, `claudeOptions`를 함께 저장할 수 있다.

스케줄러 데이터는 기본적으로 `~/.agent-kanban/schedulers.json`에 저장된다. `KANBAN_DATA_DIR`을 설정한 경우 해당 경로가 우선한다. 칸반 보드와 동일한 원자적 쓰기(atomic write) 및 이중 잠금(dual locking) 방식으로 데이터 무결성을 보장한다. 스케줄러 엔진은 `croner`를 사용하며, singleton runtime owner에서만 활성화된다.

> [!important]
> **반복 스케줄러**와 **카드 1회 예약(Scheduled Dispatch)**은 다른 기능이다.
>
> - 스케줄러: `SchedulerEntry`가 cron에 따라 반복 실행된다.
> - 카드 1회 예약: 보드의 top-level `todo` 카드 하나를 `scheduledDispatch`로 **한 번만** 미래 시각에 자동 dispatch한다.
>
> 예를 들어 `2026-07-18 09:30 KST`에 한 번만 작업을 시작하려면 카드 예약을 쓰고,
> 매일 `09:30 KST`마다 같은 자동화를 돌리려면 스케줄러를 쓴다.

---

## 스케줄러 항목 구조

각 스케줄러 항목(`SchedulerEntry`)은 다음 필드로 구성된다.

| 필드 | 타입 | 필수 여부 | 설명 |
|------|------|-----------|------|
| `id` | `string` | 필수 | UUID, 자동 생성 |
| `name` | `string` | 필수 | 스케줄러 이름 |
| `description` | `string` | 필수 | 스케줄러 설명 |
| `cron` | `string` | 필수 | 5-field cron 표현식 (분 시 일 월 요일) |
| `cronDescription` | `string` | 선택 | cron 표현식의 사람이 읽기 쉬운 설명 |
| `scheduleInput` | `object` | 선택 | Create/Edit UI가 마지막 입력 모드와 값을 복원하기 위한 메타데이터 |
| `timezone` | `string` | 선택 | 항상 `"Asia/Seoul"`만 허용된다. 다른 값은 API/도구가 거부한다. |
| `status` | `'active' \| 'inactive'` | 필수 | 활성(active) 또는 비활성(inactive) 상태 |
| `action` | `SchedulerAction` | 필수 | 실행할 작업 (아래 참조) |
| `lastRunAt` | `string` | 선택 | 마지막 실행 시각 (ISO 8601) |
| `nextRunAt` | `string` | 선택 | 다음 실행 예정 시각 (ISO 8601) |
| `lastRunStatus` | `'success' \| 'failure'` | 선택 | 마지막 실행 결과 |
| `history` | `SchedulerRun[]` | 필수 | 실행 이력 목록 |
| `createdAt` | `string` | 필수 | 생성 시각 (ISO 8601) |
| `updatedAt` | `string` | 필수 | 마지막 수정 시각 (ISO 8601) |

### action 필드 상세

`action` 필드는 실행할 작업의 유형과 세부 내용을 담는다.

**bash 타입**

```json
{
  "type": "bash",
  "command": "echo hello"
}
```

| 필드 | 타입 | 설명 |
|------|------|------|
| `type` | `'bash'` | Bash 명령 실행 |
| `command` | `string` | 실행할 쉘 명령어 |
| `cwd` | `string` (선택) | 실행 작업 디렉토리 |
| `editState` | `'ready' \| 'edit-required'` (선택) | legacy 변환 항목 여부 |

**prompt 타입**

```json
{
  "type": "prompt",
  "prompt": "새벽 점검 결과를 요약하고 후속 작업 카드를 만들어 주세요.",
  "agentRuntime": "codex",
  "model": "gpt-5.4"
}
```

| 필드 | 타입 | 설명 |
|------|------|------|
| `type` | `'prompt'` | scheduler-origin 카드 생성 후 runtime dispatch |
| `prompt` | `string` | 카드 `description`으로 들어갈 프롬프트 본문 |
| `projectDir` | `string` (선택) | 카드/dispatch가 사용할 프로젝트 디렉토리 |
| `agentRuntime` | `opencode \| codex \| claude` (선택) | dispatch할 runtime |
| `model` | `string` (선택) | runtime model |
| `codexOptions` | 객체 (선택) | reasoning/sandbox 등 Codex 옵션 |
| `claudeOptions` | 객체 (선택) | permission mode 등 Claude 옵션 |
| `editState` | `'ready' \| 'edit-required'` (선택) | legacy 변환 항목 여부 |

---

## SchedulerRun 구조

각 실행 기록(`SchedulerRun`)은 다음 필드로 구성된다.

| 필드 | 타입 | 필수 여부 | 설명 |
|------|------|-----------|------|
| `id` | `string` | 필수 | 실행 ID (UUID) |
| `startedAt` | `string` | 필수 | 실행 시작 시각 (ISO 8601) |
| `finishedAt` | `string` | 선택 | 실행 완료 시각 (ISO 8601) |
| `status` | `'success' \| 'fail' \| 'running'` | 필수 | 실행 상태 |
| `stdout` | `string` | 선택 | bash stdout (8KB cap) |
| `stderr` | `string` | 선택 | bash stderr (8KB cap) |
| `error` | `string` | 선택 | 실행 실패 메시지 |
| `exitCode` | `number` | 선택 | 프로세스 종료 코드 |
| `cardId` | `string` | 선택 | prompt action이 만든 board card ID |
| `dispatched` | `boolean` | 선택 | prompt action이 runtime dispatch를 접수했는지 |
| `dispatchAcceptedAt` | `string` | 선택 | runtime이 dispatch를 수락한 시각 |

---

## 스케줄 입력 모드

Scheduler modal은 Schedule 필드를 두 가지 모드로 나눠 보여 준다. 두 모드 모두 **Asia/Seoul(KST) 고정**이며, UI preview와 서버 POST/PATCH는 같은 core helper로 동일한 결과를 만든다.

### 1. 간편 설정

- 반복 단위와 KST 시각을 구조화된 control로 선택한다.
- 지원 preset:
  - `매 N분`
  - `매 N시간`
  - `매일 HH:MM`
  - `평일 HH:MM`
  - `요일 지정 HH:MM`
- 입력 즉시 read-only cron preview를 생성한다.
- 이 상태에서 `Cron 직접 입력`으로 전환하면 방금 생성된 cron이 그대로 채워진다.
- 예시:
  - `매 5분` → `*/5 * * * *`
  - `매일 09:30` → `30 9 * * *`
  - `평일 09:00` → `0 9 * * 1-5`
  - `월요일 09:00` → `0 9 * * 1`

### 2. Cron 직접 입력

- 5-field cron만 받는다. 형식은 `minute hour day month weekday`다.
- field hint와 KST 실행 설명을 함께 보여 준다.
- 복잡한 cron은 이 모드에서 그대로 보존된다.
- 간편 설정으로 표현 가능한 cron이면 `간편 설정`으로 돌아갈 때 repeat/hour/minute 값이 복원된다.
- 초 단위/6-field 표현식은 허용하지 않는다.

> 과거에 있던 `규칙 기반 문장 입력`(자연어→cron) 모드는 제거됐다. 문장 입력이 필요한 자연어 변환은 plugin tool(`scheduler_create`/`scheduler_update`)의 cron 인자 정규화에만 남아 있다.

---

## Cron 표현식 형식

cron 표현식은 5개의 필드로 구성되며, 각 필드는 공백으로 구분된다.

```
분 시 일 월 요일
```

| 필드 | 허용 범위 | 설명 |
|------|-----------|------|
| 분 | 0-59 | 실행할 분 |
| 시 | 0-23 | 실행할 시각 |
| 일 | 1-31 | 실행할 날짜 |
| 월 | 1-12 | 실행할 월 |
| 요일 | 0-6 | 실행할 요일 (0=일요일, 1=월요일, ..., 6=토요일) |

### 특수 문자

| 문자 | 의미 | 예시 |
|------|------|------|
| `*` | 모든 값 | `* * * * *` = 매 분마다 |
| `*/N` | N 간격 | `*/15 * * * *` = 15분마다 |
| `,` | 목록 | `0 9,18 * * *` = 09:00과 18:00 |
| `-` | 범위 | `0 9 * * 1-5` = 평일 09:00 |

### 자주 쓰는 표현식 예시

| cron 표현식 | 실행 주기 |
|-------------|-----------|
| `* * * * *` | 매 분마다 |
| `*/5 * * * *` | 5분마다 |
| `0 * * * *` | 매 정각 |
| `0 9 * * *` | 매일 09:00 |
| `0 9 * * 1-5` | 평일 09:00 |
| `0 9 * * 1` | 매주 월요일 09:00 |
| `0 0 1 * *` | 매월 1일 00:00 |
| `0 0 * * 0` | 매주 일요일 00:00 |

---

## 실행 정책

## Create/Edit 복원

- `scheduleInput` 메타데이터가 있으면 마지막으로 사용한 입력 모드와 값이 그대로 복원된다.
- legacy/기존 항목처럼 메타데이터가 없더라도, 다음 cron 패턴은 간편 설정으로 역추론된다.
  - `*/N * * * *`
  - `M */N * * *`
  - `M H * * *`
  - `M H * * 1-5`
  - `M H * * <0-6>`
- 그 외 cron은 `Cron 직접 입력` 모드로 복원된다.

---

## 실행 정책

### bash

`bash` action은 `command`를 그대로 실행한다. `cwd`가 있으면 해당 디렉토리에서 실행하고, 설정 저장소의 key/value는 Script 실행기와 같은 environment helper로 주입된다. `PATH`, interpreter/system/internal key와 `AK_PARAM_*` 같은 reserved 충돌은 주입하지 않는다. masked Settings 값은 stdout/stderr/error와 history에 저장하기 전에 `[REDACTED]` 처리하며 출력은 UTF-8 기준 8KB로 제한한다.

예시:

- `0 9 * * *` + `bash`: 매일 오전 9시(KST)에 `bun test` 실행
- `*/30 * * * *` + `bash`: 30분마다 로그 정리 스크립트 실행

### prompt

`prompt` action은 먼저 `SchedulerRun.id`를 만들고, 그 값을 `card.schedulerRunId`에 저장한 **scheduler-origin 카드**를 만든다. 그 뒤 일반 board dispatch와 같은 runtime 경로를 호출한다.

- dispatch 접수 성공: `run.dispatched=true`, `run.cardId=<생성 카드 ID>`, `dispatchAcceptedAt` 기록
- dispatch 접수 실패: run은 `fail`, 생성된 카드는 `todo` + `[failed] ...` 흔적과 함께 남는다
- 실제 작업 완료/실패 추적은 `SchedulerRun`이 아니라 생성된 board card가 담당한다

예시:

- `0 11 * * *` + `prompt/codex`: 매일 오전 11시(KST)에 Codex runtime으로 점검용 카드 생성
- `0 18 * * 1-5` + `prompt/claude`: 평일 오후 6시(KST)에 Claude runtime으로 리포트 카드 생성

### 카드 1회 예약과 충돌 정책

카드 1회 예약(`scheduledDispatch`)은 스케줄러와 별개로 top-level `todo` 카드에 붙는다.

- queued 카드(`queuedAfterCardId`가 있는 카드)는 예약할 수 없다
- 예약된 카드(`scheduled`/`dispatching`)는 Queue에 넣을 수 없다
- `Start Now`는 기존 예약을 **소비**하고 즉시 한 번만 dispatch한다
- background due scan과 `Start Now`가 동시에 들어와도 store claim 덕분에 dispatch는 한 번만 일어난다
- stale `dispatching` claim은 재시작 후 복구된다

예시:

- `2026-07-18 09:30 KST`에 카드 A를 예약했고, 사용자가 `2026-07-18 09:29:59 KST`에 `Start Now`를 눌렀다면 예약은 즉시 `dispatched`로 소비되고 due scan은 같은 카드를 다시 실행하지 않는다.
- `2026-07-18 09:30 KST`가 지난 뒤 프로세스를 재시작해도 overdue 예약 카드는 startup scan에서 한 번만 dispatch된다.

---

## 실행 이력

스케줄러가 실행될 때마다 실행 기록이 생성된다. 각 기록에는 시작/완료 시각, 실행 상태, stdout/stderr 출력, 프로세스 종료 코드가 포함된다. 기록은 `schedulers.json` 파일 내 해당 스케줄러 항목에 인라인으로 저장된다.

실행 이력은 UI의 `SchedulerHistoryPanel` 컴포넌트에서 확인할 수 있다. 각 스케줄러 항목마다 최근 N건의 실행 이력이 보존된다.

실행 이력에서 확인할 수 있는 정보:
- 실행 시작 및 완료 시각
- 성공/실패/실행 중 상태
- stdout 출력 내용
- 오류 메시지(있는 경우)
- 프로세스 종료 코드
- cron 자동 실행인지 수동 실행인지 여부

---

## 활성/비활성 토글

각 스케줄러는 `active`(활성) 또는 `inactive`(비활성) 상태를 가진다.

**활성 상태(active)**
- cron 스케줄에 따라 자동으로 실행된다.
- 스케줄러 엔진이 해당 항목의 cron 표현식을 감시하고 실행을 트리거한다.

**비활성 상태(inactive)**
- 자동 실행이 중단된다.
- 스케줄러 설정(cron, action, description 등)은 그대로 유지된다.
- 언제든지 다시 활성화할 수 있다.

토글은 plugin tool 또는 HTTP API를 통해 수행할 수 있다. 비활성화된 스케줄러도 수동 실행(manual trigger)은 가능하다.
