# agent-kanban 시작 가이드

agent-kanban은 AI 코딩 보조 CLI 도구인 opencode의 플러그인입니다. AI 작업을 세션을 넘어 칸반 보드로 추적하고, 반복 작업을 자동화하는 스케줄러를 내장하고 있습니다. 수동 생성 작업은 Opencode, Codex, Claude runtime 중 하나로 실행할 수 있습니다. 이 가이드는 처음 사용하는 분들을 위해 설치부터 첫 번째 카드 생성까지 단계별로 안내합니다.

---

## 사전 요구사항

설치 전에 아래 도구들이 시스템에 준비되어 있는지 확인하세요.

### Bun (v1.0 이상)

agent-kanban의 런타임이자 패키지 매니저입니다. Node.js보다 빠른 JavaScript/TypeScript 실행 환경을 제공합니다.

```bash
# Bun 설치 (미설치 시)
curl -fsSL https://bun.sh/install | bash

# 버전 확인
bun --version
```

### Node.js (v20.19 이상 또는 v22.12 이상)

Playwright와 Vite production build가 Node.js를 사용합니다. Node 18에서는 현재 Vite가 지원 버전 경고를 내므로 위 버전을 사용합니다.

```bash
node --version
```

### opencode CLI

opencode는 터미널에서 동작하는 AI 코딩 보조 도구입니다. 코드 작성, 디버깅, 리팩터링 등 다양한 작업을 AI와 함께 수행할 수 있습니다. agent-kanban은 이 CLI의 플러그인으로 동작합니다.

```bash
# opencode 설치 (미설치 시)
npm install -g opencode

# 버전 확인
opencode --version
```

### Codex / Claude CLI (선택)

Codex 또는 Claude runtime으로 실제 dispatch를 실행하려면 로컬 CLI와 계정 설정이 필요합니다. CI/E2E에서는 실제 비용 호출을 하지 않고 fake binary와 fake runtime 서버로 검증합니다.

```bash
codex --version
claude --version
```

---

## 설치

### 저장소 클론

```bash
git clone https://github.com/hjyyessh-ux/agent-kanban.git
cd agent-kanban
```

### 의존성 설치

```bash
bun install
```

### 빌드

플러그인(Bun build)과 웹 UI(Vite)를 함께 빌드합니다.

```bash
bun run build
```

빌드가 완료되면 `dist/plugin/index.js`에 플러그인 번들이 생성되고, `web/dist/`에 웹 UI 정적 파일이 생성됩니다.

---

## opencode 플러그인 등록

`./scripts/install.sh`는 플러그인 번들(`dist/plugin/index.js`)과 웹 자산(`web/dist`)을 전역 플러그인 디렉터리 `~/.config/opencode/plugins/agent-kanban/`로 복사하고, `~/.config/opencode/opencode.json`의 `plugin` 배열에 전역 플러그인 엔트리를 추가합니다.

이 저장소는 프로젝트 로컬 `opencode.json` 자동 감지가 아니라, 전역(global) 플러그인 로딩을 기준으로 설치/실행합니다.

---

## 서버 실행

별도로 서버를 수동으로 실행할 필요가 없습니다. opencode에서 플러그인이 로드되는 순간 `ServerMonitor` 클래스가 자동으로 HTTP 서버를 시작합니다.

### 기본 포트

서버는 기본적으로 **24680번 포트**에서 실행됩니다.

```
http://localhost:24680
```

### 포트 충돌 처리

24680번 포트가 이미 사용 중이라면, 서버는 자동으로 다음 포트를 순서대로 시도합니다.

```
24680 → 24681 → 24682
```

최대 3번 연속으로 재시도하며, 모두 실패하면 오류를 반환합니다.

### 포트 직접 지정

환경 변수로 포트를 직접 지정할 수 있습니다.

```bash
KANBAN_PORT=3000 opencode
```

### 서버 상태 모니터링

`ServerMonitor`는 10초마다 서버 상태를 확인합니다. 서버가 예기치 않게 종료되면 자동으로 재시작을 시도합니다. 이를 통해 장시간 실행 중 서버가 중단되어도 자동 복구됩니다.

---

## 웹 UI 접근

서버가 실행된 후 브라우저에서 아래 주소로 접근합니다.

```
http://localhost:24680
```

### Board 탭

AI 작업 카드들을 칸반 보드 형식으로 표시합니다. 카드는 다음 4가지 상태를 가집니다.

- **TODO**: 대기 중인 작업
- **In Progress**: 현재 진행 중인 작업
- **Complete**: AI가 완료했지만 사람의 검토가 필요한 작업
- **Done**: 최종 완료된 작업

카드를 클릭하면 상세 정보를 확인하고 상태를 변경할 수 있습니다. 상단의 "새 카드" 버튼으로 카드를 직접 생성할 수도 있습니다. Telegram에서 들어온 후속 메시지, feedback 재작업 카드, subagent child card도 이 보드에서 함께 추적됩니다.

Board의 TODO 왼쪽 여백에 있는 **⚡ Quick ›** edge tab을 누르면 반복 Prompt나 Script를 modal side sheet에서 등록하고 즉시 실행할 수 있습니다. desktop launcher는 icon·이름·열림 방향을 가로로 보여 주면서 Board 폭을 차지하지 않고, mobile에서는 Board 위의 가로형 tab으로 표시됩니다. sheet가 열려도 Board/List의 폭과 컬럼 위치는 유지되고, 오른쪽 배경은 dim 처리되어 클릭과 focus가 차단됩니다. 각 action에는 서로 겹치지 않는 기본 icon이 자동 배정되며 custom emoji도 지정할 수 있습니다. 새 Prompt는 **New Task**와 같은 Runtime/Model 기본값을 사용합니다. Script action의 파라미터는 명령 인수가 아니라 `AK_PARAM_*` 환경변수로 전달되고, production/elevated action은 확인 checkbox를 선택하기 전에는 실행할 수 없습니다. 실행은 일반 Board 카드로 추적되며 Script 카드는 Board/List/Detail에서 runtime 대신 `SCRIPT`로 표시됩니다. 자세한 등록·파라미터·실패 복구 규칙은 [Quick Actions](./quick-actions.md)를 참고하세요.

### Scheduler 탭

반복 작업을 등록하고 관리하는 스케줄러 뷰입니다. cron 표현식 또는 자연어(예: "매 5분마다", "every hour")로 실행 주기를 설정할 수 있습니다. 각 작업의 실행 이력도 이 탭에서 확인할 수 있습니다.

### Scripts / Settings 탭

- **Scripts**: `~/.agent-kanban/scripts/`(또는 `KANBAN_DATA_DIR/scripts/`)에서 동기화된 스크립트와 수동 생성 스크립트를 실행/추적합니다.
- **Settings**: Telegram 토큰, network exposure, 기타 런타임 설정을 관리합니다.

### Capabilities 탭: MCP와 Skill 관리

Capabilities의 **Inventory**에서는 Claude/Codex MCP와 Claude/Codex/OpenCode Skill을 함께 확인합니다. All/Claude/Codex/OpenCode 필터는 MCP와 Skill 행에 동일하게 적용되며 각 행의 runtime badge로 같은 이름의 항목도 즉시 구분할 수 있습니다. 같은 이름의 Claude/Codex MCP는 각각 `claude:<name>`, `codex:<name>` identity를 사용하므로 상세 보기와 mutation 대상이 섞이지 않습니다.

MCP 설정 위치는 runtime에 따라 다릅니다.

| Runtime | 전역 설정 | 디렉터리 설정 |
|---|---|---|
| Claude | `~/.claude.json` | local: `~/.claude.json`의 `projects[dir]`, project: `<dir>/.mcp.json` |
| Codex | `~/.codex/config.toml` | `<dir>/.codex/config.toml` |

Placement Targets에서 runtime과 디렉터리를 등록하면 실제 설정 파일 경로가 표시됩니다. Codex는 project root부터 target directory까지의 `.codex/config.toml` chain을 읽으며 가까운 디렉터리의 같은 이름 정의가 우선합니다. Inventory placement에는 실제 config path, 적용 디렉터리, effective/overridden 상태가 표시됩니다.

Codex project 설정은 Codex에서 해당 디렉터리가 trusted project일 때만 로드됩니다. agent-kanban은 신뢰 여부를 추측하거나 자동 변경하지 않습니다. 설정을 copy/move/remove/freeze/restore한 뒤에는 새 세션을 시작하거나 Codex 클라이언트를 재시작해야 반영될 수 있습니다.

모든 MCP 파일 변경은 diff Preview 후 Apply로 진행합니다. team-shared target에 평문 secret으로 보이는 값이 있으면 추가 확인 없이는 진행되지 않습니다. Claude의 기존 `alwaysLoad`와 JSON/CLI 흐름은 유지되며 Codex에는 `alwaysLoad`를 기록하지 않습니다. Codex에서는 `enabled`, `enabled_tools`, `disabled_tools` 같은 runtime 고유 옵션을 사용합니다.

---

## Telegram 연동

Telegram 봇을 연결하면 채팅으로 새 작업을 시작하고, 선택한 세션에 후속 메시지를 보낼 수 있습니다.

### 봇 만들기와 토큰 등록

1. Telegram에서 [@BotFather](https://t.me/BotFather)를 열고 `/newbot`을 보내 봇 이름과 username을 정합니다.
2. BotFather가 알려주는 bot token(`123456:ABC-...` 형태)을 복사합니다.
3. 웹 UI **Settings 탭 → Add entry**에서 key를 `TELEGRAM_BOT_TOKEN`, value를 복사한 토큰으로 저장합니다.

별도 재시작은 필요 없습니다. 백그라운드 poller가 5초마다 설정에서 토큰을 다시 읽으므로, 저장 직후부터 봇이 메시지를 수신합니다. 토큰이 처음 감지되면 봇의 명령 메뉴(`/sessions`, `/codex`, `/claude`, 모델 설정 명령 등)도 자동으로 등록됩니다.

### 사용 방법

- 봇에게 일반 텍스트를 보내면 새 카드가 생성되어 기본 런타임으로 즉시 실행됩니다.
- `/sessions`로 세션 목록을 보고 `/switch_session <번호>`로 선택하면, 이후 일반 텍스트는 해당 세션의 후속 메시지로 전달됩니다.
- `/runtime`, `/codex_model`, `/claude_model`, `/directory` 등으로 채팅별 기본값을 바꿀 수 있습니다. 전체 목록은 `/help`로 확인합니다.
- `/directory /path/to/project`로 지정한 경로는 다른 경로를 지정하거나 `/directory clear`로 해제할 때까지 이후 새 세션의 기본 경로로 유지됩니다. 새 세션 시작 및 기존 세션 후속 전달 응답에는 실제 적용 경로가 함께 표시됩니다.

### 접근 제한 (선택)

Settings에 `TELEGRAM_CHANNEL_IDS` key를 추가하고 허용할 chat id를 쉼표로 나열하면, 그 외 채팅의 메시지는 무시됩니다. 설정하지 않으면 봇 토큰을 아는 모든 채팅이 사용할 수 있으므로, 토큰을 노출하지 않도록 주의하세요.

---

## 데이터 저장 위치

모든 데이터는 로컬 파일 시스템의 JSON 파일로 저장됩니다.

```
~/.agent-kanban/
├── active.json          # 현재 칸반 보드 상태
├── schedulers.json      # 스케줄러 등록 정보 및 실행 이력
├── settings.json        # 설정 항목
├── scripts.json         # 스크립트와 실행 이력
├── quick-actions.json   # Prompt/Script Quick Action과 실행 예약
├── telegram-state.json  # Telegram selected session / sticky defaults
├── runtime-runs/        # Codex/Claude run index와 artifact
├── archive/
│   └── 2026-03.json     # 월별 아카이브 (완료 카드)
└── screenshots/         # 카드 첨부 스크린샷 파일
```

데이터 디렉터리를 변경하려면 `KANBAN_DATA_DIR` 환경 변수를 설정합니다.

```bash
KANBAN_DATA_DIR=/path/to/custom/dir opencode
```

### 보안 주의사항

- HTTP 서버는 기본적으로 `127.0.0.1`(localhost)에만 바인딩되어 같은 머신에서만 접근할 수 있습니다.
- API는 동일 출처(same-origin)만 허용하고, 변경·시크릿·스크립트 API는 loopback에만 발급되는 로컬 토큰 인증을 요구합니다(drive-by/CSRF 차단).
- `TELEGRAM_BOT_TOKEN` 등 모든 시크릿은 `settings.json`에 **평문(plaintext) JSON**으로 저장됩니다. 디스크 상에서는 암호화되지 않으며, Settings 탭의 "mask" 토글은 화면 표시용일 뿐입니다.
- Settings에서 network exposure를 켜면 서버가 `0.0.0.0`에 바인딩됩니다. 원격 기기는 토큰을 받지 못해 읽기 전용으로 제한되지만 시크릿은 디스크에 평문으로 남으므로, **신뢰할 수 없는 네트워크에서는 활성화하지 마세요.** 자세한 내용은 [SECURITY.md](../SECURITY.md) 참고.

---

## 개발 모드

코드를 수정하면서 실시간으로 확인하려면 개발 모드를 사용합니다.

### 웹 UI 개발 서버

Vite 개발 서버를 5173번 포트에서 실행합니다. 파일 변경 시 브라우저가 자동으로 새로고침됩니다.

```bash
bun run dev
```

브라우저에서 아래 주소로 접근합니다.

```
http://localhost:5173
```

개발 서버는 API 요청을 24680번 포트의 백엔드 서버로 프록시합니다. 웹 UI와 백엔드 서버를 별도 터미널에서 동시에 실행해야 합니다.

### 백엔드 직접 실행

빌드 없이 standalone daemon(기본 진입점)을 직접 실행하여 백엔드 서버만 띄울 수 있습니다.

```bash
bun start
```

opencode plugin runtime이 필요하면 `bun run dev:plugin`을 사용합니다.

---

## 첫 번째 카드 만들기

### 방법 1: 웹 UI에서 생성

1. 브라우저에서 `http://localhost:24680`에 접근합니다.
2. Board 탭의 상단 오른쪽 "새 카드 만들기" 버튼을 클릭합니다.
3. 제목(필수)과 설명을 입력합니다.
4. Runtime을 선택합니다.
5. Opencode는 preset/모델을 선택합니다.
6. Codex는 모델, reasoning effort, sandbox를 선택합니다.
7. Claude는 모델과 permission mode를 선택합니다.
8. 선택적으로 프로젝트 디렉터리 경로를 입력합니다.
9. "만들기" 버튼을 클릭하면 TODO 컬럼에 카드가 추가됩니다.

`agentRuntime`이 없는 기존 card는 `opencode`로 취급됩니다. dispatch 후 card의 `sessionId`는 runtime별 actual continuation id입니다. Codex는 `thread_id`, Claude는 `session_id`를 확보한 뒤에만 `sessionId`를 저장합니다.

### 방법 2: 플러그인 도구에서 생성

opencode 세션 내에서 `kanban_create` 도구를 직접 호출할 수 있습니다.

```
kanban_create 도구 호출 예시:
- title: "API 엔드포인트 구현"
- description: "사용자 인증 관련 REST API 엔드포인트를 설계하고 구현합니다."
- projectDir: "/Users/user/my-project"
```

카드가 생성되면 고유 ID와 함께 TODO 상태로 보드에 추가됩니다. 웹 UI를 새로고침하면 즉시 확인할 수 있습니다.

---

## 테스트 실행

### 유닛 및 통합 테스트

Bun의 내장 테스트 러너로 `src/__tests__/` 회귀/유닛/통합 테스트를 실행합니다.

```bash
bun test
```

이 테스트는 스토어 로직, 플러그인 훅, Telegram 세션 재사용, feedback session reuse, 서버 라우트, 스케줄러 등 핵심 기능을 검증합니다.

취약한 워크플로를 먼저 확인하려면 아래 순서를 권장합니다.

```bash
bun test src/__tests__/plugin-hooks.test.ts
bun test src/__tests__/telegram-poller.test.ts
bun test src/__tests__/feedback-session-reuse.test.ts
bun test src/__tests__/telegram-state-store.test.ts
bun test src/__tests__/workflow-regression.test.ts
bun test src/__tests__/runtime-registry.test.ts
bun test src/__tests__/dispatch-routing.test.ts
bun test src/__tests__/codex-jsonl-parser.test.ts
bun test src/__tests__/codex-cli-adapter.test.ts
bun test src/__tests__/claude-stream-parser.test.ts
bun test src/__tests__/claude-adapter.test.ts
bun test src/__tests__/queue-helper.test.ts
bun test src/__tests__/stale-checker.test.ts
```

### E2E 테스트

Playwright로 `e2e/` 브라우저 테스트를 실행합니다.

```bash
bun run test:e2e
```

E2E 테스트는 `e2e/` 디렉터리에 위치합니다. 테스트 실행 시 자동으로 테스트용 서버(포트 24681)를 시작하고 테스트가 끝나면 종료합니다.

runtime 통합 UI를 좁혀서 확인하려면 다음 테스트를 실행합니다.

```bash
bun run test:e2e -- e2e/runtime-integration.e2e.ts
```

### 타입 검사

TypeScript 타입 오류가 없는지 확인합니다.

```bash
bunx tsc --noEmit
```

## Known limitations

- 실제 Codex/Claude CLI 호출은 CI에 포함하지 않습니다. fake binary/unit test와 `e2e/runtime-integration.e2e.ts` fake runtime, 필요 시 수동 smoke로 검증합니다.
- Codex/Claude 실행은 로컬 CLI 설치, 로그인 상태, 네트워크, 과금 정책의 영향을 받습니다.
- Codex/Claude는 actual continuation id를 얻기 전까지 `sessionId`를 저장하지 않으므로, id timeout 시 card는 `todo`로 복귀하고 `progressSummary=[failed] ...`가 남습니다.
- Telegram selected-session state는 runtime metadata를 보존합니다. 현재 `src/plugin/telegram-poller.ts`는 안전 가드로 `/sessions` 후보를 opencode session으로 제한하므로, Codex/Claude Telegram follow-up을 릴리즈하려면 runtime-aware adapter resume 테스트를 먼저 통과시켜야 합니다.

---

## 문제 해결

### 서버가 시작되지 않을 때

포트 충돌 여부를 먼저 확인합니다.

```bash
lsof -i :24680
```

프로세스가 있다면 종료하거나, `KANBAN_PORT` 환경 변수로 다른 포트를 지정합니다.

### 빌드 오류가 발생할 때

의존성이 올바르게 설치되었는지 확인합니다.

```bash
bun install
bun run build
```

`dist/` 디렉터리가 생성되지 않았다면 빌드가 실패한 것입니다. 오류 메시지를 확인하여 원인을 파악하세요.

### 웹 UI에 데이터가 표시되지 않을 때

백엔드 서버가 실행 중인지 확인합니다.

```bash
curl http://localhost:24680/api/cards
```

응답이 없다면 플러그인이 로드되지 않은 것입니다. `./scripts/install.sh`를 다시 실행해 전역 플러그인 파일이 최신인지 확인하고, `~/.config/opencode/opencode.json`에 `agent-kanban` 플러그인 엔트리가 있는지 확인하세요.
