# agent-kanban

agent-kanban은 opencode/Codex/Claude runtime 세션, Telegram follow-up, feedback 재작업, 스케줄러, 스크립트, 설정을 한곳에서 관리하는 플러그인 + 웹 UI입니다.

## 목차

| 문서 | 설명 |
|------|------|
| [시작하기](./getting-started.md) | 설치, 설정, 첫 번째 카드 만들기 |
| [Kanban 보드](./kanban-board.md) | 컬럼 구조, 카드 lifecycle, parent-child, Telegram/feedback 흐름 |
| [Quick Actions](./quick-actions.md) | Prompt/Script action 등록, 파라미터, 실행 추적, 실패 복구 |
| [스케줄러](./scheduler.md) | 반복 작업 설정, cron 표현식, 자연어 입력 |
| [플러그인 도구](./plugin-tools.md) | kanban / scheduler / settings 도구 계약 |
| [API 레퍼런스](./api-reference.md) | cards, runtimes, sessions, schedulers, settings, scripts, screenshots, models, questions API |
| [아키텍처](./architecture.md) | 시스템 구조, 데이터 흐름, 모듈 설명 |

## 주요 기능

**Kanban 보드**
- 4단계 워크플로: TODO, In Progress, Complete, Done
- AI 세션에서 카드 자동 생성 (chat.message 훅 연동)
- New Task에서 Opencode/Codex/Claude runtime 선택
- 카드 큐 시스템으로 순차적 작업 디스패치 및 큐 시작 세션 모드 선택
- 서브에이전트 계층 구조 (부모-자식 카드 연결)
- feedback 카드의 원본 session 재사용
- Telegram follow-up의 기존 session 재사용
- 완료 카드 월별 아카이브

**스케줄러**
- cron 표현식 또는 자연어로 반복 작업 설정 ("매 5분마다", "every hour")
- shell 명령 실행 및 opencode 스킬 호출 지원
- 실행 이력 기록 및 수동 즉시 실행

**운영 UI / 도구**
- Board / Scheduler / Scripts / Settings 탭 제공
- Board의 Quick Actions launcher에서 저장된 Prompt/Script 작업을 파라미터와 함께 즉시 실행
- pending question 배너와 question reply/reject 흐름 제공
- kanban 7개, scheduler 6개, settings 2개 도구 제공

**REST API**
- Bun.serve() 기반 HTTP 서버 (포트 24680)
- cards, quick-actions, schedulers, settings, scripts, screenshots, models, questions 엔드포인트 제공
- same-origin CORS와 loopback 로컬 토큰으로 변경·실행 요청 보호

**웹 UI**
- Board/Card Detail을 기준으로 한 kv2 token·primitive 디자인 시스템
- React SPA (Vite, 포트 5173)
- board/questions 3초 폴링, scheduler/scripts/settings 10초 폴링
- 보드 / 스케줄러 / 스크립트 / 설정 탭 전환

## 빠른 시작

```bash
bun install        # 의존성 설치
bun run build      # 플러그인 + 웹 UI 빌드
bun run dev        # 개발 서버 실행 (포트 5173)
```

빌드 후 opencode 설정에 플러그인을 등록하면 AI 세션에서 kanban 도구를 바로 사용할 수 있습니다. 자세한 설정 방법은 [시작하기](./getting-started.md)를 참고하세요.

## 기술 스택

| 영역 | 기술 |
|------|------|
| 런타임 | Bun |
| HTTP 서버 | Bun.serve() |
| 웹 프레임워크 | React 19 + Vite |
| 플러그인 플랫폼 | opencode plugin API |
| 스케줄러 | croner (cron 라이브러리) |
| 영속성 | 파일시스템 JSON (`~/.agent-kanban/`) |
| 스타일링 | 순수 CSS (kv2 디자인 토큰/primitive) |

## 데이터 저장 위치

모든 데이터는 로컬 파일시스템에 저장됩니다.

```
~/.agent-kanban/
├── active.json          # 현재 보드 카드 상태
├── schedulers.json      # 스케줄러 상태와 실행 이력
├── settings.json        # 설정/시크릿 메타데이터
├── scripts.json         # 스크립트와 실행 이력
├── quick-actions.json   # Prompt/Script Quick Action 정의와 idempotency 예약
├── telegram-state.json  # Telegram selected session / sticky defaults
├── runtime-runs/        # runtime run index와 run artifact
├── archive/             # done 카드 월별 아카이브
└── screenshots/         # 업로드된 카드 스크린샷
```
