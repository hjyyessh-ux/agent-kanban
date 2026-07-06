# Design System (kv2)

> **UI를 추가하거나 고치기 전에 반드시 이 문서를 읽으세요.**
> 이 프로젝트의 UI는 Main Board 카드와 Card Detail 다이얼로그에서 확립된
> `kv2` 디자인 시스템 하나로 통일됩니다. 새 화면·새 기능이 자체 스타일이나
> 자체 모달을 만들어 붙이는 것이 이 시스템의 가장 흔한 파손 경로입니다.

## 구조

| 파일 | 역할 |
|------|------|
| `web/src/styles/kanban-v2.tokens.css` | 전역(`:root`) 디자인 토큰 — 모든 토큰은 `--kv2-` 접두사 |
| `web/src/styles/kanban-v2.components.css` | `@import` 배럴 — 캐스케이드 순서 보존, **순서 변경 금지** |
| `web/src/styles/kv2/board.css` | 보드 레이아웃, 컬럼, done 세션 그룹, 카드, 카드 액션 |
| `web/src/styles/kv2/primitives.css` | 다이얼로그 셸, 폼 요소, 버튼, 다이얼로그 푸터/액션 |
| `web/src/styles/kv2/card-detail.css` | 디테일/생성 다이얼로그 레이아웃, 에이전트 셀렉터, 라디오, 배지 |
| `web/src/styles/kv2/panels.css` | 디테일 사이드바 패널들(세션/메타/phase/진행/질문/피드백/스크린샷/큐) |
| `web/src/styles/kv2/conversation.css` | 세션 대화 모달 |

kv2 CSS는 `main.tsx`에서 단 한 번 전역 import됩니다. 컴포넌트에서 kv2 파일을
다시 import하지 마세요. 화면 전용 CSS(`Wiki.css` 등)는 **레이아웃만** 담고,
색·타이포·컨트롤 외관은 토큰과 프리미티브에 위임합니다.

## 토큰 레퍼런스 (`kanban-v2.tokens.css`)

| 그룹 | 예시 | 용도 |
|------|------|------|
| Status 색 | `--kv2-status-todo-accent`, `--kv2-status-done-bg` | 컬럼/카드/다이얼로그의 상태 색 |
| Agent 색 | `--kv2-agent-sisyphus` … | 에이전트 pill/칩 |
| Surface | `--kv2-app-bg`, `--kv2-frame` | 배경/프레임 |
| Typography | `--kv2-font-sans/mono/heading` | 글꼴 스택 |
| Text scale | `--kv2-text-3xs` ~ `--kv2-text-lg` | 크기 — 전부 `--kv2-font-scale` 배율 적용(JS로 설정) |

규칙: 컴포넌트 CSS에 hex를 하드코딩하지 말 것 — 대응 토큰이 있으면 `var(--kv2-…)`.

## 프리미티브

새 UI는 아래 클래스를 조합해서 만듭니다. **로컬 CSS에서 이 클래스들을
재정의(override)하는 것은 금지**입니다 — 필요한 변형이 없으면 variant를
`primitives.css`에 추가하세요.

| 클래스 | 용도 | Variants |
|--------|------|----------|
| `kv2-btn` | 모든 버튼 | `--primary`, `--primary-strong`, `--success`, `--danger`, `--subtle-danger`, `--ghost`, `--outline`, `--small`, `--full` |
| `kv2-input` / `kv2-select` / `kv2-textarea` | 폼 컨트롤 | — |
| `kv2-label`, `kv2-form-group` | 필드 라벨/그룹 | `kv2-form-group--embedded` |
| `kv2-badge` | 상태/카운트 배지 | `--accent`, `--queue`, `--saved`, `--session` |
| `kv2-panel-heading`, `kv2-panel-subtitle` | 패널 제목/부제 | — |
| `kv2-dialog-*` | 모달 구조 (아래 DialogSkeleton 참고) | 상태 variant `kv2-dialog--status-*` |

공용 컴포넌트: 에러 표시는 `shared/ErrorAlert`(`.error-banner`)를 사용합니다.

## 모달 = DialogSkeleton, 예외 없음

모든 모달은 `web/src/components/Card/DialogSkeleton.tsx`를 사용합니다.
직접 오버레이 div를 만들지 마세요 (`*-modal-overlay` 류의 신규 클래스 금지).

DialogSkeleton이 제공하는 계약:

- 구조: `.kv2-dialog-overlay` → `.kv2-dialog-backdrop`(클릭 닫기) →
  `.kv2-dialog`(`role="dialog"`, `aria-modal`) → `.kv2-dialog-header/-title/-close` → `.kv2-dialog-content`
- 접근성: `useModalAccessibility` (포커스 트랩 + Escape 닫기)
- 크기 기억: `persistSizeKey`를 주면 `usePersistedDialogSize`로 리사이즈+localStorage 저장
- 커스텀은 `className` prop으로 `kv2-dialog--*` variant를 얹는 방식

## 새 화면/기능 추가 체크리스트

1. Board 카드와 Card Detail을 먼저 열어보고 같은 룩을 목표로 한다.
2. 버튼/입력/배지/제목은 위 프리미티브 클래스 그대로 사용한다.
3. 모달이 필요하면 DialogSkeleton — 자체 오버레이 금지.
4. 색·크기는 `--kv2-` 토큰으로만; 하드코딩 hex/px(타이포) 금지.
5. 화면 전용 CSS 파일은 레이아웃(grid/flex/gap)만 담는다. 프리미티브 재정의 금지.
6. CSS import는 추가하지 않는다 — kv2는 이미 전역. 화면 CSS 하나만 컴포넌트 옆에.
7. e2e 셀렉터는 role/텍스트 우선, 필요 시 `.kv2-*` 클래스.

## 금지 패턴

- ❌ `.neo-*` 재도입 (레거시 시스템은 완전히 폐기됨)
- ❌ 프리미티브 클래스의 로컬 재정의 (`.my-screen .kv2-btn { … }`)
- ❌ 자체 모달 오버레이/백드롭 구현
- ❌ `kanban-v2.components.css` 배럴 밖에서 kv2 파일 직접 import
- ❌ 토큰이 있는데 hex/px 하드코딩
- ❌ CSS-in-JS, Tailwind, CSS Modules (프로젝트 전체 금지)
