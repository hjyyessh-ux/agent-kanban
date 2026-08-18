# Quick Actions

## 개요

Quick Actions는 자주 반복하는 작업을 Board의 TODO 왼쪽 `⚡ Quick ›` edge tab에서 여는 modal side sheet로 바로 실행하는 기능입니다. 저장된 action은 `quick-actions.json`에 보관되며 Prompt와 Script 두 종류를 지원합니다. 실행 결과는 별도 임시 UI 상태가 아니라 일반 Board 카드로 추적됩니다.

| 종류 | 용도 | 실행 경로 |
|------|------|-----------|
| Prompt | 템플릿을 채워 Opencode, Codex, Claude agent 작업 실행 | 일반 `todo` 카드를 만든 뒤 기존 runtime dispatch 사용 |
| Script | 저장된 ScriptEntry를 안전한 interpreter로 실행 | `ScriptRun`과 `in_progress` 카드를 만든 뒤 비동기 process 실행 |

## 등록, 수정, 삭제

1. Board의 TODO 왼쪽 여백에 있는 **⚡ Quick ›** edge tab을 누릅니다. desktop에서는 Board 폭을 소비하지 않고 왼쪽 gutter에 overlay되며, mobile에서는 Board 위의 가로형 launcher로 표시됩니다.
2. side sheet 상단의 **Add Action** 또는 각 행의 **••• → Edit/Delete**로 action을 관리합니다.
3. Prompt는 일반 카드와 같은 title/prompt template, absolute project directory, runtime/model/agent/permission, 선택적 command/arguments template을 저장합니다.
4. Script는 Scripts에 등록된 항목을 선택하고 선택적으로 실행 directory를 덮어씁니다.

비활성 action과 연결된 Script가 사라진 broken action도 목록에 남아 원인을 표시합니다. 먼저 Script를 다시 등록한 뒤 action을 수정해 새 Script에 연결하면 복구할 수 있습니다. Quick Action이 참조 중인 Script를 UI/API로 직접 삭제하면 `409`로 거부됩니다. directory sync로 Script가 사라진 경우에는 action을 자동 삭제하지 않습니다.

**Allow this action to run**을 끄면 action 설정은 삭제하지 않고 유지하면서 새 실행만 차단합니다. 비활성 action은 목록에 남아 수정·삭제할 수 있습니다. **Pin to top of list**를 켜면 목록에서 비고정 action보다 먼저 표시되며, 이름 앞 별표 대신 메타데이터에 **Pinned** badge로 표시됩니다.

행을 선택하면 같은 side sheet 안에서 실행 상세와 typed parameter form으로 전환됩니다. 정상 action은 별도의 `Available` badge를 반복 표시하지 않고 Prompt/Script 종류와 설명만 보여 주며, `Running`/`Disabled`/`Unavailable`처럼 조치가 필요한 상태만 추가 badge로 표시합니다. Add/Edit는 실행 화면에서 분리된 전용 `DialogSkeleton`을 사용합니다. 새 Prompt의 Runtime은 Create Card와 같은 사용자 기본값(없으면 `opencode`)을, Model은 선택된 Runtime/Agent의 같은 기본 model resolver를 사용합니다. 설정과 model 목록이 늦게 도착해도 사용자가 Runtime 또는 Model을 직접 선택한 뒤에는 해당 값을 덮어쓰지 않습니다. 기존 Prompt를 수정할 때는 저장된 Runtime/Model/Icon이 우선하며, Script 편집에는 Runtime/Model 필드가 표시되지 않습니다.

### 아이콘 계약

각 action은 표시용 `icon`을 가집니다. 생성 요청에서 생략하면 store가 write lock 안에서 `⚡`, `🔍`, `🧪`, `🚀`, `🛠️`, `📊`, `🧹`, `🛡️`, `🔔`, `📦` 순서로 아직 사용하지 않은 값을 배정합니다. 팔레트가 모두 사용 중이면 생략 생성은 `409`로 실패하며, 실제 실행 가능한 기본 action을 자동 등록하지는 않습니다.

편집 화면은 같은 열 개 팔레트의 현재 선택과 다른 action이 이미 사용 중인 값을 함께 보여 줍니다. 사용 중인 기본 icon은 선택할 수 없고, 팔레트 밖의 custom emoji는 별도 입력에서 지정합니다. UI의 중복 안내와 저장소/API의 거부 오류는 같은 shared 계약을 사용합니다.

custom icon은 화면에 표시 가능한 emoji 한 grapheme만 허용합니다. ZWJ emoji와 flag/keycap emoji는 한 grapheme으로 처리하지만 빈 값, 공백, 제어문자, 일반 텍스트, 둘 이상의 emoji는 거부합니다. NFC 정규화 뒤 모든 action에서 icon은 고유해야 하며 create/update 중복은 `409`입니다. 예전 `quick-actions.json`에서 `icon`이 없는 entry도 삭제하지 않고 pinned/order/createdAt/id 정렬 순서에 따라 결정적이고 서로 다른 fallback을 반환하며, 다음 write 때 함께 저장됩니다.

## Prompt action

Prompt action의 `projectDir`는 필수입니다. 공백일 수 없으며 실행 시 실제로 존재하는 absolute directory여야 합니다. `cardTitleTemplate`, `promptTemplate`, 선택적 `argumentsTemplate`은 정확한 `{{parameterKey}}` placeholder만 지원합니다. unknown, malformed, 값이 없는 placeholder가 남거나 렌더링된 title/prompt가 비어 있으면 카드를 만들기 전에 실패합니다. `argumentsTemplate`은 일반 카드의 arguments처럼 렌더링되어 dispatch되며 `command`가 함께 저장된 경우에만 사용할 수 있습니다.

저장된 `agentRuntime`, `model`, `agentType`, `command`, Codex effort/sandbox, Claude permission mode는 생성 카드에 그대로 복사됩니다. 등록 화면은 새 카드와 동일한 `DirectoryPicker`, `RuntimeModelFields`, `CommandPicker`를 재사용합니다. 이름·설명·effective directory에 `prod`/`production`이 있거나 Prompt가 Codex `danger-full-access` 또는 Claude `bypassPermissions`를 사용하면 확인 checkbox를 선택하기 전까지 **Run Action**이 비활성입니다. 이 확인은 실수 방지 장치이며, 서버는 저장된 action과 directory/parameter를 다시 검증합니다.

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
| `label` | side sheet 실행 form에 표시할 사용자용 이름 |
| `type` | `string`, `number`, `boolean`, `select`, `secret` |
| `required` | string/secret은 공백만 있는 값을 허용하지 않음 |
| `defaultValue` | type과 일치해야 함; secret에는 저장 불가 |
| `options` | select에 필수이며 빈 값·중복을 허용하지 않음 |

정의되지 않은 parameter를 실행 요청에 넣을 수 없습니다. 서로 다른 key가 환경변수 변환 후 같은 이름이 되는 경우도 등록할 수 없습니다. 예를 들어 `fooBar`와 `foo_bar`는 둘 다 `AK_PARAM_FOO_BAR`가 되므로 충돌합니다.

secret parameter는 default를 저장하지 않고 카드의 `parameterSnapshot`에도 남기지 않습니다. 실행 실패 시 side sheet는 사용자가 입력한 값을 유지하므로 값을 검토한 뒤 안전하게 재시도할 수 있습니다.

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

모든 실행 카드는 `originChannel=quick_action`, `quickActionId`, `executionKind=agent|script`를 기록합니다. Quick Action 출처 badge는 실행 종류와 별도로 유지됩니다. agent 카드는 Board/List/Card Detail에서 실제 `OPENCODE`/`CODEX`/`CLAUDE` runtime을 표시하고, Script 카드는 저장 호환용 `agentRuntime` 값과 무관하게 세 화면 모두 `SCRIPT`를 표시합니다. 따라서 Script 실행 카드에 잘못된 `OPENCODE` badge가 나타나지 않습니다. `SCRIPT` badge의 tooltip에는 실행 시점 `scriptName`이 남습니다.

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
- 실패 응답 뒤 side sheet의 parameter 입력은 유지됩니다. 서버가 실패 카드를 저장한 경우 그 카드를 즉시 갱신해 보여주고 다음 클릭에는 새 idempotency key를 사용하므로, 설정/action/script를 바로잡은 뒤 다시 실행할 수 있습니다. 응답을 받지 못한 전송 실패는 결과가 불확실하므로 같은 key를 유지합니다.
- Script 성공만 queue를 진행시킵니다. 실패를 성공으로 바꾸거나 다음 카드를 자동 실행해 오류를 숨기지 않습니다.

## 보안과 화면 계약

Quick Action 생성·수정·삭제·실행은 loopback에서 발급되는 로컬 token 인증을 사용하고 wildcard CORS를 허용하지 않습니다. server가 반환한 action 정의만 신뢰하며 요청은 `clientRequestId`와 `parameterValues` 외 실행 설정을 바꿀 수 없습니다.

launcher와 실행 side sheet는 Board/Card Detail과 동일한 kv2 token/primitive를 사용합니다. desktop launcher는 icon·**Quick** 이름·**›** 방향 힌트를 가로로 표시하는 edge tab입니다. Board의 왼쪽 gutter에 absolute overlay되어 별도 grid column이나 세로 글씨를 만들지 않고, mobile에서는 document flow 안의 같은 가로형 tab으로 바뀝니다. launcher는 sheet id를 가리키는 `aria-controls`, dialog 관계를 나타내는 `aria-haspopup`, 현재 상태의 `aria-expanded`를 제공합니다. 열린 sheet는 이름과 `aria-modal=true`를 가진 `DialogSkeleton`이며 viewport 왼쪽에 overlay되어 Board/List의 폭·컬럼 위치를 바꾸지 않습니다. 오른쪽 배경은 `--kv2-scrim`으로 dim 처리되고 Board/List DOM은 `inert`/`aria-hidden` 상태가 됩니다. backdrop click이나 Escape로 닫으면 launcher로 focus가 돌아갑니다. 좁은 viewport에서는 sheet가 `100vw × 100dvh` 전체 화면을 덮고 safe-area 하단 여백을 확보합니다. Add/Edit Dialog를 열 때 실행 sheet는 언마운트되어 modal/focus trap이 겹치지 않으며, 편집을 닫으면 Add 또는 해당 행의 **•••** 진입점으로 focus가 돌아갑니다. light/dark theme는 모두 같은 semantic token을 사용합니다.
