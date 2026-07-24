# 예약 디스패치·스케줄러 UI 핸드오프

## 개요

이 문서는 `feat/card-scheduled-dispatch` 브랜치에서 진행한 다음 두 범위의 구현과 검증 상태를 다음 세션에 인계한다.

1. 카드 1회성 KST 예약 디스패치와 반복 Scheduler의 Bash/Agent prompt 실행
2. Scheduler와 New Task의 선택 UI, 반응형 레이아웃, 예약 생성 및 Cron 입력 UX 마감

작성 시점은 2026-07-17이며, 두 작업 큐의 카드 10개는 모두 `complete` 상태다. 변경은 아직 커밋되지 않았다. 다음 세션은 구현을 다시 시작하지 말고 이 문서와 diff를 읽은 뒤 코드 리뷰·화면 점검·최종 커밋 여부 판단부터 진행한다.

## 현재 Git 상태

- 브랜치: `feat/card-scheduled-dispatch`
- 기준점: 작업 시작 당시 최신 `origin/main`의 `c50b331`
- 상태: dirty worktree, tracked/untracked 변경이 함께 있음
- 규모: 53개 파일, 약 `+4770 / -1349`
- 주의: 모든 변경은 작업 큐가 순차적으로 같은 dirty tree 위에 누적한 것이다. 파일을 되돌리거나 다른 브랜치로 전환하지 않는다.

다음 세션 시작 직후 확인한다.

```bash
git branch --show-current
git status --short
git diff --stat
git diff -- src/core/types.ts src/core/store.ts src/core/scheduling.ts
git diff -- src/plugin/scheduled-dispatch-service.ts src/plugin/scheduler-engine.ts
git diff -- web/src/components/Card/CreateCardDialog.tsx
git diff -- web/src/components/Scheduler/SchedulerJobModal.tsx
```

## 작업 카드 상태

### 1차 기능 구현 큐

| 순서 | 카드 ID | 제목 | 상태 |
|---|---|---|---|
| 1 | `zUK8gw6v6zG51PRfSrqDv` | 예약 디스패치·스케줄러 통합 도메인 계약 설계 | complete |
| 2 | `h5adkNL8gzIsqKvkWHYo3` | KST 예약 디스패처와 Bash·Prompt 스케줄러 엔진 구현 | complete |
| 3 | `0x1xlJtYYpE1oUFowXio8` | 예약 디스패치·스케줄러 REST 및 웹 훅 계약 연결 | complete |
| 4 | `GWX7y-mK_m54v37C0fPps` | 스케줄러 탭을 Bash·Prompt·KST 중심으로 재설계 | complete |
| 5 | `tUNwQ5XsN7hny_ZcRYpAR` | 메인보드 카드 예약 메뉴·KST 다이얼로그·아이콘 구현 | complete |
| 6 | `APvn1dUMFL12YngbCClau` | 예약 실행 통합 회귀·E2E·문서 및 불변식 마감 | complete |

### 2차 디자인 마감 큐

| 순서 | 카드 ID | 제목 | 상태 |
|---|---|---|---|
| 1 | `BCLg7oWf0wO-7Jhy33khV` | 스케줄러 모달 선택 UI·비율·런타임 레이아웃 개선 | complete |
| 2 | `cSw8qK-1PpsQeWuDwbCTg` | New Task에 실행 시점·KST 예약 생성 UX 통합 | complete |
| 3 | `89mKpy62JiaIYUTl1yP4D` | Cron 입력을 간편 설정·직접 입력 UX로 명확화 | complete |
| 4 | `nEbJfDmROTVCfGtSMErLj` | 스케줄러·New Task 반응형 시각 회귀와 디자인 마감 | complete |

로컬 agent-kanban 서버가 실행 중이면 `GET http://127.0.0.1:24680/api/cards`에서 카드 결과 전문과 세션 ID를 확인할 수 있다. 카드 상태는 Git에 포함되지 않고 `~/.agent-kanban/`에 저장된다.

## 구현된 사용자 경험

### 메인보드 카드 예약

- top-level `todo` 카드를 KST 기준 미래 시각에 한 번만 자동 디스패치할 수 있다.
- 예약된 카드에는 작은 calendar/clock 아이콘과 `예약됨 · YYYY-MM-DD HH:mm KST` 접근성 라벨이 표시된다.
- 카드에서 `Schedule`, `Reschedule`, `Cancel schedule`, `Start Now`를 사용할 수 있다.
- `Start Now`와 background due tick이 경합해도 store의 atomic claim을 통과한 한 경로만 디스패치한다.
- 예약과 Queue는 상호 배타적이다. 충돌 시 기존 값을 조용히 지우지 않고 UI와 서버가 이유를 반환한다.
- 재시작 후 이미 시간이 지난 예약은 singleton runtime owner가 다시 찾아 실행한다.
- 실패한 예약은 카드가 `todo`에 남고 오류와 실패 상태를 보존하며 무한 자동 재시도하지 않는다.

### New Task 예약 생성

`CreateCardDialog`에 실행 시점 선택이 추가됐다.

- `나중에 직접 시작` → `CREATE`
- `지금 시작` → `CREATE & START`
- `예약 시작` → `CREATE & SCHEDULE`

예약 시작을 선택하면 KST datetime 입력, 현재 KST, 읽기 쉬운 preview와 미래 시각 validation이 inline으로 나타난다. 예약과 Queue After는 동시에 선택할 수 없다. 카드 생성과 예약 정보는 `CreateCardInput.scheduledDispatch`를 통해 원자적으로 저장되므로 카드만 생성되고 예약이 누락되는 중간 상태를 피한다.

### 반복 Scheduler

- 모든 cron은 `Asia/Seoul`로 고정된다.
- 실행 유형은 `Bash command`와 `Agent prompt`다.
- Bash는 command, cwd, 설정 환경 변수, exit code, stdout/stderr 8KB cap을 지원한다.
- Agent prompt는 project directory, runtime, model 및 Codex/Claude 옵션을 저장한다.
- Prompt 실행 시 SchedulerRun ID를 먼저 만들고 `originChannel: scheduler`, `schedulerId`, `schedulerRunId`, `schedulerName`을 가진 보드 카드를 생성한 뒤 기존 runtime dispatch 경로로 전달한다.
- Scheduler history의 `cardId`로 생성된 카드와 실행 기록을 연결한다. Scheduler의 dispatch 접수와 카드의 실제 완료 상태는 별개다.
- legacy `shell`은 Bash로 정규화한다. 항상 실패하던 legacy `skill`은 자동 LLM 실행으로 바꾸지 않고 비활성 `편집 필요`로 처리한다.

### Cron 입력 방식

Scheduler 입력은 세 모드로 구분된다.

1. `간편 설정`: 반복 단위·요일·KST 시각을 구조화된 control로 선택
2. `Cron 직접 입력`: 5-field cron을 직접 입력
3. `규칙 기반 문장 입력`: 한/영 정규식 규칙으로 자연어를 cron으로 변환

규칙 기반 문장 입력은 AI/LLM이나 모델 프롬프트를 사용하지 않으며 토큰도 소비하지 않는다. 예를 들어 `매 5분마다`, `매일 09:30`, `매주 월요일`, `every 2 hours`를 결정론적으로 변환한다. 지원하지 않는 복잡한 문장과 초 단위 입력은 명확히 거부하고 Cron 직접 입력으로 안내한다.

### Scheduler 디자인 마감

- 검은 pill 선택 UI를 `Bash command` / `Agent prompt` 2열 selector card로 교체했다.
- 존재하지 않던 `--kv2-control-selected-text` 참조를 제거했다.
- 선택 상태는 semantic surface, border, check 표시와 읽을 수 있는 전경색을 사용한다.
- Runtime은 데스크톱에서 Codex/Claude/Opencode 3열 한 줄, Model은 다음 전체 행이다.
- 768px/390px에서만 명시적으로 1열로 전환하며 우발적으로 하나만 다음 줄로 떨어지지 않는다.
- Scheduler dialog desktop 폭은 약 900px이고 content scroll과 sticky footer를 분리했다.
- Name/Description만 2열이며 Schedule, 실행 유형, Runtime/Model은 전체 폭이다.
- Codex reasoning/sandbox는 desktop 2열이며 toggle option은 별도 행이다.

## 구현 파일 지도

### 공용 계약·저장소

- `src/core/types.ts`
  - `ScheduledDispatchState`
  - 카드 scheduler origin 메타데이터
  - Bash/Prompt `SchedulerAction`
  - Scheduler 입력 모드 메타데이터
- `src/core/scheduling.ts`
  - KST 상수와 datetime 변환/검증
  - 예약 상태 전이 helper
  - Scheduler action/입력 정규화
  - 간편 설정·raw cron·규칙 문장 공용 해석
- `src/core/store.ts`
  - create-with-schedule 검증
  - schedule/cancel/claim/recover/finalize
  - Queue 상호배타성과 atomic due claim
- `src/core/scheduler-store.ts`
  - legacy migration과 Scheduler 입력 모드 round-trip

### 실행·서버

- `src/plugin/scheduled-dispatch-service.ts`
  - singleton owner 전용 scan/tick/recovery/dispatch
- `src/plugin/bootstrap.ts`
  - runtime owner lifecycle에 service start/stop 연결
- `src/plugin/scheduler-engine.ts`
  - KST Croner job
  - Bash 실행
  - scheduler-origin 카드 생성과 Prompt dispatch
- `src/server/routes.ts`
  - `PUT/DELETE /api/cards/:id/schedule`
  - 예약 카드 수동 dispatch 단일 실행
  - create-with-schedule 검증
  - Scheduler Bash/Prompt 및 Cron 입력 검증
- `src/plugin/tools/scheduler_create.ts`, `scheduler_update.ts`
  - 변경된 tool schema와 string 반환 계약

### 웹 UI

- `web/src/App.tsx`
  - 예약 dialog orchestration과 Scheduler card navigation
- `web/src/components/Card/CreateCardDialog.tsx`
  - 3-way 실행 시점과 create/start/schedule flow
- `web/src/components/Card/ScheduleCardDialog.tsx`
  - 기존 카드 예약·변경 dialog
- `web/src/components/shared/ScheduledDispatchUi.tsx`
  - New Task와 Schedule dialog가 공유하는 KST editor/preview/validation
- `web/src/components/Board/BoardCardSections.tsx`
  - 예약 아이콘, scheduler-origin 아이콘, Schedule actions
- `web/src/components/Card/CardDetailDialog.tsx`
  - 예약 상태·시각·실패·변경·취소 표시
- `web/src/components/Scheduler/SchedulerJobModal.tsx`
  - 3종 Schedule 입력 모드와 Bash/Agent prompt form
- `web/src/components/shared/RuntimeModelFields.tsx`
  - runtime/model 공유 selector와 Scheduler layout variant
- `web/src/components/Scheduler/Scheduler.css`
  - Scheduler 화면 레이아웃과 반응형 규칙
- `web/src/styles/kv2/card-detail.css`, `primitives.css`
  - 공용 selector-card, Create Task 실행 시점, dialog width/sticky footer variant

## 중요 불변식

다음 항목은 리뷰 시 반드시 보존한다.

- 예약은 top-level `todo` 카드에만 등록된다.
- Queue와 예약은 동시에 존재하지 않는다.
- due tick과 수동 Start 경합은 정확히 한 번만 dispatch한다.
- runtime owner가 아닌 프로세스는 background 예약을 실행하지 않는다.
- dispatch 실패 시 카드는 `todo`와 원래 runtime/model/project/options를 유지한다.
- Prompt Scheduler가 만든 카드의 `sessionId`는 runtime의 실제 continuation ID다.
- Scheduler origin 정보와 SchedulerRun `cardId`가 서로 연결된다.
- KST 저장 입력은 UTC ISO로 정규화되고 표시는 KST로 돌아온다.
- 규칙 기반 Cron 변환은 모델을 호출하지 않는다.
- plugin tool은 `tool.schema`를 사용하고 항상 string을 반환한다.
- API 실패 응답은 `{ error: string }`이고 mutating route는 기존 auth/same-origin 정책을 지킨다.

자세한 내용은 `docs/invariants.md`를 함께 읽는다.

## 검증 상태

마지막 종합 카드 완료 시점의 결과다.

- `bunx tsc --noEmit`: 통과
- 관련 target `bun test`: 통과
- 전체 `bun test`: **982 pass, 0 fail**
- `bun run build`: 성공
- `bunx playwright test e2e/scheduled-dispatch.e2e.ts e2e/scheduler-dialog-layout.e2e.ts`: 통과
- `e2e/card-creation.e2e.ts`: 6/6 통과
- `web/src/styles/no-hardcoded-colors.test.ts`: 전체 테스트 안에서 통과

다음 세션의 권장 재검증 순서:

```bash
bunx tsc --noEmit
bun test src/__tests__/scheduling.test.ts \
  src/__tests__/schedule-routes.test.ts \
  src/__tests__/scheduled-dispatch-service.test.ts \
  src/__tests__/scheduler-engine.test.ts \
  src/__tests__/scheduler-store.test.ts \
  src/__tests__/store.test.ts
bun test web/src/components/Card/CreateCardDialog.test.tsx \
  web/src/components/Scheduler/SchedulerView.test.tsx \
  web/src/components/shared/ScheduledDispatchUi.test.ts \
  web/src/styles/no-hardcoded-colors.test.ts
bun run build
bunx playwright test e2e/card-creation.e2e.ts \
  e2e/scheduled-dispatch.e2e.ts \
  e2e/scheduler-dialog-layout.e2e.ts
```

전체 회귀가 필요하면 마지막에 `bun test`와 `bun run test:e2e`를 실행한다.

## 시각 캡처

최신 캡처는 `e2e/results/`에 있다.

### New Task 예약 UI

- `create-card-schedule-light-1440x1000.png`
- `create-card-schedule-dark-1440x1000.png`
- `create-card-schedule-light-1024x768.png`
- `create-card-schedule-dark-1024x768.png`
- `create-card-schedule-light-768x1024.png`
- `create-card-schedule-dark-768x1024.png`
- `create-card-schedule-light-390x844.png`
- `create-card-schedule-dark-390x844.png`

### Scheduler Prompt UI

- `scheduler-dialog-light-1440x1000.png`
- `scheduler-dialog-dark-1440x1000.png`
- `scheduler-dialog-light-1024x768.png`
- `scheduler-dialog-dark-1024x768.png`
- `scheduler-dialog-light-768x1024.png`
- `scheduler-dialog-dark-768x1024.png`
- `scheduler-dialog-light-390x844.png`
- `scheduler-dialog-dark-390x844.png`

`e2e/results/`는 Playwright 실행에 의해 정리될 수 있다. 현재 캡처를 보존해야 한다면 테스트를 다시 돌리기 전에 다른 위치로 복사한다. 이전 기능 점검 사진 13장은 Telegram 연결 채팅에도 두 개 앨범으로 전송했다.

## 알려진 제한·환경 경고

1. 로컬 Node는 `21.6.1`이다. Vite는 `20.19+` 또는 `22.12+`를 권장한다는 경고를 출력하지만 현재 빌드는 성공한다.
2. Vite chunk-size 경고가 남아 있다. 이번 예약/스케줄러 기능으로 새로 발생한 실패는 아니며 기능 검증을 막지 않는다.
3. 변경은 아직 커밋되지 않았다. 다음 세션이 리뷰 전에 전체 diff를 보존해야 한다.
4. 카드/실행 상태는 `~/.agent-kanban/`에 있으며 Git으로 전달되지 않는다. 코드 리뷰에는 영향 없지만 카드 결과 전문이 필요하면 로컬 서버가 실행 중이어야 한다.

## 다음 세션 리뷰 체크리스트

1. 이 문서, 루트 `AGENTS.md`, `docs/design-system.md`, `docs/invariants.md`를 읽는다.
2. dirty tree를 보존한 채 핵심 파일 diff를 검토한다.
3. `ScheduledDispatchState` 전이와 store atomic claim이 수동 dispatch 경로와 일치하는지 확인한다.
4. runtime owner 획득/상실 시 service start/stop이 대칭인지 확인한다.
5. Prompt Scheduler가 카드 생성 후 기존 dispatch 경로만 사용하는지 확인한다.
6. New Task의 3-way 실행 시점, Queue 상호배타성, create-with-schedule atomicity를 확인한다.
7. Scheduler 3종 입력 모드가 create/edit round-trip에서 값을 보존하는지 확인한다.
8. 최신 4개 viewport의 light/dark 캡처에서 선택 대비, 우발적 개행, overflow, sticky footer를 확인한다.
9. 위 권장 테스트를 재실행한다.
10. 문제가 없으면 변경을 논리적 커밋으로 나눌지 한 기능 커밋으로 합칠지 결정한다. 사용자 승인 없이 reset, checkout, rebase, force push를 하지 않는다.

## 2026-07-18 후속 수정 (커밋 직전 반영)

사용자 피드백으로 다음이 변경됐다. 위 본문 중 `실행 시점`·`규칙 기반 문장 입력` 관련 서술은 이 절이 우선한다.

- New Task의 `실행 시점` 섹션을 `Schedule`로 개명하고, Command/Queue After와 동일한 헤딩+헬퍼 설명 스타일을 적용했다.
- 라이트 모드에서 검게 보이던 활성 예약 토글 카드 배경을 `--kv2-surface-sunken` + selected border 조합으로 교체했다.
- Scheduler의 `규칙 기반 문장 입력` 모드를 UI·타입·서버 계약에서 제거했다. Schedule 입력은 `간편 설정` / `Cron 직접 입력` 2모드다.
- 저장된 legacy `rule` scheduleInput은 로드 시 cron에서 간편 설정을 유추하거나 cron 모드로 정규화된다.
- plugin tool(`scheduler_create`/`scheduler_update`)의 자연어 cron 정규화(`parseNaturalLanguageToCron`)는 유지된다.

## 다음 세션 시작 프롬프트 예시

```text
docs/HANDOFF-scheduled-dispatch.md를 먼저 읽고 현재 feat/card-scheduled-dispatch 브랜치의 dirty diff를 보존해.
구현을 다시 시작하지 말고 핸드오프의 리뷰 체크리스트 순서로 코드·UI·테스트를 점검해.
특히 예약 atomic claim, New Task create-with-schedule, Scheduler runtime 3열/모델 다음 행,
Cron 3모드 round-trip과 light/dark 4개 viewport를 확인한 뒤 문제와 수정 필요 여부를 보고해.
```
