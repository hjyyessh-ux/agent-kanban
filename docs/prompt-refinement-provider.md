# Kanban 프롬프트 다듬기: 선택적 AI 제안

기본값은 OFF입니다. 기존 카드 모델/API 키/CLI 세션을 자동으로 재사용하지 않습니다. API 방식으로 켜려면 운영자가 이 기능에만 쓸 OpenAI API 프로젝트·모델을 정하고 승인된 환경 비밀 공급 경로로 `KANBAN_PROMPT_OPENAI_API_KEY`를 주입하세요. Structured Outputs를 지원하고 그 프로젝트에서 사용할 수 있는 모델 ID를 `KANBAN_PROMPT_OPENAI_MODEL`에 지정한 뒤, `KANBAN_PROMPT_AI_ENABLED=true`로 실행한 새 프로세스에서만 활성화됩니다. API 키를 카드, 환경 설정 화면, 채팅, 저장소나 로그에 넣지 마세요. ChatGPT 로그인·구독은 OpenAI API 자격증명 대신 사용하지 않습니다.

UI는 제공자와 모델을 버튼에 표시합니다. 사용자가 명시적으로 **AI 제안 생성**을 눌렀을 때만 그 입력칸의 현재 텍스트와 Kanban 고정 지시를 OpenAI에 보냅니다. 카드 저장/실행, 파일·첨부·세션을 읽거나 보내는 일, 외부 도구 사용은 하지 않습니다. 일반 템플릿 버튼은 계속 로컬입니다. 원문 안에 포함된 경로나 비밀은 문자열 일부이므로 클릭 전에 사용자가 확인해야 합니다. 앱은 생성 요청/응답을 별도 저장하거나 기록하지 않습니다. 단, 피드백 편집기의 기존 임시저장 동작은 그대로이고, OpenAI에는 선택한 방식의 과금 또는 구독 한도와 제공자 정책이 적용됩니다. `store:false`는 공급자의 모든 로그/보존이 없다는 뜻이 아닙니다.

`GET/POST /api/prompt-refinement/proposal`은 실제 로컬 소켓 주소와 비어 있지 않은 설치 bearer를 확인합니다. GET은 표시용 메타데이터만 반환하고, POST에는 원문·표시했던 provider/model·동의만 허용합니다. 서버 측 고정 endpoint, 키 서버 전용, redirect 금지, text-only Responses API(JSON schema, `tools:[]`, `store:false`). 최대 원문 20,000자, 작은 응답 제한, 단일 동시 생성, 자동 재시도 없음, 45초 upstream timeout. 취소 후 이미 원격에 전달된 요청 또는 과금을 소급 취소한다고 보장하지 않습니다. 제안·확인 질문은 모델 출력이라 사실로 취급하지 않고, 원문 발췌는 원문에 그대로 존재해야 합니다.

## 방식 · 다듬기 모델 · 완료 조건까지 반복

- **방식**: 모달 기본은 `기본 틀 추가 · AI 호출 없음`(네트워크 없음). 코드에 정해 둔 목표·맥락·계획·검증 틀을 원문 아래에 붙일 뿐 원문을 분석·추론하지 않습니다. 항목별 본문 편집·선택 해제가 가능하고, 적용 후 `되돌리기`는 적용 직전 원문으로 정확히 복원합니다(적용 뒤 직접 고친 경우는 자동 복원하지 않음). `AI 맞춤 제안 · 모델 호출`은 선택 가능한 모델이 있을 때만 켜지며, **AI 제안 생성** 버튼을 누르기 전에는 아무것도 전송하지 않습니다.
- **다듬기 모델 카탈로그**: `GET /api/prompt-refinement/proposal`의 `catalog`가 제공자별(Codex CLI · OpenAI · Claude CLI) 전체 항목을 내려줍니다. 카드 카탈로그(`CODEX_MODELS`, `CLAUDE_MODELS`)의 모델도 보이지만, **선택 가능**은 ① 해당 전송 경로가 서버에 설정되고 ② 점검(고정 실행 파일·전용 로그인 파일 존재·구조화 출력)이 통과하고 ③ 서버 허용 목록에 있는 모델뿐입니다. 나머지는 숨기지 않고 이유와 설정 위치(환경 변수 이름)를 함께 표시합니다. 점검은 모델을 호출하지 않으며 자격증명 내용을 읽지 않습니다(존재 여부만 `lstat`). OpenAI는 사전 호출을 하지 않으므로 스키마 지원은 운영자 허용 목록을 근거로 합니다.
- **기존 1개 제약 확장**: 모델 추가는 `KANBAN_PROMPT_CODEX_MODELS=a,b` / `KANBAN_PROMPT_OPENAI_MODELS=a,b`(최대 8개, 형식이 틀린 항목은 버림) 후 서버 재시작입니다. Codex와 OpenAI를 둘 다 설정하면 둘 다 표시되며, 서버 기본값은 준비된 첫 제공자(Codex CLI 우선)입니다. 요청은 고른 제공자에 고정되고 실패해도 다른 제공자로 넘기지 않습니다. 비용은 제공자별로 다릅니다(Codex: 전용 로그인 계정 구독 한도, Claude: 평소 로그인 계정 구독 한도, OpenAI: 전용 API 프로젝트 과금). Claude CLI는 설치된 `claude`와 평소 로그인을 그대로 써서 별도 설정 없이 선택할 수 있습니다(아래 ‘Claude CLI’ 참고, 미로그인이면 이유와 설정 위치만 표시). `_MODELS`를 비우면 허용 목록은 기본 모델 + 카드 카탈로그의 같은 런타임 모델(Codex: `CODEX_MODELS`, Claude: `CLAUDE_MODELS`)이고, 최대 32개입니다.
- **오류 처리**: 알 수 없는 제공자 409 `provider_changed`, 허용 목록 밖 모델 409 `model_not_allowed`, 점검 실패 503 `provider_not_ready`(호출 안 함), 동시 생성 429, 공급자 오류 502. 클라이언트는 409/503 때 카탈로그를 다시 읽고 원문은 그대로 둡니다. endpoint·baseUrl·키 같은 추가 필드는 400입니다.
- **기본값과 이번 선택**: 설정 › 다듬기 모델에서 **기본값 저장**을 눌러야만 `PUT /api/prompt-refinement/default`(`{provider, model}`만 허용)가 호출되고, 서버가 현재 카탈로그로 다시 검증한 뒤(선택 불가면 409) `<data dir>/prompt-refinement-prefs.json`(0600)에 저장합니다. 재시작 후에도 유지되며, 읽을 때마다 재검증해 더 이상 쓸 수 없으면 서버 기본값으로 시작하고 이유를 표시합니다. `DELETE`는 저장값을 지웁니다. 모달에서 바꾼 모델은 그 생성 세션에만 쓰이고 저장되지 않습니다. 카드 실행 Model Visibility(`kanban-enabled-models`)와 저장 위치·값이 분리돼 있습니다.
- **완료 조건까지 반복**(기본 꺼짐): 문구 생성 옵션일 뿐 작업 등록·저장·실행·자동 반복을 하지 않습니다. 켜면 목표·완료 조건(선택 입력, 비우면 "확인 필요"로 표시하고 지어내지 않음), 검증 방식, `검증→수정·보완→다시 검증` 절차, 중단 조건(조건 충족 / 반복 한도 1–10회, 기본 3 / 권한·승인 필요 / 같은 실패 2회 연속)을 제안합니다. AI 모드에서도 반복 절차·중단 조건 섹션은 로컬에서 항상 덧붙여 모델 출력에 의존하지 않습니다. POST 본문은 `loop: {goal, doneWhen, maxRounds}`만 허용합니다.
- **안전장치**: 원문은 항상 맨 앞에 그대로 남고(선행 `/명령`, `$skill`, `@멘션` 보존), 적용 전 검토·선택·취소·되돌리기는 그대로입니다. AI 출력에 원문에 없는 권한 상승·운영 변경 지시(`git push`, `sudo`, `kubectl apply`, `--dangerously-skip-permissions` 등)가 있으면 응답 전체를 거부합니다.
- **테스트**: `src/__tests__/synthetic-prompt-provider.ts`는 네트워크·키 없이 받은 model/loop를 되돌려 주는 합성 공급자입니다. e2e 서버(`scripts/test-server.ts`)는 `E2E_SYNTHETIC_PROMPT_PROVIDER=true`일 때만 합성 OpenAI(모델 2개)와 "전용 로그인 없음" 상태의 합성 Codex(호출 시 예외)를 연결합니다. 1개·0개 모델과 오류 상황은 브라우저에서 카탈로그를 모킹합니다. 실제 모델 호출은 테스트하지 않습니다.

- [Responses API](https://developers.openai.com/api/reference/resources/responses/methods/create)
- [Structured model outputs](https://developers.openai.com/api/docs/guides/structured-outputs)

## 검토 화면 (좌우 분할)

제안을 받으면 왼쪽에 **원문**(원문 발췌 구절 강조)과 **본문에 추가될 섹션**(적용될 텍스트 그대로), 오른쪽에 **제안 카드**가 구역(목적 · 조사 조건 · 실행 계획 · 완료 조건 · 검증 · 제약 · 기타)별로 나옵니다. 상단 분류(결정 필요 · 확인 필요 · 변경 제안 · 원문 유지)로 할 일만 걸러 볼 수 있고, 카드마다 `본문에 넣기 / 본문에서 빼기 / 편집`을 합니다. 모달이 좁아지면(컨테이너 720px 이하, 모바일 포함) `원문 / 제안 / 결과` 탭으로 바뀝니다.

- **결정 필요**: 선택지를 고르기 전에는 본문에 넣을 수 없고, 적용 시 자동으로 빠집니다. 고르면 `→ 결정: <선택지>`가 덧붙습니다.
- **확인 필요**: 답을 입력하면 `→ 답변: <입력>`이 덧붙고, 비우면 질문 그대로 남습니다.
- 응답 형식: 각 섹션은 `{kind, slot, title, body, options}` (`kind`에 `decision` 추가, `slot` 7종, `decision`만 선택지 2–4개, 그 외 `options: []`). 이전 3필드 형식도 계속 받습니다. 선택지도 권한 상승 문구 검사를 거칩니다. 기본 틀(로컬)도 같은 구역·분류를 고정 매핑합니다.

## 화면과 모델 목록

넓은 화면에서는 원문 옆 패널, 좁은 화면에서는 하단 패널에서 설정 → 제안 검토 → 선택 적용을 진행합니다. 선택한 제안은 원문에 추가되며 카드를 저장하거나 실행하지 않습니다.

설정의 ‘다듬기 모델’과 모달의 모델 선택기는 같은 서버 카탈로그를 씁니다. 선택기는 제공자별 그룹으로 모든 항목을 보여 주고, 선택 불가 항목은 `aria-disabled`와 이유·설정 위치를 함께 표시하며 눌러도 선택되지 않습니다. 설정 화면은 기본값 저장, 저장값 지우기, 연결 상태 다시 확인(모델 호출 없음)을 제공합니다. 연결이 없으면 샘플 모델을 켜지 않고 기본 틀 추가만 제공합니다.

검증: `E2E_SYNTHETIC_PROMPT_PROVIDER=true bunx playwright test e2e/prompt-refinement-models.e2e.ts e2e/prompt-refinement-loop.e2e.ts` (캡처는 `PROMPT_REFINEMENT_SHOTS=<dir>`). 외부 모델은 호출하지 않습니다.

## 별도 옵션: macOS Codex CLI (OpenAI API 키 없이)

- macOS 로컬 서버에서만 명시적으로 설정할 수 있습니다. `KANBAN_PROMPT_CODEX_ENABLED=true`, `KANBAN_PROMPT_CODEX_BINARY`(심볼릭 링크가 아닌 실제 네이티브 Codex 실행 파일의 절대 경로), `KANBAN_PROMPT_CODEX_BINARY_SHA256`(확인한 실행 파일의 소문자 SHA-256), `KANBAN_PROMPT_CODEX_MODEL`(기본값), 선택적으로 `KANBAN_PROMPT_CODEX_MODELS`(추가 모델)을 설정합니다. 실행 파일 업데이트 시 검증 후 해시를 갱신하세요.
- 운영자가 승인한 전용 Codex 로그인으로 `$HOME/.agent-kanban/prompt-refinement-codex/auth`에 파일 기반 인증을 준비해야 합니다. 디렉터리와 인증 파일은 현재 사용자만 접근할 수 있어야 하고 일반 Codex 인증이나 기존 CLI 세션을 복사·자동 재사용하지 않습니다. 전용 인증 파일을 저장소, 카드, 로그에 넣지 마세요. 사용자 구성/스킬 파일을 여기에 두지 마세요.
- CLI를 선택하면 실패 또는 설정 오류가 있어도 OpenAI API 방식으로 자동 전환하지 않습니다. 로그인, 모델, 실행 파일 또는 운영체제 샌드박스가 준비되지 않은 경우 CLI 제안은 동작하지 않습니다. 이 기능은 로그인 설치/설정 자체를 자동으로 수행하지 않습니다.
- CLI도 로컬 추론이 아닙니다. **AI 제안 생성**을 누르면 원문, Kanban 고정 지시 및 작성한 반복 조건이 OpenAI에 전송됩니다. 전용 파일 인증, 제한된 환경, 임시 세션, macOS 프로세스 샌드박스를 사용하며 카드 실행 모델, 워크스페이스, 일반 Codex 구성, 외부 도구를 사용하지 않습니다. 원격 추론에 필요한 네트워크는 열려 있습니다. 구독 한도와 OpenAI의 데이터 정책이 적용될 수 있습니다.
- 회귀 테스트는 실제 macOS 샌드박스에서 합성 실행 파일로만 동작합니다 (`AK_VERIFY_MAC_SANDBOX=1 bun test src/__tests__/prompt-refinement-codex.test.ts`). 로그인, 구독 모델 가용성 및 실제 OpenAI 호출은 검증하지 않습니다.

## Claude CLI (평소 로그인 사용)

별도 로그인·환경 변수 없이, 설치된 `claude` CLI와 **평소 Claude 로그인**을 그대로 씁니다.

- **켜짐 조건**: `claude` 실행 파일을 찾으면 자동으로 켜집니다. 찾는 순서는 `KANBAN_PROMPT_CLAUDE_BINARY` → `PATH` → `~/.local/bin/claude`입니다.
- **끄기**: `KANBAN_PROMPT_CLAUDE_ENABLED=false`로 끕니다.
- **모델 설정 (선택)**:
  - `KANBAN_PROMPT_CLAUDE_MODEL`: 기본 모델입니다.
  - `KANBAN_PROMPT_CLAUDE_MODELS`: 허용 목록입니다. 비워 두면 카드 카탈로그의 `CLAUDE_MODELS`를 씁니다.
- **준비 점검**: `claude auth status --json`의 종료 코드와 `loggedIn` 값만 봅니다. 모델은 호출하지 않으며, 계정 정보는 화면에 내보내지 않습니다. 로그인이 안 되어 있으면 터미널에서 `claude`를 실행해 로그인한 뒤 "연결 상태 다시 확인"을 누릅니다.
- **요청 형식**: 매 요청은 비어 있는 임시 디렉터리에서 실행되고 끝나면 삭제됩니다. stdin에는 초안만 들어갑니다.

  ```sh
  claude -p --output-format json --model <m> --tools "" --strict-mcp-config --mcp-config '{"mcpServers":{}}'
    --disable-slash-commands --no-session-persistence --settings '{"disableAllHooks":true}'
    --system-prompt <kanban skill> --json-schema <fixed schema>
  ```

- **차단하는 것**:
  - 도구, MCP, 슬래시 명령을 끕니다.
  - 세션을 저장하지 않습니다.
  - 훅을 끕니다(`disableAllHooks`). 그래서 평소 훅이 칸반 카드나 세션을 만들지 않습니다.
- **그대로 쓰는 것**:
  - 사용자 `settings.json`의 env 설정(프록시, Vertex 등)과 `~/.claude/CLAUDE.md` 메모리는 그대로 적용될 수 있습니다.
  - 부모 Claude 세션 표식인 `CLAUDECODE`, `CLAUDE_CODE_ENTRYPOINT`는 자식 프로세스에 넘기지 않습니다.
- **비용·전송**: 평소 계정의 구독 한도가 적용되고, 원문은 Anthropic으로 전송됩니다. "AI 제안 생성"을 명시적으로 클릭하기 전에는 아무것도 전송하지 않습니다.
- **테스트**: 단위 테스트(`src/__tests__/setup.ts`)와 e2e 서버(`scripts/test-server.ts`)는 기본값을 `KANBAN_PROMPT_CLAUDE_ENABLED=false`로 두어 실제 `claude`를 실행하지 않습니다. 단위 테스트는 가짜 spawn으로 argv와 점검을 확인합니다.
