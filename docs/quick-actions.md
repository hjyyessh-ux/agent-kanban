# Quick Actions

## 개요

Quick Actions는 자주 반복하는 작업을 Board 아래의 launcher에서 바로 실행하는 기능입니다. 저장된 action은 `quick-actions.json`에 보관되며 Prompt와 Script 두 종류를 지원합니다. 실행 결과는 별도 임시 UI 상태가 아니라 일반 Board 카드로 추적됩니다.

| 종류 | 용도 | 실행 경로 |
|------|------|-----------|
| Prompt | 템플릿을 채워 Opencode, Codex, Claude agent 작업 실행 | 일반 `todo` 카드를 만든 뒤 기존 runtime dispatch 사용 |
| Script | 저장된 ScriptEntry를 안전한 interpreter로 실행 | `ScriptRun`과 `in_progress` 카드를 만든 뒤 비동기 process 실행 |

## 등록, 수정, 삭제

1. Board 아래의 **Quick Actions** 버튼을 엽니다.
2. **Manage**에서 새 action을 추가하거나 기존 action을 수정·삭제합니다.
3. Prompt는 일반 카드와 같은 title/prompt template, absolute project directory, runtime/model/agent/permission, 선택적 command/arguments template을 저장합니다.
4. Script는 Scripts에 등록된 항목을 선택하고 선택적으로 실행 directory를 덮어씁니다.

비활성 action과 연결된 Script가 사라진 broken action도 목록에 남아 원인을 표시합니다. 먼저 Script를 다시 등록한 뒤 action을 수정해 새 Script에 연결하면 복구할 수 있습니다. Quick Action이 참조 중인 Script를 UI/API로 직접 삭제하면 `409`로 거부됩니다. directory sync로 Script가 사라진 경우에는 action을 자동 삭제하지 않습니다.

## Prompt action

Prompt action의 `projectDir`는 필수입니다. 공백일 수 없으며 실행 시 실제로 존재하는 absolute directory여야 합니다. `cardTitleTemplate`, `promptTemplate`, 선택적 `argumentsTemplate`은 정확한 `{{parameterKey}}` placeholder만 지원합니다. unknown, malformed, 값이 없는 placeholder가 남거나 렌더링된 title/prompt가 비어 있으면 카드를 만들기 전에 실패합니다. `argumentsTemplate`은 일반 카드의 arguments처럼 렌더링되어 dispatch되며 `command`가 함께 저장된 경우에만 사용할 수 있습니다.

저장된 `agentRuntime`, `model`, `agentType`, `command`, Codex effort/sandbox, Claude permission mode는 생성 카드에 그대로 복사됩니다. 등록 화면은 새 카드와 동일한 `DirectoryPicker`, `RuntimeModelFields`, `CommandPicker`를 재사용합니다. UI의 production 또는 elevated 권한 확인은 실수 방지 장치이며, 서버는 저장된 action과 directory/parameter를 다시 검증합니다.

예를 들어 최근 3일 MCP 상태를 확인하는 action은 다음처럼 만들 수 있습니다.

```text
Title: MCP monitoring — last {{days}} days
Prompt: Inspect MCP failures and latency for the last {{days}} days in {{scope}}.
Directory: /absolute/path/to/project
Command: /review
Arguments: --window={{days}}d --scope={{scope}}
```

## 파라미터 schema

| 필드 | 규칙 |
|------|------|
| `key` | `[A-Za-z_][A-Za-z0-9_]*`; action 안에서 고유해야 함 |
| `label` | launcher에 표시할 사용자용 이름 |
| `type` | `string`, `number`, `boolean`, `select`, `secret` |
| `required` | string/secret은 공백만 있는 값을 허용하지 않음 |
| `defaultValue` | type과 일치해야 함; secret에는 저장 불가 |
| `options` | select에 필수이며 빈 값·중복을 허용하지 않음 |

정의되지 않은 parameter를 실행 요청에 넣을 수 없습니다. 서로 다른 key가 환경변수 변환 후 같은 이름이 되는 경우도 등록할 수 없습니다. 예를 들어 `fooBar`와 `foo_bar`는 둘 다 `AK_PARAM_FOO_BAR`가 되므로 충돌합니다.

secret parameter는 default를 저장하지 않고 카드의 `parameterSnapshot`에도 남기지 않습니다. 실행 실패 시 launcher는 사용자가 입력한 값을 유지하므로 값을 검토한 뒤 새 `clientRequestId`로 다시 실행할 수 있습니다.

## Script 환경변수와 Settings env

Script parameter는 command line, script content, interpreter argv에 보간하지 않습니다. 다음 규칙으로 환경변수에만 전달합니다.

```text
days       → AK_PARAM_DAYS
projectId  → AK_PARAM_PROJECT_ID
dry_run    → AK_PARAM_DRY_RUN
```

number와 boolean도 환경변수 문자열로 전달됩니다. Script language는 저장된 값에 따라 `bash`, `python3`, `bun`, `ruby` 중 고정 interpreter argv로 실행되며 실행 요청에서 shell이나 command를 바꿀 수 없습니다.

Settings의 유효한 key/value entry도 Script environment에 추가할 수 있습니다. 다만 system/interpreter/internal reserved key와 `AK_PARAM_*` key는 무시하여 실행 경계를 덮어쓸 수 없게 합니다. masked Settings 값과 secret parameter 값은 stdout, stderr, error, card result, ScriptRun history에 기록되기 전에 `[REDACTED]`로 치환됩니다. Settings 값 자체는 로컬 `settings.json`에 평문으로 저장되므로 파일 권한과 network exposure도 함께 관리해야 합니다.

## 실행 카드와 상태 추적

모든 실행 카드는 `originChannel=quick_action`, `quickActionId`, `executionKind=agent|script`를 기록합니다. Board의 badge와 Card Detail에서 실행 종류를 확인할 수 있습니다.

Prompt action은 먼저 `todo` 카드를 만들고 기존 dispatch가 접수되면 `in_progress`가 됩니다. 이후 runtime의 정상 카드 lifecycle을 따라 `complete`로 전환됩니다.

Script action은 실행 전 `ScriptRun(status=running)`과 `in_progress` 카드를 저장합니다. 카드에는 실행 시점 `scriptName`, `scriptRunId`, secret을 제외한 parameter snapshot이 남습니다.

| 결과 | ScriptRun | 카드 | queue |
|------|-----------|------|-------|
| exit code 0 | `success` | `complete`, `resolution=completed` | 다음 카드 한 장 실행 가능 |
| nonzero/spawn 오류 | `failed` | `complete`, `resolution=failed` | 실행하지 않음 |
| restart orphan | `failed`로 복구 | `complete`, `resolution=failed` | 실행하지 않음 |

## 실패와 복구

- validation, disabled action, 잘못된 directory, broken Script reference는 실행 카드 생성 전에 실패합니다.
- Prompt dispatch 접수 실패는 생성된 카드를 삭제하지 않습니다. `todo` 카드와 `[failed]` 요약을 남겨 원인을 확인할 수 있습니다.
- `(quickActionId, clientRequestId)`는 idempotency key입니다. double tap이나 동일 요청 재시도는 새 카드, dispatch, process를 만들지 않고 기존 결과를 반환합니다.
- 실패 응답 뒤 launcher의 parameter 입력은 유지됩니다. 서버가 실패 카드를 저장한 경우 그 카드를 즉시 갱신해 보여주고 다음 클릭에는 새 idempotency key를 사용하므로, 설정/action/script를 바로잡은 뒤 다시 실행할 수 있습니다. 응답을 받지 못한 전송 실패는 결과가 불확실하므로 같은 key를 유지합니다.
- Script 성공만 queue를 진행시킵니다. 실패를 성공으로 바꾸거나 다음 카드를 자동 실행해 오류를 숨기지 않습니다.

## 보안과 화면 계약

Quick Action 생성·수정·삭제·실행은 loopback에서 발급되는 로컬 token 인증을 사용하고 wildcard CORS를 허용하지 않습니다. server가 반환한 action 정의만 신뢰하며 요청은 `clientRequestId`와 `parameterValues` 외 실행 설정을 바꿀 수 없습니다.

launcher와 parameter/editor 화면은 Board/Card Detail과 동일한 kv2 token/primitive와 `DialogSkeleton`을 사용합니다. 좁은 iPhone 계열 viewport에서는 safe-area를 고려한 하단 여백을 확보하고, dialog는 header/board control 위에 뜨되 화면 밖으로 벗어나지 않아야 합니다. light/dark theme도 같은 token을 사용합니다.
