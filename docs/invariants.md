# 워크플로 회귀 불변식

## 요약

이 문서는 사이드이펙트가 자주 나는 카드 워크플로를 회귀 관점에서 고정하는 기준이다.
새 기능을 추가하거나 기존 동작을 바꿀 때, 여기 있는 불변식과 대응 테스트를 같이 확인해야 한다.

> [!warning] 변경 규칙
> 아래 불변식과 연결된 파일을 수정하면 구현, 테스트, `AGENTS.md`, 관련 하위 `AGENTS.md`를 같은 변경 안에서 함께 갱신한다.

## 고위험 워크플로

| 영역 | 자주 깨지는 문제 | 기준 파일 | 주요 테스트 |
|------|------|------|------|
| 부모-자식 카드 | subagent 카드가 orphan으로 분리됨 | `src/plugin/hooks/chat-message.ts` | `src/__tests__/plugin-hooks.test.ts` |
| 완료 전환 | `in_progress` 카드가 `complete`로 넘어가지 않거나 잘못된 카드가 완료됨 | `src/plugin/hooks/event-handler.ts` | `src/__tests__/plugin-hooks.test.ts` |
| Telegram follow-up | 후속 메시지가 항상 새 세션으로 dispatch됨 | `src/plugin/telegram-poller.ts` | `src/__tests__/telegram-poller.test.ts` |
| Telegram agent/model | sticky default나 override가 예상과 다르게 바뀜 | `src/plugin/telegram-commands.ts`, `src/core/agent-config.ts`, `src/core/telegram-state-store.ts` | `src/__tests__/telegram-poller.test.ts`, `src/__tests__/telegram-state-store.test.ts` |
| Feedback 카드 | feedback wrapper가 sanitize되거나 원본 session 재사용이 깨짐 | `src/plugin/index.ts`, `src/plugin/hooks/event-handler.ts` | `src/__tests__/feedback-session-reuse.test.ts`, `src/__tests__/plugin-hooks.test.ts` |
| Runtime dispatch | runtime별 session id나 실패 복구 계약이 깨짐 | `src/core/types.ts`, `src/core/runtime-config.ts`, `src/plugin/runtimes/*`, `src/plugin/index.ts` | `src/__tests__/runtime-registry.test.ts`, `src/__tests__/dispatch-routing.test.ts`, `src/__tests__/codex-cli-adapter.test.ts`, `src/__tests__/claude-adapter.test.ts` |
| Quick Action dispatch | 재시도에서 카드/run이 중복 생성되거나 Script 파라미터·secret이 실행 경계를 우회함 | `src/core/quick-action-store.ts`, `src/core/store.ts`, `src/plugin/script-execution-service.ts`, `src/server/routes.ts`, `web/src/components/QuickActions/` | `src/__tests__/quick-action-store.test.ts`, `src/__tests__/quick-action-routes.test.ts`, `src/__tests__/script-execution-service.test.ts`, `e2e/quick-actions.e2e.ts` |
| 예약/스케줄 dispatch | due 카드가 중복 실행되거나 run↔card 연결이 끊김 | `src/core/store.ts`, `src/plugin/scheduled-dispatch-service.ts`, `src/plugin/scheduler-engine.ts`, `src/server/routes.ts` | `src/__tests__/scheduled-dispatch-service.test.ts`, `src/__tests__/scheduler-engine.test.ts`, `src/__tests__/store.test.ts` |
| Inbox triage 안전장치 | 배정 모달의 단축키가 포커스와 무관하게 발동해 오타 한 번이 세션을 영구 폐기하거나, 폐기한 세션에 복구 경로가 없거나, 종료된 Work에 세션이 새로 연결됨 | `web/src/components/Works/worksAssign.ts`(`resolveBulkAssignShortcut`), `BulkAssignModal.tsx`, `WorkAssignInline.tsx`, `src/core/work-store.ts`(`unignoreSession`), `src/server/routes.ts`, `web/src/hooks/useWorks.ts` | `web/src/components/Works/worksAssign.test.ts`, `src/__tests__/works-ignored-route.test.ts`, `src/__tests__/work-store.test.ts`, `e2e/works.e2e.ts` |
| Work 완료 라이프사이클 | Work 완료가 무관한 카드를(또는 즐겨찾기 카드를) archive하거나, 실행 중 카드를 archive하거나, 확인 없이 일괄 archive가 실행되거나, Work 단위 wiki 문서가 배치마다 쪼개짐 | `src/plugin/works/work-lifecycle.ts`, `src/plugin/works/work-links.ts`, `src/core/work-store.ts`, `src/core/work-errors.ts`, `src/plugin/works/works-config.ts`, `src/plugin/wiki/wiki-worker.ts`, `src/server/routes.ts`, `web/src/hooks/useWorks.ts`, `web/src/components/Works/WorkResolveConfirmDialog.tsx` | `src/__tests__/work-lifecycle.test.ts`, `src/__tests__/wiki-worker.test.ts`, `src/__tests__/work-store.test.ts`, `src/__tests__/works-config.test.ts`, `web/src/components/Works/worksAssign.test.ts`, `e2e/works.e2e.ts` |
| Work 재개 · 병합 | 재개가 archive된 카드를 되돌리지 못하거나 큐 자동 dispatch를 트리거하거나, `pending` wiki 스탬프를 남겨 다시 archive해도 큐에 안 들어가거나, 병합이 원본을 삭제하거나 대상의 `startedAt`을 락 밖에서 계산함 | `src/plugin/works/work-lifecycle.ts`(`reopenWork`), `src/core/store.ts`(`unarchiveCards`), `src/core/work-store.ts`(`mergeWork`), `src/core/work-errors.ts`, `src/server/routes.ts`, `web/src/hooks/useWorks.ts`, `web/src/components/Works/WorkMergeDialog.tsx` | `src/__tests__/works-reopen-merge-route.test.ts`, `src/__tests__/work-lifecycle.test.ts`, `src/__tests__/work-list.test.ts`, `web/src/components/Works/worksAssign.test.ts`, `e2e/works.e2e.ts` |
| 완료된 Work 되돌아보기 | 완료 후 Work 상세가 텅 비거나 카드/세션 딥링크가 404로 조용히 실패 | `src/core/timeline-aggregate.ts`, `src/core/store.ts`, `src/server/routes.ts`, `web/src/hooks/useWorkSessions.ts`, `web/src/App.tsx` | `src/__tests__/work-sessions-route.test.ts`, `e2e/works.e2e.ts` |

## 불변식 목록

### 카드 계층

- known subagent는 부모 후보를 찾았을 때 child 카드로 연결된다.
- parent가 잡힌 subagent 제목은 `AgentName#N` 형식이어야 한다.
- 같은 세션의 active parent가 있으면 same-project parent보다 우선한다.
- `session.created` 기반 child-session registry가 있으면 project heuristic보다 우선한다.
- registry가 stale이면 지우고 현재 waterfall 규칙으로 fallback한다.

### 완료 전환

- 카드의 Prompt 본문과 Result는 생성 경로(organic Claude/Codex 훅, 보드 runtime dispatch, opencode idle completion)에 관계없이 원문 전체를 저장해야 한다. 자동 생성 제목의 기존 120바이트 요약은 유지하되 본문이나 결과를 제목 길이에 맞춰 자르면 안 된다.
- Progress timeline은 모든 단계를 보존하고, tool detail/body도 원문 전체를 API에 반환해야 한다. UI의 접기/펼치기는 허용하지만 펼친 내용에서 단계나 문자열이 누락되면 안 된다.
- `session.idle`는 이 프로세스에서 실제 `chat.message` 활동이 관측된 세션만 완료 처리한다.
- 같은 session에 완료 가능한 `in_progress` 카드가 여러 장이면 `session.idle`에서 전부 `complete`로 전환하되, 가장 최신 완료 가능 카드는 `resolution=completed`, 이전 완료 가능 카드들은 `resolution=superseded`와 `supersededByCardId`를 기록한다.
- top-level parent 카드에 직접 연결된 child/subagent 카드가 `in_progress`이면 parent는 `session.idle`에서도 완료되지 않는다.
- top-level parent 카드에 직접 연결된 child/subagent 카드가 `in_progress`이면 parent는 stale/orphan(`Signal Lost`) 대상으로도 취급되지 않는다.
- 중복 `session.idle` 이벤트는 idempotent해야 한다.
- 일반 카드는 `session.idle` 시 sanitize 가능하지만, feedback 카드는 wrapper를 유지해야 한다.
- 카드가 `session.idle`로 `complete` 되면, 그 카드 뒤에 queue된 `todo` 카드 중 `queuePosition`이 가장 앞선 카드 하나만 auto-dispatch한다.
- queue된 카드가 `queueSessionMode = continue_queued_after_session`이면, queued-after 카드가 더 이상 `in_progress`가 아닐 때만 그 세션을 재사용하고 아니면 새 세션으로 fallback한다.

#### Claude organic CLI 완료 (`.claude/hooks/on-stop.sh`)

- Stop 시점에 이번 턴 카드를 `complete`로 닫되, **그 카드에 살아있는 background 작업이 있을 때만** defer(=`pending-<cardId>` stash)한다. defer 판정에 Stop 입력의 `background_tasks` 개수를 단독 기준으로 쓰지 않는다 — 그 값은 세션-전역이라, 무관한 좀비 teammate 슬롯 하나가 자식 없는 카드(plain prompt, scheduled wakeup)를 영구히 `in_progress`로 가둘 수 있다.
- "살아있는 background 작업"은 `background_tasks>0`을 전제로, 다음 둘 중 하나면 성립한다: (a) `in_progress` 직속 자식 카드가 있다(익명 async spawn이 아직 실행 중), 또는 (b) 이 카드가 subagent를 spawn했다는 `<cardId>.has-subagents` 마커가 있다(on-subagent-start.sh가 spawn 시 부모 카드 id로 남김). (b)가 필요한 이유: **named teammate는 턴마다 rest하고 그때마다 자식 카드가 `complete`로 뒤집히며, resume 시 다시 `in_progress`로 되돌리는 hook이 없다.** 따라서 (a)만으로는 rest 중인 teammate를 "끝남"으로 오판해 부모를 중간 메시지로 조기 완료시킨다. 마커는 `background_tasks>0`일 때만 작동하므로 자식 없는 카드는 영향받지 않는다.
- 자식 liveness는 store(`GET /api/cards?status=in_progress`에서 `parentCardId` 일치)로 판정하며, 서버 조회 실패 시 fail-closed(=defer)로 동작해 검증 불가 상태가 카드를 조기 완료시키지 않는다.
- subagent를 spawn한 부모 카드(`has-subagents` 마커 보유)는 완료해도 **트래킹 파일(`<session>.card-id`)을 삭제하지 않는다.** named teammate가 rest/resume하고 그 inter-agent 메시지가 main 세션의 추가 턴을 유발하는 동안 Stop이 계속 발생하므로, 트래킹 파일을 보존해 매 Stop이 카드를 최신 assistant 메시지로 **재완료(last-writer-wins)** 하게 한다 → 최종 턴(예: 마무리 요약)이 최종 결과로 수렴하고, defer 가드를 먼저 통과한 중간 메시지에 동결되지 않는다. (`on-subagent-realstop.sh`가 매핑을 보존하고 rest마다 자식을 재완료하는 것과 동일 패턴.) 자식 없는 카드는 후속 Stop이 없으므로 기존대로 즉시 트래킹 파일을 지운다. 보존된 파일은 다음 실제 프롬프트에서 on-prompt.sh가 덮어쓰거나 세션 종료 시 무해한 잔재로 남는다.
- defer된 카드는 후속 Stop의 drain 루프가 완료시킨다. drain 루프는 background task 잔존 여부와 무관하게(early-exit 앞에서) 항상 실행되어야 한다.

### Telegram 라우팅

- 일반 follow-up 메시지는 selected session이 있으면 기존 session으로 전달한다.
- selected session metadata에는 runtime을 함께 보관한다. runtime-aware follow-up이 활성화된 경로에서는 `opencode`는 opencode adapter, `codex`는 `codex exec resume <threadId>`, `claude`는 Claude `--resume <sessionId>`로 이어져야 한다.
- runtime-aware follow-up이 완전히 활성화되기 전에는 `/sessions` 후보를 opencode-only로 제한하고 Codex/Claude session을 몰래 새 session으로 fallback하지 않는다.
- selected session이 stale/invalid이면 새 session을 몰래 만들지 않고 명확한 실패 응답을 보낸다.
- follow-up 성공 시에도 traceability를 위해 새 in-progress 카드를 만든다.
- follow-up 카드는 선택된 session의 `projectDir`를 이어받고, 새 session/후속 전달 ACK에는 실제 적용 경로를 표시한다.
- follow-up 실패 시 selected session을 유지하고 새 session을 몰래 만들지 않는다.
- `/new_session`은 selected session/card만 지우고 sticky default agent/model/runtime/projectDir은 보존한다. `/directory` 기본값은 다른 경로를 지정하거나 `clear`하기 전까지 새 session에 유지된다.
- trailing agent command와 explicit agent command는 필요할 때만 새 dispatch를 강제한다.
- `session.idle` 이후에도 Telegram selected session은 유지되어 다음 plain message가 같은 session으로 follow-up될 수 있어야 한다.

### Feedback 카드

- feedback dispatch는 description wrapper나 title이 아니라 `feedbackForCardId`를 기준으로 원본 card를 찾는다.
- 원본 card에 `sessionId`가 있으면 feedback card는 그 session을 재사용한다.
- `sessionId`는 runtime별 actual continuation id다. `opencode`는 opencode session id, `codex`는 `thread_id`, `claude`는 `session_id`를 뜻한다.
- feedback 재사용은 queue session mode보다 우선한다.
- feedback card는 완료 시에도 sanitize boundary 예외를 유지한다.

### Runtime dispatch

- `agentRuntime`이 없는 legacy card는 항상 `opencode`로 취급한다.
- `sessionId`는 runtime별 actual continuation id만 저장한다.
- Codex/Claude는 actual id를 얻기 전까지 `sessionId`를 저장하거나 반환하면 안 된다.
- `runId`, `pending-*`, 빈 문자열은 `sessionId` 대체값으로 사용할 수 없다.
- dispatch 응답은 항상 `{ sessionId, runId, startedAt }` shape를 유지한다.
- runtime 실패는 card를 `todo`로 되돌리고 `progressSummary`에 `[failed] ...`를 남겨야 한다.
- runtime 실패로 `todo`에 복귀한 card는 `command`/`arguments`, `resumeSessionId`, queue 설정, `projectDir`, `model`, `agentRuntime`, runtime options, `screenshots`를 dispatch 전과 동일하게 유지해야 한다.
- Codex `thread_id` timeout과 Claude `session_id` timeout은 runtime run을 failed로 만들고 card를 `todo`로 되돌린다.
- opencode dispatch 순서 `store.updateCard -> trackDispatch -> promptAsync`는 `OpencodeAdapter` 안에서 보존한다.
- `StaleCardChecker`의 opencode native session list 검사는 legacy/opencode card에만 적용한다.
- Codex/Claude stale run은 `RuntimeRunStore.reconcileStale(store)`가 처리한다.
- `ClaudeCodexWatchdog`의 "active run 없음 → todo 복귀" 판정은 RuntimeRunStore로 시작한 보드 dispatch 카드에만 적용한다. `.codex/hooks/on-prompt.sh` / `.claude/hooks/on-prompt.sh`가 만든 organic CLI 카드(`sourceContext=codex` 또는 `claude-code`)는 run artifact가 없으므로 watchdog orphan으로 되돌리면 안 된다. 해당 카드는 Stop hook이 `complete`로 닫는다.
- queue helper는 성공 완료 콜백에서만 호출하고, 실패 흔적이 있는 `todo` card는 자동 재dispatch하지 않는다.

### 예약/스케줄 dispatch

- scheduled card background dispatch는 singleton runtime owner에서만 동작하며, owner 획득 시 즉시 due scan을 한 번 수행한다.
- scheduled card는 store atomic claim(`scheduled -> dispatching`)을 통과한 경우에만 실제 `dispatchCard(cardId)`로 들어간다.
- active scheduled reservation을 소비하는 정상 dispatch 경로는 card status를 `in_progress`로 올릴 수 있어야 한다. 이 전이를 queue/eligibility 가드가 다시 막으면 안 된다.
- stale `dispatching` claim은 restart 후 복구 가능해야 하며, 복구 기준은 테스트로 고정한다.
- 수동 `POST /api/cards/:id/dispatch`와 background due scan은 같은 예약-claim wrapper를 사용해야 하며, 경합 시 dispatch는 한 번만 일어난다.
- scheduled dispatch 접수 성공은 `scheduledDispatch.status='dispatched'`와 실제 accepted timestamp를 기록한다.
- scheduled dispatch 접수 실패는 card를 `todo`로 남기고 `[failed] ...` 흔적과 `scheduledDispatch.status='failed'` / `error`를 기록하며 자동 재시도하지 않는다.
- scheduler prompt run은 먼저 `SchedulerRun.id`를 만들고, 그 id를 `card.schedulerRunId`에 박은 scheduler-origin `todo` 카드를 생성한 뒤 기존 dispatch를 호출한다.
- scheduler run의 성공은 dispatch acceptance 기준이며, 실제 작업 완료/실패 추적은 run의 `cardId`로 이어진 board card가 담당한다.

### Prompt Quick Action dispatch

- Quick Action의 `icon`은 shared contract의 단일 grapheme emoji다. 기본 팔레트(`⚡`, `🔍`, `🧪`, `🚀`, `🛠️`, `📊`, `🧹`, `🛡️`, `🔔`, `📦`)와 중복 거부 정책/오류 문자열은 `src/core/types.ts` 한 곳에서 관리한다. icon을 생략한 생성은 store lock 안에서 미사용 기본값을 claim하고, icon 없는 legacy entry는 목록 정렬 순서에 따라 결정적인 서로 다른 fallback을 받아 누락되지 않는다.
- Quick Action 실행/관리는 Board의 TODO 왼쪽 gutter에 overlay되는 `⚡ Quick ›` edge tab과 왼쪽 modal side sheet를 사용한다. desktop launcher는 icon·이름·열림 방향을 가로로 표시하고 document flow 폭을 소비하거나 세로 글씨를 표시하지 않는다. mobile에서는 같은 가로형 launcher를 Board 위에 배치한다. 열린 desktop sheet는 Board/List geometry를 바꾸지 않고 오른쪽 배경을 semantic scrim으로 dim 처리하며 Board/List content를 `inert`/`aria-hidden`으로 만든다. mobile sheet는 `100vw × 100dvh` 전체 화면을 덮고 safe-area 하단 여백을 둔다. launcher는 `aria-haspopup`/`aria-expanded`/`aria-controls`, sheet는 `aria-modal`, focus trap, backdrop/Escape 닫기, launcher focus 복귀를 보장한다.
- Quick Action Add/Edit는 side-sheet runner와 분리된 `DialogSkeleton` editor를 사용한다. editor가 열릴 때 runner sheet를 언마운트해 중첩 modal/focus trap을 만들지 않고, 닫은 뒤 Add 또는 해당 행의 overflow-menu 진입점으로 focus를 돌린다. 새 Prompt의 Runtime은 `useRuntimeDefaults().prefs.runtime ?? 'opencode'`, Model은 `useRuntimeModelSelection().getDefaultModelForRuntime()`을 적용해 Create Card와 일치시킨다. 비동기 설정/model 목록은 각 필드를 사용자가 직접 바꾼 뒤 덮어쓰지 않으며, 기존 Prompt는 저장된 Runtime/Model/Icon을 우선하고 Script editor는 Runtime/Model을 노출하지 않는다.
- `POST /api/quick-actions/:id/run`은 저장된 action 정의만 신뢰한다. 요청은 `clientRequestId`와 `parameterValues`만 받고, required/type/select/unknown key를 서버에서 다시 검증한다.
- template placeholder는 정확한 `{{parameterKey}}` 형식만 허용한다. malformed/unknown/value-less placeholder가 하나라도 있으면 카드를 만들기 전에 거부한다.
- 저장된 prompt action의 `projectDir`가 실제 directory가 아니거나 action이 disabled/unavailable이면 카드를 만들거나 dispatch하지 않는다.
- 검증이 끝나면 `quick_action` provenance를 가진 `todo` 카드를 먼저 저장한 뒤 기존 `dispatchFn`을 호출한다. 별도 runtime/agent 실행기를 만들지 않으며 기존 session, git/usage, idle completion 경로를 그대로 사용한다.
- 저장된 `agentRuntime`, `model`, `agentType`, `codexOptions`, `claudeOptions`, `projectDir`는 일반 카드 dispatch 계약과 같은 필드로 카드에 복사하며 route가 임의 default를 덮어쓰지 않는다.
- `(quickActionId, clientRequestId)`는 store 잠금 안에서 원자적으로 예약한다. 동시 double tap과 이후 retry는 새 카드나 새 dispatch를 만들지 않고 저장된 `quickActionRun` 결과를 반환한다.
- dispatch 접수 실패는 이미 만든 카드를 삭제하지 않는다. 카드는 `todo`로 돌아가고 `progressSummary`와 `quickActionRun.failureSummary`에 `[failed] ...` 흔적을 남기며 같은 idempotency key의 retry도 그 실패를 그대로 반환한다.
- 일반 `POST/PATCH /api/cards`는 Quick Action provenance와 `quickActionRun` 상태를 주입하거나 위조할 수 없다.
- UI는 Prompt의 필수 `projectDir`, parameter schema, production/elevated permission 확인을 실행 전에 검증하되 서버 검증을 대체하지 않는다. 접수 성공 뒤 실제 카드를 refetch하고, 별도 낙관적 fake card/status를 만들지 않는다.
- 서버가 `cardId`를 포함한 terminal 실패를 반환하면 UI는 실패 카드를 refetch하고 다음 클릭용 idempotency key를 발급한다. card가 저장됐는지 알 수 없는 transport 실패는 같은 key를 유지해 중복 실행을 막는다.

### Script Quick Action 실행

- Script Quick Action도 `(quickActionId, clientRequestId)`를 store 잠금 안에서 한 번만 예약한다. 중복 요청은 새 카드/ScriptRun/process를 만들지 않고 같은 `cardId`/`runId`를 반환한다.
- 요청 body는 `clientRequestId`, `parameterValues`만 허용한다. stored `parameterDefinitions`로 required/type/select/unknown key를 검증하고, 실행 값은 명령 문자열/argv에 보간하지 않는다. 정규화한 `AK_PARAM_<UPPER_SNAKE_KEY>` 환경변수로만 전달한다.
- Settings env와 parameter env는 `execution-environment.ts` 한 경계를 사용한다. system/interpreter/internal reserved key와 `AK_PARAM_*` Settings 충돌은 무시하며, masked Settings 값과 secret parameter 값은 card/result/history/stdout/stderr/error에 쓰기 전에 모두 `[REDACTED]` 처리한다.
- interpreter는 저장된 language를 고정 allowlist(`bash`, `python3`, `bun`, `ruby`) argv로 매핑한다. run 요청이 shell/interpreter/command를 지정할 수 없다.
- 실행 접수 전에 effective cwd가 실제 directory인지 검증한다. `ScriptExecutionService.prepareExecution()`은 content/language revision, argv, cwd, env를 snapshot으로 고정하므로 이후 script 편집이나 source file 삭제가 현재 process에 영향을 주지 않는다. running ScriptEntry의 직접/sync 삭제는 보류한다.
- `ScriptRun(status=running)`과 일반 card(`status=in_progress`, `executionKind=script`)를 먼저 저장한 후 HTTP `202`로 `cardId`/`runId`를 반환한다. stdout/stderr는 각각 UTF-8 8192 byte까지만 보존한다.
- Script card에는 실행 시점 `scriptName` snapshot을 저장한다. 일반 card 생성/수정 API가 `scriptName`, `executionKind`, `quickActionId`, `quickActionRun`을 위조할 수 없어야 한다.
- `executionKind=script` card는 Board/List/Card Detail에서 항상 `SCRIPT`로 표시하고 저장 호환용 `agentRuntime` fallback을 `OPENCODE`로 잘못 노출하지 않는다. agent card는 실제 runtime badge를 유지하며 origin badge는 별도 provenance로 표시한다.
- exit code 0은 `ScriptRun.success`와 card `complete/completed`로 종결한 뒤 queue helper를 호출한다. spawn/nonzero/restart orphan은 exit/error를 남기고 card `complete/failed`로 종결하며 queue helper를 절대 호출하지 않는다.
- per-script `beginRun()` claim은 동시 실행을 거절한다. singleton owner 시작 시 owner PID가 살아 있지 않은 orphan `running` row를 `fail`로 reconcile하고 연결 card도 terminal failed로 닫는다.
- `executionKind=script` card는 agent session이 없으므로 `StaleCardChecker`의 opencode orphan/stuck 판정에서 제외한다. process liveness와 복구는 ScriptRun owner PID/reconcile 계약이 담당한다.

### Work 완료 라이프사이클

- `PATCH /api/works/:id`의 `status='done'`은 `applyWorkPatch()`(`src/plugin/works/work-lifecycle.ts`)를 통과한다. 엔드포인트는 추가하지 않는다 — Works UI(카드 3/7)는 이 한 경로만 호출한다.
- 일괄 archive 대상은 **Work의 `sessionLinks`에 연결된 세션의 카드로만** 한정한다. `store.archiveCards()`는 **빈 배열을 넘기면 보드의 모든 `done` 카드를 archive**하므로, seed가 0건이면 절대 호출하지 않고 `archiveSkipped='no-cards'`로 끝낸다. (회귀 테스트 존재)
- 카드 status 전환은 `store.updateCard(id, { status: 'done' })` 순수 store write로만 한다. 완료 훅(`event-handler.ts`)을 타지 않으므로 **Work 완료가 queue auto-dispatch를 유발하면 안 된다** — 끝낸 작업을 정리하는 동작이 새 agent run을 시작시켜서는 안 된다. **재개(`POST /api/works/:id/reopen`)도 마찬가지다**: 복원된 카드는 `done`으로 돌아오는데, 그 status는 완료 훅이 "방금 끝났으니 뒤에 큐된 카드를 dispatch하라"로 읽는 바로 그 상태다. 카드 20장짜리 Work라면 한 번의 정리가 큐 20건을 동시에 터뜨린다. (회귀 테스트: `src/__tests__/work-lifecycle.test.ts` — `Work completion and reopen never auto-dispatch a queued card`. 라우트에 spy `dispatchFn`을 주입해 완료·재개 양쪽에서 한 번도 호출되지 않고, 스윕된 카드 뒤에 큐된 `todo` 카드가 세션 없이 `todo`로 남는지 확인한다.)
- Work은 **실제로 일어나지 않은 archive를 광고해서는 안 되고**, sweep이 실패하면 `archivedAt` 없이 남아 재시도 가능해야 한다. 원자적 claim(위 항목) 때문에 스탬프가 카드 sweep보다 앞서므로, 이 불변식은 **한 장도 archive하지 못한 sweep이 자기 스탬프를 되돌리는 것**(`archivedAt: null`)으로 지킨다. 부분 성공(일부 archive됨)은 스탬프를 유지하고 `sweep.failed[]`로 보고한다.
- **산하 카드에 살아있는 runtime run(`starting`/`running`)이 하나라도 있으면 `done` 전이를 `409`로 거부한다.** 상태 전이도 기록하지 않는다 — 실행 중 카드를 archive하면 그 카드의 완료 훅이 `Card not found`로 실패하고 wiki가 미완성 트랜스크립트로 문서를 만든다. 응답 본문에 `runningCardIds`를 실어 UI가 무엇이 실행 중인지 말할 수 있게 한다. 판정은 주입된 `ActiveRunProbe`(라우트가 `RuntimeRunStore.listRuns()` 한 번으로 구현)이며 `applyWorkPatch`는 store를 직접 알지 않는다.
- `works.done_confirm`(**기본값 `true`**)이면 body에 `confirmArchive: true`가 있을 때만 sweep한다. 플래그가 없으면 status/`resolvedAt`/`resolution`만 기록하고 sweep은 보류(`awaiting-confirmation`)한다. 설정을 읽을 수 없는 환경의 폴백도 `true`다 — 읽기 실패가 파괴적 경로를 열어서는 안 된다.
- **확인 보류 상태(`status='done'` + `archivedAt` 없음)는 막다른 길이어서는 안 된다.** `status` 없이 `{ confirmArchive: true }`만 담긴 patch도 완료 patch로 분류해 sweep을 끝낸다(`isCompletionPatch`). 같은 상태의 Work는 세션 이동 게이트(`assertMovable`)에서도 `409`로 거부한다 — 곧 실행될 archive와 경합해 이미 결정된 문서 그룹핑으로 세션이 재배치되기 때문이다.
- `archivedAt`이 이미 있는 Work의 중복 `done` PATCH는 idempotent다(재sweep 금지). **판정과 스탬프는 한 락 구간(`WorkStore.claimArchiveSweep`)에 있어야 한다** — `getWork` 읽기와 `updateWork` 쓰기를 나누면 동시 `done` patch 두 건이 모두 "archivedAt 없음"을 보고 둘 다 sweep한다(두 번째는 첫 번째가 비운 보드에 대고 카드 flip이 실패한다). 진 쪽은 `already-archived`로 끝나고 카드를 건드리지 않는다.
- **sweep의 카드 쓰기는 서로 독립적으로 settle한다**(`Promise.allSettled`). 카드 한 장이 읽기와 쓰기 사이에 삭제돼도 나머지는 archive되고, 실패는 `WorkTransitionResult.failedCards` → 응답의 `sweep.failed[]`로 **정직하게 보고**한다. 이 실패가 patch 전체의 에러로 새어나가면 안 된다.
- **Works 라우트의 에러 → HTTP 매핑은 에러 클래스로 한다**(`src/core/work-errors.ts`). `message.includes('not found')` 같은 substring 매핑은 카드가 sweep 중에 사라졌을 때의 `Card not found: <id>`를 `404 Work not found`로 바꿔, 카드 절반이 archive된 Work를 "존재하지 않는 Work"라고 보고했다.
- terminal 전환은 `resolvedAt`과 `resolution`(`done`→`completed`, `discarded`→`abandoned`)을 자동 스탬프하고, `active`로 되돌리면 둘 다 지운다 — 살아있는 Timeline 바가 과거 종료일을 들고 있으면 안 된다.
- **Timeline 바의 날짜 편집은 clamp된 화면 컬럼이 아니라 `TimelineBar.rawStartIndex`/`rawEndIndex`(실제 컬럼) 기준이어야 한다.** 범위 밖에서 시작한 바는 컬럼 0에 그려지므로, clamp된 값으로 `←`/`→`를 계산하면 8/20 시작 Work를 9/1 주간에서 한 칸 밀었을 때 `startedAt`이 9/2로 저장된다 — 확인도 되돌리기도 없이 거의 2주가 사라진다. 뒤집힘 가드와 `aria-valuenow`/`aria-valuetext`도 raw 기준이고, 드래그만 "드롭한 화면 컬럼"을 쓴다(열이 안 바뀐 드롭은 드래그 origin과 비교해 PATCH를 보내지 않는다). 모든 날짜 편집은 `WorkSessionNotice`로 **되돌리기**를 남긴다. (회귀 테스트: `web/src/components/Works/timelineModel.test.ts`, `e2e/works.e2e.ts`)
- **종료된 Work의 바 길이에 `updatedAt`을 폴백으로 쓰지 않는다.** terminal 전환이 항상 `resolvedAt`을 스탬프하므로 없는 경우는 데이터가 깨진 것뿐이고, `updatedAt`을 빌리면 제목만 고쳐도 끝난 Work의 바가 하루씩 자란다. `resolvedAt`이 없으면 오늘까지 그린다(`rawEndColumn`).
- **`GET /api/timeline`의 창 길이에는 상한(400일)이 있다.** 창은 이 라우트가 파싱하는 아카이브 양을 제한하는 유일한 장치이고 인증 없는 GET이므로, 상한이 없으면 `from=1970&to=2030` 한 번이 디스크의 모든 아카이브 월을 읽는다. 검증은 순수 함수 `checkTimelineWindow`에 모아둔다. (회귀 테스트: `src/__tests__/timeline-aggregate.test.ts`, `src/__tests__/timeline-route.test.ts`)
- `discarded`는 카드를 archive하지 않고 보드에 그대로 남긴다. 카드의 wiki 파이프라인에는 아무 영향을 주지 않는다(Work 그룹핑에서만 빠진다).
- **완료된 Work를 다시 읽는 경로는 archive를 포함해야 한다.** 완료는 산하 카드를 전부 archive하므로, Work 상세의 산출물/세션 요약을 라이브 보드 카드에서 계산하면 되돌아볼 대상인 Work가 정확히 `카드 0 · done 0`이 된다. 집계는 서버(`GET /api/works/:id/sessions` → `buildWorkSessionsResponse`)가 하고, 딥링크는 `GET /api/cards/:id?include_archived=true` / `GET /api/cards?session_id=&include_archived=true`를 쓴다. 세 경로 모두 월 단위 읽기(`workCardScanFloor` + `timelineArchiveMonths`, 또는 `store.getCard(id, { includeArchived })`)이며 `store.loadArchives()`(전체 스캔)로 바꾸면 안 된다. 종료된 Work의 기간은 `resolvedAt − startedAt`으로 고정한다(`workAgeDays`) — 완료된 Work가 매일 하루씩 늙으면 안 된다. (회귀 테스트: `src/__tests__/work-sessions-route.test.ts`, `web/src/components/Works/worksAssign.test.ts`, `e2e/works.e2e.ts`)
- **완료·폐기는 클릭이 곧 실행이어서는 안 된다.** 두 전이 모두 터미널이고 되돌리기가 없으므로 `WorkResolveConfirmDialog`(`DialogSkeleton`)를 반드시 거친다. 완료 확인은 `GET /api/works/:id/completion-preview`로 "카드 N장이 archive된다"와 "실행 중 카드 M장이 있어 완료할 수 없다"를 먼저 말하고, 미리보기가 오기 전에는 확인 버튼이 비활성이다. 훅의 `completeWork`/`discardWork`는 `'done' | 'declined' | 'blocked'`를 돌려주고 호출부는 **`'done'`일 때만** 자신의 다이얼로그를 닫는다 — 예전 `Promise<void>` 계약은 확인 거절과 완료를 구분할 수 없어서 취소가 완료처럼 보였다. 확인 필요 여부는 `requiresDoneConfirm(config)`이며 **설정 미로드는 "확인 필요"** 다(`config?.doneConfirm`을 직접 읽으면 설정보다 빠른 클릭이 프롬프트를 건너뛴다). (회귀 테스트: `src/__tests__/work-lifecycle.test.ts`, `web/src/components/Works/worksAssign.test.ts`, `e2e/works.e2e.ts`)
- **subagent 세션은 부모의 Work를 따라간다.** 세션을 Work에 연결하면 `parentCardId` 체인으로 이어진 자손 세션도 같은 Work에 연결된다(transitive, `linkSessionWithSubagents`). 이미 다른 Work에 연결된 세션은 건너뛰므로 "한 세션은 최대 하나의 Work" 불변식은 그대로다. 큐 체인(`queuedAfterCardId`)과 `resumeSessionId`는 승계 대상이 **아니다** — 그쪽은 사용자가 판단할 몫이다.
- **Inbox는 유계(bounded)다.** 카드가 없는 세션, 부모가 이미 배정된 subagent 세션, `since`(기본 30일)·`limit`(기본 200)을 벗어난 세션은 `GET /api/works/inbox`가 반환하지 않는다. 단 `cardStatus === 'in_progress'`인 세션은 창과 무관하게 남는다.
- **세션 계보류 필드(`relatedSessionIds` / `parentSessionIds` / `sessionKind`)는 `computeSessionAggregates`의 두 집계 분기 위에서 한 번 계산해 양쪽에 적용한다.** 운영은 항상 네이티브 분기(`aggregateSessionsFn`, `plugin/bootstrap.ts`가 무조건 주입)를 타므로, 한쪽 분기 안에서만 세팅한 값은 조용히 존재하지 않는다. 이 라우트 테스트는 `aggregateSessionsFn`을 주입한 상태로 쓴다.
- Work의 `startedAt`은 **연결된 모든 세션의 최초 카드 시각의 `min()`**이다(카드의 `startedAt`, 없으면 `createdAt`, 카드가 아예 없는 링크는 그 링크의 `linkedAt`). 연결·해제·이동·정리 네 경로 모두 `resolveWorkStartedAt()` 하나로 계산한다 — 더 오래된 세션을 붙이면 바가 왼쪽으로 당겨지고, 가장 오래된 세션을 떼면 남은 것 중 가장 이른 시각으로 밀린다. archive된 카드도 포함하며 `resolvedAt`은 세션에서 유도하지 않는다.
- **`min()` 재계산은 store의 락 *안에서* 실행해야 한다.** 라우트는 archive 포함 카드 스냅샷을 요청당 한 번 읽어 `createWorkStartedAtResolver(cards)`로 감싸 넘기고, `WorkStore.addSession`/`removeSession`/`moveSession`/`pruneMissingSessions`가 방금 쓴 링크 집합에 대고 그것을 실행한다. 라우트가 락 밖에서 값을 계산해 넘기면 TOCTOU다 — 동시 연결 두 건이 각각 상대 세션이 없는 링크 집합의 `min()`을 계산하고, 나중에 쓴 쪽이 상대의 답을 덮어써 불변식이 깨진다. 스냅샷을 링크마다 다시 읽지도 않는다(세션 20개 배정이 아카이브 전체 스캔 20회였다). (회귀 테스트: `src/__tests__/work-store.test.ts`)
- **링크를 바꾸지 않은 요청은 날짜를 건드리지 않는다.** 그 Work가 갖고 있지 않은 세션에 대한 `DELETE .../sessions/:id`는 재계산도 `updatedAt` 갱신도 하지 않는 no-op이다 — 예전에는 no-op에서도 재계산해서 사용자가 바 드래그로 맞춘 날짜를 파생값으로 되돌렸다. 반대로 **링크가 실제로 바뀌면 수동 `startedAt`은 재계산으로 덮인다**(문서화된 동작).
- **Work 날짜는 `Date.parse` 비교, UTC `Z` 저장이다.** 라우트가 `new Date(v).toISOString()`으로 정규화해 저장하고 `applyRecalculatedStartedAt`의 clamp는 `Date.parse`로 비교한다. `+09:00` 오프셋 표기는 같은 순간의 `Z` 표기보다 문자열로 뒤에 정렬되므로, 정규화나 파싱 중 하나만 빠져도 clamp가 필요 없는 clamp를 실행한다.
- **`archivedAt`과 `wikiDocPath`는 서버 소유다.** `PATCH /api/works/:id`는 둘 다 `400`으로 거부한다 — `archivedAt`은 sweep의 idempotence와 세션 이동 게이트를 동시에 결정하므로, 클라이언트가 임의 문자열을 넣으면 두 경로가 되돌릴 UI 없이 영구히 막힌다. patch의 나머지 필드도 전부 typeof 검증을 거친다(`{"title": 7}`이 `400 .trim is not a function`으로 내부 스택을 노출하던 결함).
- **즐겨찾기(`favorite`) 최상위 카드는 Work 완료 sweep에서 제외한다.** `favorite`은 "보드에 고정"이고 `store.archiveCards()`는 cascade 자식에 대해 이미 그것을 지킨다 — Work sweep만 자기 seed를 직접 넘겨 그 표시를 지나쳤다. `done` 전환도 하지 않는다(다음 일반 archive에 쓸려간다). `sweep.keptFavoriteCardIds`와 `completion-preview.favoriteCardIds`로 보고하고, 보드 카드가 전부 즐겨찾기면 `archiveSkipped='favorites-only'`로 **스탬프 없이** 끝난다. 필터는 `applyWorkPatch`에 두고 store로 옮기지 않는다(`POST /api/archive`의 동작 불변).
- **카드가 사라진 세션 링크는 감지해서 표시한다.** 카드 삭제는 예전에 Works에 아무것도 알리지 않아, 카드를 전부 지운 세션의 링크가 남고 `resolveWorkStartedAt`이 그 `linkedAt`으로 폴백해 Timeline 바가 triage 시각에서 시작했다. 지금은 `WorkSessionLink.cardsMissingAt`을 찍는다(`reconcileWorkSessionLinks`, `src/plugin/works/work-links.ts`) — 카드 delete/restore 라우트가 그 Work 하나만 좁혀서, 부팅 시 1회 전체를, `POST /api/works/reconcile-links`가 수동 전체를 돌린다. 멱등이고 월 단위 읽기(`workCardScanFloor` + `timelineArchiveMonths`)이며 `store.loadArchives()`로 바꾸면 안 된다. **링크를 자동으로 끊지 않는다** — 카드 삭제는 soft delete이고 카드 없는 세션은 Inbox에도 나타나지 않으므로, 자동 제거는 되돌릴 수 있던 동작을 되돌릴 수 없게 만든다. 제거는 `POST /api/works/:id/prune-sessions`(확인 있는 사용자 행동)뿐이고, 링크가 0개가 돼도 Work는 삭제하지 않는다. (회귀 테스트: `src/__tests__/work-lifecycle.test.ts`, `e2e/works.e2e.ts`)
- **다중 배정은 `POST /api/works/:id/sessions/batch` 하나다.** 세션마다 순차 POST하면 요청마다 아카이브 전체를 스캔한다. 배치는 카드 스냅샷 하나를 모든 링크와 subagent 트리에 공유하고, **부분 실패를 응답으로 보고한다**(`failed[]`) — 1:N은 세션 단위이므로 한 세션의 `409`가 성공한 링크를 되돌려서는 안 된다.
- **`WorkResolution`의 값은 그것을 스탬프하는 전이와 함께만 존재한다.** `superseded`는 한때 세팅 코드가 없어(마지막 세션을 옮겨 원본을 비우는 이동은 원본을 *삭제*한다) 클라이언트가 직접 써 넣는 것 외에 생길 방법이 없었고, 그래서 타입과 라우트 검증에서 제거했다. `POST /api/works/:id/merge`가 그 전이이므로 지금은 되돌아와 있다. **단 PATCH로는 여전히 쓸 수 없다**(`400 Invalid resolution`) — `superseded`는 짝이 되는 `supersededByWorkId` 없이는 아무 곳도 가리키지 않는 `병합됨` Work를 만들 뿐이고, 그 둘을 함께 쓰는 것은 merge 라우트뿐이다. `supersededByWorkId`도 같은 이유로 patch 거부 필드다. (회귀 테스트: `src/__tests__/work-store.test.ts`, `src/__tests__/works-reopen-merge-route.test.ts`)
- **Work 재개는 되돌릴 수 있어야 하고, 큐 자동 dispatch를 트리거해서는 안 된다.** 완료는 일방통행이었다 — `PATCH`가 `status: 'active'`를 받아도 archive된 카드는 돌아오지 않고 `archivedAt`이 남아 sweep 멱등 가드와 세션 이동 게이트가 영구히 닫혔으며, 유일한 탈출구는 레코드를 버리는 `DELETE`였다. `POST /api/works/:id/reopen`이 그 문을 연다.
  - **카드 복원(`store.unarchiveCards`)이 상태 쓰기보다 먼저다.** 반대로 하면 복원 실패가 "카드는 archive에 있는데 `active`인 Work"를 남기고 다음 완료가 `no-cards`를 보고한다.
  - 복원은 **순수 store 쓰기**다. 작업을 다시 여는 행위가 새 에이전트 실행을 시작해서는 안 된다 — 완료 sweep이 `store.updateCard`를 쓰는 것과 같은 이유이며, `dispatchCard`/큐 경로를 여기에 끼워 넣지 않는다.
  - **`archiveCards`의 subagent 서브트리 cascade와 대칭이어야 한다.** 자식만 archive에 남으면 보드가 그릴 수 없는 분리 상태다.
  - 복원된 카드는 **`done`으로 돌아온다.** sweep이 직전 status를 어디에도 기록하지 않으므로 복구할 정보가 없고, 없는 정보를 발명하는 대신 확인 문구가 그렇게 말한다(`describeWorkReopen`).
  - **wiki 상태**: `pending` 스탬프는 지운다 — 보드로 나온 카드는 `WikiWorker`가 볼 수 없어 지킬 수 없는 예약이고, 남겨두면 `archiveCards`가 `!card.wiki`일 때만 스탬프하므로 **다시 archive해도 큐에 들어가지 않는다.** `kept`/`skipped`/`failed`는 그대로 둔다 — 판정이 끝난 기록을 지우면 같은 문서를 두 번 쓴다.
  - 이미 `active`인 Work의 재개는 `409`다(`WorkAlreadyActiveError`). 열려 있는 Work를 "다시 열어" 종료 예정일을 지워버리는 사고를 막는다.
  - (회귀 테스트: `src/__tests__/works-reopen-merge-route.test.ts`, `e2e/works.e2e.ts`)
- **Work 병합은 원본을 삭제하지 않는다.** 두 Work를 합치는 유일한 경로였던 "세션을 하나씩 옮겨 원본을 비우기"는 비워진 Work를 *삭제*하므로 Summary·메모·Timeline 이력이 되돌리기 없이 사라졌다. `POST /api/works/:id/merge`는 원본을 `discarded` + `superseded` + `supersededByWorkId`로 남겨 "어디로 갔는지"를 말한다. 대상의 `startedAt`은 **하나의 락 구간 안에서** 병합 후 링크 집합으로 재계산하고(`WorkStartedAtResolver` — 위 `min()` 불변식과 같은 계약), 대상이 이미 가진 세션은 건너뛴다(살아남는 쪽의 링크·역할을 조용히 덮어쓰지 않는다). 세션 : Work = N : 1은 유지된다. (회귀 테스트: `src/__tests__/works-reopen-merge-route.test.ts`, `e2e/works.e2e.ts`)
- **Work 목록의 필터·정렬 규칙은 서버와 웹이 같은 함수를 쓴다.** `selectWorks()`(`src/core/work-list.ts`)가 `GET /api/works`와 Active 목록 양쪽의 유일한 규칙이다 — 웹은 Timeline 그룹핑·배정 추천·이동 다이얼로그가 모든 Work를 필요로 해서 목록 전체를 폴링하므로 요청을 좁힐 수 없고, 그래서 좁히기를 클라이언트에서 하되 **규칙을 다시 구현하지 않는다.** 모든 비교자는 `id` 비교로 끝나 전순서다(타임스탬프가 같은 두 Work가 폴링마다 자리를 바꾸면 안 된다). 잘못된 `sort`는 `400`이고 조용히 기본 순서로 돌아가지 않는다. `예정 N일 초과`는 `active`에만 적용한다 — 종료된 Work의 `resolvedAt`은 실제 종료 시각이지 놓친 예측이 아니다. (회귀 테스트: `src/__tests__/work-list.test.ts`, `web/src/components/Works/worksAssign.test.ts`, `e2e/works.e2e.ts`)
- **`Work.notes`는 서버가 절대 쓰지 않는다.** `summary`는 LLM이 통째로 덮어쓰므로 사람이 적은 문장을 담을 수 없고, 그것이 이 필드가 따로 있는 이유다. 상한은 `WORK_NOTES_MAX_LENGTH`이며 초과는 `400`이고 아무것도 저장하지 않는다. UI는 제목/디렉토리 인라인 편집과 같은 draft 센티널 규칙(10초 폴링이 타이핑을 덮어쓰지 못한다)을 쓰되 커밋은 **명시적 버튼**이고, 저장하지 않은 메모가 있는 채로 닫을 때는 확인을 거친다. (회귀 테스트: `src/__tests__/works-reopen-merge-route.test.ts`, `e2e/works.e2e.ts`)

### Inbox triage 안전장치

- **배정 모달의 단축키는 포커스한 요소의 것을 빼앗지 않는다.** 핸들러는 `window` capture에 붙어 다이얼로그의 모든 키를 받으므로, 판정은 순수 함수 `resolveBulkAssignShortcut`(`worksAssign.ts`) 하나이고 두 규칙을 지킨다 — (a) target이 `<button>`/`<a>`/`contenteditable`이면 `Enter`는 그 요소의 것이다(`X 폐기`에 포커스한 Enter가 `연결하고 다음`을 실행하고 `preventDefault`로 버튼 동작까지 막던 결함), (b) target이 `INPUT`/`TEXTAREA`/**`SELECT`**/`contenteditable`이면 `Enter` 외의 모든 키는 그 컨트롤의 것이다(역할 `<select>`에 포커스를 두고 누른 `x`가 세션을 폐기하던 결함). `1`–`9`는 추천 개수를 넘으면 단축키가 아니다.
- **폐기(`ignoredSessionIds`)에는 복구 경로가 있어야 한다.** 목록은 `GET /api/works/ignored-sessions`로 읽고 `DELETE /api/works/ignore-session/:sessionId`로 되돌린다. 목록에 없던 id의 복원은 `404`다(멱등 성공은 오래된 UI 목록이 거짓 성공을 보고하게 한다). "복원하면 Inbox에 돌아오는가"는 Inbox와 **같은 술어**(`isInboxTriageMaterial`)로 계산해 두 라우트가 어긋나지 않게 한다.
- **세션 링크(`POST /api/works/:id/sessions`)의 대상은 `active` Work여야 한다**(아니면 `409`, `WorkNotActiveError`). 예외 둘: 그 Work가 이미 가진 세션의 재연결(= 역할 변경, 그룹핑 불변)과 `POST /api/works/reconcile-subagents`(과거 데이터 보정). 웹도 held id가 아니라 **재조회된 `selectedWork`** 로 제출 버튼을 게이팅한다 — 패널이 열린 사이 대상이 완료되면 추천에서 사라지기 때문이다.
- **배정과 폐기는 되돌리기를 제공한다.** triage가 실제로 하는 두 동작이고 단축키 하나로 실행된다. 되돌리기는 같은 mutation을 반대로 호출할 뿐이고(`workAssignNotice.ts`), 종료된 Work에서의 연결 해제처럼 **지킬 수 없는 경우에는 되돌리기를 제공하지 않고 이유를 말한다**.
- 하단 토스트는 열려 있는 다이얼로그의 sticky 푸터 클릭을 **삼켜서는 안 된다** — 바는 `pointer-events: none`이고 자기 버튼만 되돌려 받는다.

### Work 단위 wiki 그룹핑

- `groupCardsBySession(cards, workIndex?)`에서 `workIndex`가 없거나 세션이 어떤 Work에도 속하지 않으면 **기존 세션 단위 동작과 100% 동일**해야 한다. Work 그룹핑은 순수 추가형이다. (`groupCardsBySession(cards, new Map())`가 `groupCardsBySession(cards)`와 동일함을 고정하는 테스트 존재)
- 같은 Work에 속한 세션들의 카드는 `work:<workId>` 그룹 1개로 합쳐 문서 1개를 만들고, 문서 제목은 LLM 제안을 무시하고 **Work title**을 쓴다.
- Work 그룹은 여러 세션에 걸치므로 `sessionId`/`sessionTitle`을 비우고 `sessionIds`(카드 createdAt 순, 결정적)를 채운다. frontmatter에 `work`/`sessions`로 기록한다.
- `discarded` Work는 `workIndex`에서 제외한다. 폐기는 **그룹핑 해제**일 뿐이므로 그 세션의 카드는 세션 단위 그룹으로 **일반 wiki 흐름을 그대로** 탄다 — 카드의 wiki 상태를 Work 상태로 뒤집지 않는다.
- **`active` Work는 인덱스에 포함한다. 그래서 한 Work의 카드는 여러 배치로 큐에 들어올 수 있고, 그래도 문서는 하나여야 한다.** 재작성 대상 경로는 `Work.wikiDocPath`에서 먼저 찾는다 — 배치 안의 카드에서만 찾으면 두 번째 배치는 자기가 참여하지 않은 배치의 `docPath`를 모르므로 같은 Work 제목으로 문서가 두 개 생긴다. 문서를 쓴 뒤 경로를 Work에 기록하는 것은 best-effort이며(실패해도 문서 자체를 실패시키지 않는다) 카드 쪽 `wiki.docPath` 폴백은 세션 그룹과 과거 데이터를 위해 유지한다. (회귀 테스트: `src/__tests__/wiki-worker.test.ts`)
- `WorkStore` 주입이 없거나 읽기가 실패하면 세션 단위로 fallback한다. 그룹핑 실패가 wiki 파이프라인을 멈춰서는 안 된다.
- 세션 그룹의 프롬프트 텍스트는 그대로 유지한다(Work 헤더 줄은 Work 그룹에만 추가). 세션 그룹 프롬프트를 바꾸면 `WIKI_PROMPT_VERSION`을 올려 과거 분류를 무효화해야 한다.

### Git/Usage 캡처

- dispatch 시작 시점(`runtime-host.ts`·`plugin/index.ts`의 `dispatchCard`)에 `captureGitStart`가 `card.git.start`/`startBranches`/`repoRoot`를 기록하고, 완료 시점(`claude-adapter.ts` 성공 분기 + `event-handler.ts` `session.idle`)에 `captureGitEndAndUsage`가 `card.git.end`/`branches`와 `card.usage`를 기록한다. 두 함수는 `src/plugin/runtimes/git-capture.ts`의 공통 헬퍼다.
- 캡처는 **전부 best-effort이며 절대 throw하지 않는다.** git/usage 캡처 실패가 dispatch나 카드 완료, queue auto-dispatch, Telegram 응답을 막아서는 안 된다.
- 완료 시점 캡처는 완료/`dispatchNextQueuedTodoCard`/Telegram 전송 **이후**에 마지막으로 실행해 그 흐름을 지연시키지 않는다.
- `usage`는 `events.jsonl`(claude/codex runtime run) 기반이다. opencode `session.idle` 경로는 events.jsonl이 없어 usage를 건너뛰고 git만 캡처한다.
- `startBranches`는 diff용 bookkeeping이며 완료 캡처에서 `branches`로 환원된 뒤 제거된다. UI에 노출하지 않는다.
- 캡처는 기존 완료/큐/feedback/Telegram 로직에 개입하지 않는 순수 추가형이어야 한다 (별도 `updateCard`로 `git`/`usage` 필드만 merge).

## 변경 체크리스트

- [ ] `chat-message.ts`, `event-handler.ts`, `telegram-poller.ts`, `telegram-commands.ts`, `telegram-state-store.ts`, `plugin/index.ts` 중 하나를 수정했다.
- [ ] 이 문서의 관련 불변식을 다시 읽었다.
- [ ] 대응 테스트 파일을 먼저 돌리거나 업데이트했다.
- [ ] 루트 `AGENTS.md`와 영향 받은 하위 `AGENTS.md`를 같이 갱신했다.
- [ ] 사용자 문서(`README.md`, `docs/README.md`, `docs/getting-started.md`, `docs/architecture.md`, `docs/kanban-board.md`, `docs/api-reference.md`) 중 사실값이 바뀐 파일을 같이 갱신했다.

## 권장 검증 순서

```bash
bun test src/__tests__/plugin-hooks.test.ts
bun test src/__tests__/telegram-poller.test.ts
bun test src/__tests__/feedback-session-reuse.test.ts
bun test src/__tests__/telegram-state-store.test.ts
bun test src/__tests__/workflow-regression.test.ts
bun test src/__tests__/runtime-registry.test.ts
bun test src/__tests__/dispatch-routing.test.ts
bun test src/__tests__/codex-cli-adapter.test.ts
bun test src/__tests__/claude-adapter.test.ts
bun test src/__tests__/queue-helper.test.ts
bun test src/__tests__/work-lifecycle.test.ts
bun test src/__tests__/work-sessions-route.test.ts
bun test src/__tests__/wiki-worker.test.ts
bunx tsc --noEmit
bun test
```

## 참고

- 회귀점검보고서 (2026-03-15) — 내부 노트, 저장소에 포함되지 않음
- [칸반 보드 문서](./kanban-board.md)
