# Kanban 프롬프트 다듬기: 선택적 AI 제안

기본값은 OFF입니다. 기존 카드 모델/API 키/CLI 세션을 자동으로 재사용하지 않습니다. API 방식으로 켜려면 운영자가 이 기능에만 쓸 OpenAI API 프로젝트·모델을 정하고 승인된 환경 비밀 공급 경로로 `KANBAN_PROMPT_OPENAI_API_KEY`를 주입하세요. Structured Outputs를 지원하고 그 프로젝트에서 사용할 수 있는 모델 ID를 `KANBAN_PROMPT_OPENAI_MODEL`에 지정한 뒤, `KANBAN_PROMPT_AI_ENABLED=true`로 실행한 새 프로세스에서만 활성화됩니다. API 키를 카드, 환경 설정 화면, 채팅, 저장소나 로그에 넣지 마세요. ChatGPT 로그인·구독은 OpenAI API 자격증명 대신 사용하지 않습니다.

UI는 제공자와 모델을 버튼에 표시합니다. 사용자가 명시적으로 **AI 제안 생성**을 눌렀을 때만 그 입력칸의 현재 텍스트와 Kanban 고정 지시를 OpenAI에 보냅니다. 카드 저장/실행, 파일·첨부·세션을 읽거나 보내는 일, 외부 도구 사용은 하지 않습니다. 일반 템플릿 버튼은 계속 로컬입니다. 원문 안에 포함된 경로나 비밀은 문자열 일부이므로 클릭 전에 사용자가 확인해야 합니다. 앱은 생성 요청/응답을 별도 저장하거나 기록하지 않습니다. 단, 피드백 편집기의 기존 임시저장 동작은 그대로이고, OpenAI에는 선택한 방식의 과금 또는 구독 한도와 제공자 정책이 적용됩니다. `store:false`는 공급자의 모든 로그/보존이 없다는 뜻이 아닙니다.

`GET/POST /api/prompt-refinement/proposal`은 실제 로컬 소켓 주소와 비어 있지 않은 설치 bearer를 확인합니다. GET은 표시용 메타데이터만 반환하고, POST에는 원문·표시했던 provider/model·동의만 허용합니다. 서버 측 고정 endpoint, 키 서버 전용, redirect 금지, text-only Responses API(JSON schema, `tools:[]`, `store:false`). 최대 원문 20,000자, 작은 응답 제한, 단일 동시 생성, 자동 재시도 없음, 45초 upstream timeout. 취소 후 이미 원격에 전달된 요청 또는 과금을 소급 취소한다고 보장하지 않습니다. 제안·확인 질문은 모델 출력이라 사실로 취급하지 않고, 원문 발췌는 원문에 그대로 존재해야 합니다.

## 방식 · 다듬기 모델 · 완료 조건까지 반복

- **방식**: 모달 기본은 `로컬 템플릿`(네트워크 없음, 기존 동작). `AI 맞춤`은 서버에 공급자가 설정된 경우만 선택 가능하며, 선택해도 **AI 제안 생성** 버튼을 누르기 전에는 아무것도 전송하지 않습니다.
- **다듬기 모델**: 서버가 관리하는 허용 목록에서만 고릅니다. `KANBAN_PROMPT_OPENAI_MODEL`이 기본(목록 첫 항목)이고, 추가 후보는 `KANBAN_PROMPT_OPENAI_MODELS=a,b`(최대 8개, 형식이 틀린 항목은 버림). POST의 `model`이 목록에 없거나 provider가 서버 설정과 다르면 409, endpoint·baseUrl·키 같은 추가 필드는 400입니다. 카드 실행 모델과는 무관하며 바꾸지 않습니다.
- **완료 조건까지 반복**(기본 꺼짐): 문구 생성 옵션일 뿐 작업 등록·저장·실행·자동 반복을 하지 않습니다. 켜면 목표·완료 조건(선택 입력, 비우면 "확인 필요"로 표시하고 지어내지 않음), 검증 방식, `검증→수정·보완→다시 검증` 절차, 중단 조건(조건 충족 / 반복 한도 1–10회, 기본 3 / 권한·승인 필요 / 같은 실패 2회 연속)을 제안합니다. AI 모드에서도 반복 절차·중단 조건 섹션은 로컬에서 항상 덧붙여 모델 출력에 의존하지 않습니다. POST 본문은 `loop: {goal, doneWhen, maxRounds}`만 허용합니다.
- **안전장치**: 원문은 항상 맨 앞에 그대로 남고(선행 `/명령`, `$skill`, `@멘션` 보존), 적용 전 검토·선택·취소·되돌리기는 그대로입니다. AI 출력에 원문에 없는 권한 상승·운영 변경 지시(`git push`, `sudo`, `kubectl apply`, `--dangerously-skip-permissions` 등)가 있으면 응답 전체를 거부합니다.
- **테스트**: `src/__tests__/synthetic-prompt-provider.ts`는 네트워크·키 없이 받은 model/loop를 되돌려 주는 합성 공급자입니다. e2e는 브라우저 요청을 합성 공급자로만 연결합니다. 실제 OpenAI 호출은 테스트하지 않습니다.

- [Responses API](https://developers.openai.com/api/reference/resources/responses/methods/create)
- [Structured model outputs](https://developers.openai.com/api/docs/guides/structured-outputs)

## 화면과 모델 목록

넓은 화면에서는 원문 옆 패널, 좁은 화면에서는 하단 패널에서 설정 → 제안 검토 → 선택 적용을 진행합니다. 선택한 제안은 원문에 추가되며 카드를 저장하거나 실행하지 않습니다.

설정의 ‘다듬기 모델’과 패널의 모델 선택기는 서버 허용 목록을 그대로 표시합니다. 카드 실행용 Model Visibility는 별개입니다. 연결이 없으면 샘플 모델을 표시하거나 전송하지 않고 로컬 템플릿만 제공합니다.

두 화면 크기와 모델 목록 일치 검증은 `bunx playwright test e2e/prompt-refinement-loop.e2e.ts`로 실행합니다. 외부 모델은 호출하지 않습니다.

## 별도 옵션: macOS Codex CLI (OpenAI API 키 없이)

- macOS 로컬 서버에서만 명시적으로 설정할 수 있습니다. `KANBAN_PROMPT_CODEX_ENABLED=true`, `KANBAN_PROMPT_CODEX_BINARY`(심볼릭 링크가 아닌 실제 네이티브 Codex 실행 파일의 절대 경로), `KANBAN_PROMPT_CODEX_BINARY_SHA256`(확인한 실행 파일의 소문자 SHA-256), `KANBAN_PROMPT_CODEX_MODEL`(기본값), 선택적으로 `KANBAN_PROMPT_CODEX_MODELS`(추가 모델)을 설정합니다. 실행 파일 업데이트 시 검증 후 해시를 갱신하세요.
- 운영자가 승인한 전용 Codex 로그인으로 `$HOME/.agent-kanban/prompt-refinement-codex/auth`에 파일 기반 인증을 준비해야 합니다. 디렉터리와 인증 파일은 현재 사용자만 접근할 수 있어야 하고 일반 Codex 인증이나 기존 CLI 세션을 복사·자동 재사용하지 않습니다. 전용 인증 파일을 저장소, 카드, 로그에 넣지 마세요. 사용자 구성/스킬 파일을 여기에 두지 마세요.
- CLI를 선택하면 실패 또는 설정 오류가 있어도 OpenAI API 방식으로 자동 전환하지 않습니다. 로그인, 모델, 실행 파일 또는 운영체제 샌드박스가 준비되지 않은 경우 CLI 제안은 동작하지 않습니다. 이 기능은 로그인 설치/설정 자체를 자동으로 수행하지 않습니다.
- CLI도 로컬 추론이 아닙니다. **AI 제안 생성**을 누르면 원문, Kanban 고정 지시 및 작성한 반복 조건이 OpenAI에 전송됩니다. 전용 파일 인증, 제한된 환경, 임시 세션, macOS 프로세스 샌드박스를 사용하며 카드 실행 모델, 워크스페이스, 일반 Codex 구성, 외부 도구를 사용하지 않습니다. 원격 추론에 필요한 네트워크는 열려 있습니다. 구독 한도와 OpenAI의 데이터 정책이 적용될 수 있습니다.
- 회귀 테스트는 실제 macOS 샌드박스에서 합성 실행 파일로만 동작합니다 (`AK_VERIFY_MAC_SANDBOX=1 bun test src/__tests__/prompt-refinement-codex.test.ts`). 로그인, 구독 모델 가용성 및 실제 OpenAI 호출은 검증하지 않습니다.
