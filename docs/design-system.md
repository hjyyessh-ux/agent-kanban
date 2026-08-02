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

토큰은 **3계층**으로 나뉩니다. 다크 테마는 **계층 ②만** 덮어씁니다.
자세한 리터럴→토큰 계약은 `docs/dark-mode-token-map.md` 참고.

| 계층 | 그룹 | 예시 | 다크에서 override? |
|------|------|------|--------------------|
| ① 브랜드 (불변) | Status 4종 · Agent 13종 · Runtime 브랜드 · Wiki data-viz | `--kv2-status-todo-accent`, `--kv2-agent-sisyphus`, `--kv2-runtime-claude`, `--kv2-dataviz-troubleshooting` | ❌ 절대 안 바꿈 |
| ② 시맨틱 (테마 가변) | Surface · Text · Border · Neutral ramp · Interactive · Shadow · Status-soft · 역할별 chrome · Inverse | `--kv2-surface`, `--kv2-text-primary`, `--kv2-border`, `--kv2-neutral-500`, `--kv2-control-selected-bg`, `--kv2-column-header-todo-bg`, `--kv2-dialog-shadow-color` | ✅ 이 계층만 |
| ③ 구조 (테마 무관) | Typography · Text scale · Spacing · Radius · Geometry · Transition | `--kv2-font-sans`, `--kv2-text-lg`, `--kv2-sp-4`, `--kv2-radius-md` | — (색 아님) |

Text scale(`--kv2-text-3xs` ~ `--kv2-text-display`)는 전부 `--kv2-font-scale`
배율이 적용됩니다(JS로 설정 — `useFontScale`).

## 다크 테마 (`:root[data-theme="dark"]`)

다크 모드는 `tokens.css` 끝의 `:root[data-theme="dark"]` 블록으로 **계층 ②만**
덮어써 구현됩니다. 계층 ①(브랜드)·③(구조)는 그대로 상속됩니다.

- **토글/상태**: `web/src/hooks/useTheme.ts` — `localStorage 'kanban-theme'`에
  `light`/`dark`/`system` 저장, `system`은 `prefers-color-scheme` 추종,
  `<html>`의 `data-theme`를 `light`/`dark`로 반영. `useFontScale`과 동일한
  패턴(전역 1회 `App.tsx`에서, Settings 탭에 3-way 토글). 테마가 바뀔 때마다
  `window`에 `kanban-theme-change` 커스텀 이벤트를 쏴 캔버스 등 non-CSS
  소비자를 다시 그리게 한다.
- **FOUC 방지**: `web/index.html` `<head>`의 인라인 스크립트가 첫 페인트 전에
  같은 규칙으로 `data-theme`를 선적용한다(훅과 localStorage 키·해석을 미러링).
- **`color-scheme`**: 라이트 `:root`는 `light`, 다크 블록은 `dark` — 네이티브
  스크롤바/체크박스/폼 컨트롤이 테마를 따른다.

### 다크 보정 규칙

- **네오브루탈리즘 하드 섀도**: 다크에서는 밝은 회색 오프셋 블록이 반복되어
  화면 전체가 빛나는 문제를 막기 위해 `--kv2-shadow-color`를
  `rgba(8,10,12,.55)`, `--kv2-shadow-hard-color`를 `#0D0F10`으로 둔다.
  구조는 중성 graphite 보더가
  담당하고, 다이얼로그의 큰 오프셋은 전용 `--kv2-dialog-shadow-color`로 분리한다.
  `#000` 계열 하드 섀도는 계속
  `color-mix(in srgb, var(--kv2-shadow-hard-color) N%, transparent)`를 사용하므로
  라이트 값은 기존과 동일하다.
- **Graphite display 색과 브랜드 원색 분리**: status/agent/runtime 브랜드 토큰
  자체는 바꾸지 않는다. 보드처럼 상태 구분이 핵심인 화면은
  `--kv2-status-*-display`를 사용한다. 컬럼 헤더는 상태색을 섞은 graphite 면과
  6px 상태선, 카드는 8px 원색 accent와 옅은 상태 tint를 사용한다. 런타임 배지는
  중립 pill로 통일하고, 생성·상세 다이얼로그의 큰 런타임 면과 phase/status chrome은
  더 조용한 display 계층을 사용한다.
  보드의 일괄 액션·세션 카운트·FEEDBACK 이동 배너·세션 대화 모달은 각각
  `--kv2-column-action-*`, `--kv2-session-*`, `--kv2-feedback-nav-*` 역할 토큰을
  사용한다. Wiki의 큰 면적과 컨트롤은 `--kv2-wiki-*-display`를 사용하며
  data-viz 원색을 큰 버튼/헤더 배경에 직접 쓰지 않는다.
- **글자와 보더 역할 분리**: `--kv2-border-strong`을 제목/라벨 글자색으로 함께
  쓰면 보더를 낮출 때 글자 대비도 무너진다. 제목은
  `--kv2-strong-title-color`, 라벨은 `--kv2-strong-label-color`, 입력/선택지는
  `--kv2-control-text-color`를 사용한다. 이 토큰들은 라이트에서 기존 값과 같고
  다크에서만 text 역할로 전환된다.
- **Status-soft 패밀리**: 다크 블록에서 각 패밀리를 **불변 accent에 color-mix로
  재앵커**한다 — `surface`는 accent를 dark surface에 소량 섞고, `text`는 accent를
  `--kv2-text-primary`(밝음)에 섞는다. accent 자체는 상속(밝은 마크). 이 방식으로
  ~90개 step을 손으로 고르지 않고 색조를 다크로 끌어내린다.
- **다이얼로그 scrim**: `--kv2-scrim`(백드롭)은 어두운 페이지 위에서 더 진하게,
  라이트박스 배경은 `--kv2-scrim-strong`(전용 토큰).

### WikiGraph 캔버스 (`WikiGraph.tsx`)

캔버스는 CSS가 아니라 draw 시점 문자열을 쓰므로, 테마 가변 색(배경·노드
보더/그림자/라벨 잉크)은 config에서 빼고 **draw 시점에 `getComputedStyle`로
`--kv2-app-bg`/`--kv2-text-primary`를 읽는다**(`readThemeColors`). 링크 rgba도
그 잉크에서 파생해 라이트에선 기존 리터럴과 값-동일하고 다크에선 함께 밝아진다.
`kanban-theme-change` 이벤트로 재-read → `backgroundColor` prop·`paintNode`가
갱신되며 force-graph가 캔버스를 다시 칠한다. 카테고리 색(type/project/topic)은
브랜드/데이터-viz라 config에 남아 사용자 조정 가능(테마 무관). 이에 따라 기어
패널의 "배경"·"테두리/글자" 컬러 피커 2종은 제거됨(토큰이 소스).

규칙:
- 컴포넌트 CSS에 hex/rgba를 하드코딩하지 말 것 — 대응 토큰이 있으면 `var(--kv2-…)`.
- 새 색은 **역할(role)** 기준으로 계층 ②에 토큰을 신설한다(값이 아니라 쓰임새로 고른다).
- 알파 색은 `color-mix(in srgb, var(--kv2-…) N%, transparent)` 형태로. 단
  `--kv2-shadow-color`, `--kv2-shadow-color-ambient`, `--kv2-scrim`는 전용 토큰.
- 계층 ①(브랜드)와 allowlist(syntax·data-viz 색)는 시맨틱 토큰으로 바꾸지 않는다.

### 재유입 방지

- `web/src/styles/no-hardcoded-colors.test.ts`(`bun test`)가 `kanban-v2.tokens.css`와
  `docs/dark-mode-token-map.md`의 allowlist를 제외한 모든 `*.css`를 검사해 새
  hex/rgba 리터럴이 들어오면 실패한다.
- `e2e/theme.e2e.ts`가 토글(light/dark/system) 전환, `data-theme` 반영,
  localStorage 영속, `prefers-color-scheme` 추종을 검증한다.
- `e2e/v2-visual-audit.e2e.ts`는 라이트 스크린샷마다 대응하는 `-dark` variant를
  같이 캡처해 라이트 무회귀와 다크 렌더를 함께 감시한다.

### Agent 브랜드 색 — 단일 소스는 `kanban-v2.tokens.css`

에이전트별 브랜드 색은 `web/src/constants/agents.ts`와
`kanban-v2.tokens.css`(`--kv2-agent-*`) 두 곳에서 쓰이지만, **값의 단일
소스는 tokens.css**다. `agents.ts`의 `PRIMARY_AGENT_VISUALS` /
`AGENT_DISPLAY_OVERRIDES`는 리터럴 hex를 갖지 않고 `var(--kv2-agent-*)`
문자열을 담아, `getAgentConfig().color`를 소비하는 인라인 스타일이
CSS 값 그대로 넘겨받아 렌더링한다(문자열 자체가 CSS 값이므로 색상
연산·파싱 용도로는 쓰지 않는다). 텍스트 색은 브랜드 필 위에서 항상
동일해야 하므로 `--kv2-agent-text-on-fill`(밝은 텍스트) /
`--kv2-agent-text-on-fill-dark`(어두운 텍스트, metis 전용)를 쓴다 —
둘 다 계층 ①이라 카드 5의 다크 테마 오버라이드 대상이 아니다.
새 에이전트를 추가할 때는 반드시 tokens.css에 `--kv2-agent-<key>`를
먼저 추가한 뒤 `agents.ts`에서 참조한다.

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
| `kv2-actions-split` | 좌측 취소 / 우측 진행 액션 행 | 취소 버튼에 `kv2-action-cancel`, 우측 복수 액션은 `kv2-actions-primary`로 그룹화 |

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

### 액션 정렬

- `Cancel`, `Close`, `Dismiss`, `Reset`처럼 현재 작업을 중단하거나 빠져나가는 액션은 왼쪽에 둡니다.
- `Start`, `Create`, `Save`, `Apply`, `Import`, `Submit`처럼 작업을 진행하는 액션은 오른쪽에 둡니다. 가장 중요한 primary action은 가장 오른쪽입니다.
- `Delete` 같은 파괴적 액션은 왼쪽 danger 영역에 분리하고 primary action과 섞지 않습니다.
- 구현은 `kv2-actions-split` + `kv2-action-cancel`을 사용합니다. 진행 버튼이 여러 개면 `kv2-actions-primary`로 묶습니다.

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
