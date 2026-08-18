# Test Fixtures

파서 테스트의 실제 CLI 캡처와 실행 계약 테스트의 고정 예시 데이터.

---

## claude-task-stream-2.1.195.jsonl

| 항목 | 값 |
|------|-----|
| CLI 버전 | `claude 2.1.195` (Claude Code) |
| 모델 | `claude-haiku-4-5-20251001` |
| 캡처일 | 2026-06-28 |
| 라인 수 | 57 |

**실행 옵션:**
```bash
claude --model claude-haiku-4-5-20251001 \
  -p "..." \
  --output-format stream-json \
  --verbose \
  --dangerously-skip-permissions
```

**설명:**
Agent tool 서브에이전트 smoke — `system.task_started` / `task_updated` / `task_notification` 이벤트 확인.
tool 이름은 `Agent`(구 `Task`), `session_id`는 parent와 동일, child 중간 transcript 없음.

**핵심 이벤트 라인 예시:**

```jsonc
// line 41 — Agent tool use (tool name = "Agent", 구 "Task")
{"type":"assistant","message":{"content":[{"type":"tool_use","id":"toolu_018VN1vbznurtuvitS7XiuHP","name":"Agent","input":{"description":"Reply with exactly PONG","prompt":"Reply with exactly the word PONG. Nothing else. Just PONG."}}],"session_id":"aa0b8f03-fe7a-40cb-b1b9-47091e10cfb4"}}

// line 42 — task_started: task_id, tool_use_id, subagent_type, session_id(=parent와 동일)
{"type":"system","subtype":"task_started","task_id":"a6419ba278a83071e","tool_use_id":"toolu_018VN1vbznurtuvitS7XiuHP","description":"Reply with exactly PONG","subagent_type":"general-purpose","task_type":"local_agent","prompt":"Reply with exactly the word PONG. Nothing else. Just PONG.","session_id":"aa0b8f03-fe7a-40cb-b1b9-47091e10cfb4"}

// line 44 — task_updated: status=completed
{"type":"system","subtype":"task_updated","task_id":"a6419ba278a83071e","patch":{"status":"completed","end_time":1782615238346},"session_id":"aa0b8f03-fe7a-40cb-b1b9-47091e10cfb4"}

// line 45 — task_notification: 완료 요약, usage 포함
{"type":"system","subtype":"task_notification","task_id":"a6419ba278a83071e","tool_use_id":"toolu_018VN1vbznurtuvitS7XiuHP","status":"completed","output_file":"","summary":"Reply with exactly PONG","usage":{"total_tokens":19881,"tool_uses":0,"duration_ms":1306},"session_id":"aa0b8f03-fe7a-40cb-b1b9-47091e10cfb4"}

// line 46 — tool_result: child 응답("PONG") + agentId 메타
{"type":"user","message":{"content":[{"tool_use_id":"toolu_018VN1vbznurtuvitS7XiuHP","type":"tool_result","content":[{"type":"text","text":"PONG"},{"type":"text","text":"agentId: a6419ba278a83071e ..."}]}]},"session_id":"aa0b8f03-fe7a-40cb-b1b9-47091e10cfb4"}
```

**파서 검증 포인트:**
- `session_id`가 parent(`aa0b8f03-...`)와 child 모두 동일함 → 분리 불가, `task_id`로 child 구분
- child 중간 transcript(assistant turns)는 스트림에 노출되지 않음
- `task_started` → `task_updated` → `task_notification` 순서 보장

---

## quick-action-mcp-monitoring.json

최근 3일 MCP server 상태를 읽기 전용 Codex runtime으로 점검하는 Prompt Quick Action 계약 fixture입니다. 실제 CLI 캡처가 아니며, 다음 항목을 route 테스트에서 고정합니다.

- default parameter가 `{{days}}`, `{{scope}}` placeholder에 한 번만 렌더링됨
- 필수 `projectDir`가 생성 카드와 dispatch 입력에 유지됨
- `agentRuntime=codex`, model/agent와 `sandbox=read-only` options가 그대로 유지됨
- 성공 응답의 `cardId`, card status, `{ sessionId, runId, startedAt }` dispatch 결과

---

## quick-action-script-deployment.json

string, number, boolean, select, secret 파라미터를 모두 사용하는 배포 Script Quick Action 계약 fixture입니다. 파라미터는 불변 script snapshot에 `AK_PARAM_*` 환경변수로만 전달되며, secret은 card/run 영속 데이터에서 제외되어야 합니다.
