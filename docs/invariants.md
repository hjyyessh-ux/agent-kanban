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
bunx tsc --noEmit
bun test
```

## 참고

- 회귀점검보고서 (2026-03-15) — 내부 노트, 저장소에 포함되지 않음
- [칸반 보드 문서](./kanban-board.md)
