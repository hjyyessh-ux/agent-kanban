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
| ① 브랜드 (불변) | Status 4종 · Agent 13종 · Runtime 브랜드 · Wiki data-viz · Works affinity | `--kv2-status-todo-accent`, `--kv2-agent-sisyphus`, `--kv2-runtime-claude`, `--kv2-dataviz-troubleshooting`, `--kv2-dir-1..8` | ❌ 절대 안 바꿈 |
| ② 시맨틱 (테마 가변) | Surface · Text · Border · Neutral ramp · Interactive · Shadow · Status-soft · 역할별 chrome · Inverse | `--kv2-surface`, `--kv2-text-primary`, `--kv2-border`, `--kv2-neutral-500`, `--kv2-control-selected-bg`, `--kv2-column-header-todo-bg`, `--kv2-dialog-shadow-color` | ✅ 이 계층만 |
| ③ 구조 (테마 무관) | Typography · Text scale · Spacing · Radius · Geometry · Transition | `--kv2-font-sans`, `--kv2-text-lg`, `--kv2-sp-4`, `--kv2-radius-md` | — (색 아님) |

Text scale(`--kv2-text-3xs` ~ `--kv2-text-display`)는 전부 `--kv2-font-scale`
배율이 적용됩니다(JS로 설정 — `useFontScale`).

### Works affinity 팔레트 (`--kv2-dir-1..8`, `--kv2-affinity-chain`)

Works 배정 화면에서 `projectDir`을 해시해 고정 색을 주는 **범주형(categorical)** 시리즈입니다. 테마 면색이 아니므로 다크에서 override하지 않습니다.

#### 두 축으로 8칸을 가른다 (색조 + 명도)

색조만으로는 부족했습니다. 첫 팔레트는 8칸 중 3칸(`#2f6fed`·`#2f9bd0`·`#4b5bd6`)이 34° 안에 몰려 있어서, 체크아웃이 4개인 머신에서는 **파란 점 4개**가 떴습니다. 그래서 두 축을 씁니다.

| 축 | 규칙 | 가드 |
|----|------|------|
| 색조 | 8칸이 색상환에 **45° 등간격**. 링을 회전시켜 `--kv2-affinity-chain`(h 259, 계보 신호)이 간격의 정중앙(양쪽 22.5°)에 오게 둡니다 — 45° 링이 계보에 줄 수 있는 최대치 | `worksAffinity.test.ts` — 인접 색조 간격 하한 30°, 계보 색조와 모든 칸의 거리 하한 20° |
| 상대 명도 | 색조상 이웃한 칸은 명도가 번갈아 밝고 어둡습니다(0.07 ~ 0.36, 모든 이웃 쌍이 최소 1.4:1) → 그레이스케일·4px 바·색약에서도 링이 살아남습니다 | `styles/token-contrast.test.ts` |

```
h  12 #a7361b 벽돌 │ h  57 #a9a019 금  │ h 102 #357718 숲   │ h 147 #34b76e 에메랄드
h 192 #107a93 청록 │ h 237 #787fed 남  │ h 282 #712593 포도 │ h 327 #dd4b9c 마젠타
                     h 259 #8b5cf0 = --kv2-affinity-chain (계보, 디렉토리 아님)
```

#### 스와치 색과 **글자 색은 다른 토큰**입니다

`--kv2-dir-{n}`은 바·틴트용 **스와치**입니다. 글자에 그대로 쓰면 구조적으로 한쪽 테마에서 AA를 못 넘깁니다(크림 위에서 읽히는 중간 명도는 그래파이트 위에서 너무 어둡고, 그 반대도 마찬가지). 실제로 `--kv2-dir-2`는 라이트에서 3.7:1, `--kv2-affinity-chain`은 다크에서 3.1:1이었습니다.

그래서 칸마다 **텍스트 쌍둥이**가 있습니다 — `--kv2-dir-{n}-text`, `--kv2-affinity-chain-text`. `color-mix(in srgb, <스와치> N%, var(--kv2-text-primary))`로 스와치를 본문 잉크 쪽으로 당겨 양 테마 4.5:1을 확보하되 색조는 남깁니다. 비율은 칸마다 다릅니다(금 58%, 포도 34%) — 같은 자리에 도달하는 데 필요한 혼합량이 색조마다 다르기 때문입니다.

- 텍스트 쌍둥이는 **선언이 하나**지만 계층 ②입니다. `var(--kv2-text-primary)`는 *사용 지점*에서 치환되고 다크 블록이 같은 요소에서 그 값을 다시 정의하므로, 선언 하나가 두 테마에서 각각 옳게 풀립니다.
- 컴포넌트는 `.works-dir-c{n}`이 실어주는 **`--works-dir-accent`(스와치)와 `--works-dir-text`(글자)** 만 읽습니다. 색 리터럴이나 `--kv2-dir-3` 직접 참조를 컴포넌트 CSS에 쓰지 마세요.
- 칸을 늘리려면 **`--kv2-dir-{n}` + `--kv2-dir-{n}-text` + `.works-dir-c{n}` 규칙을 함께** 추가하고 `worksAffinity.ts`의 `DIR_COLOR_SLOTS`를 올려야 합니다. 세 개 중 하나라도 빠지면 위 두 테스트가 잡습니다.

#### 칩은 점이 아니라 **이름을 물들입니다**

8~10px 점은 색조의 가장 작은 표본이고, 그 점이 "이게 어느 프로젝트냐"를 혼자 감당하고 있었습니다 — 그 크기에서 이웃한 두 칸은 같은 점입니다. 지금은 `.works-dir-chip` / `.works-dir-mark`가 **디렉토리명 자체에 배경 틴트**(`color-mix(… 14%, var(--kv2-surface))`)와 텍스트 쌍둥이를 입힙니다. 색조와 그것이 가리키는 글자가 같은 자리에 있고, 한 단어만큼의 면적을 신호에 씁니다.

`.works-dir-dot`은 **Timeline 라벨에만** 남았습니다. 그 행은 이미 전체 높이 색 띠를 갖고 있어서 틴트 블록이 서로 싸우기 때문입니다.

### Timeline: 네 층을 서로 다른 축에

Timeline(Board 탭의 `타임라인` 뷰)은 한 화면에 **디렉토리 · Work · 세션 · 카드** 네 가지를 동시에 그립니다. 보드의 상태 4색이 이미 색상환을 차지하고 있으므로, 네 층에 같은 축(색조)을 쓰면 무엇이 무엇인지 구분되지 않습니다. 그래서 층마다 다른 축을 씁니다.

| 층 | 토큰 | 왜 이 색인가 |
|----|------|--------------|
| 디렉토리 그룹 | `--works-dir-accent`(`.works-dir-c{n}`) 왼쪽 색 띠 | Works 탭과 **같은 색 = 같은 프로젝트**. 새 색을 만들지 말고 기존 팔레트를 재사용 |
| Work 계획 바 | `--kv2-timeline-work-bar`(진행 중, 스틸 블루) / `--kv2-timeline-work-bar-done`(완료, 차분한 녹색) / `--kv2-timeline-work-bar-fg` | 바는 *계획*이지 카드 상태가 아님 — 카드 상태 팔레트(`--kv2-status-*`)는 쓰지 않습니다. 단 Work 자체의 두 종착점은 구분해야 해서, 진행 중은 파랑·완료는 녹색 + `✔ 완료` 마크, 폐기는 회색입니다(회색 완료 바는 draft로 읽혔습니다). `--kv2-surface-inverse`를 쓰지 않는 이유는 다크에서 그 값이 기본 면색과 한 톤 차이라 바가 **빈 외곽선**처럼 읽혔기 때문 — 그래서 라이트/다크에 각각 명시값을 둔 계층 ② 토큰입니다 |
| 세션 레일 | `--kv2-affinity-chain`(보라) | 어떤 카드 상태도 쓰지 않는 색조 → 레일이 상태로 오해되지 않습니다 |
| 카드 날짜 칸 | `--kv2-status-{todo,progress,complete,done}-display` | 보드와 **같은 의미를 같은 색으로**. 여기서 색을 새로 정하면 보드와 어긋납니다 |

규칙:

- Work 바에 **카드** 상태 색(`--kv2-status-*`)을 쓰지 마세요. `.tl-bar--active`/`--done`의 값은 Work 전용 토큰 `--kv2-timeline-work-bar*`이고, 그 둘만이 Work의 상태를 말합니다.
- 세션 레일에 디렉토리 팔레트 색을 쓰지 마세요. "같은 색 = 같은 디렉토리"가 무너집니다.
- 날짜 칸이 하루에 여러 카드를 담을 때 칠하는 색은 **가장 살아있는 상태**입니다(`in_progress` > `todo` > `complete` > `done` — `timelineRows.ts`의 `CELL_STATUS_PRIORITY`). 정착 상태인 `done`이 손이 필요한 카드를 덮지 않게 하려는 것입니다.

#### 범례는 색이 아니라 **라벨**로 오독을 막습니다

`complete`의 색은 보드의 분홍-빨강(`--kv2-status-complete-accent`)이고 그건 **실패로 읽힙니다.** 그렇다고 여기서 색을 바꾸면 위 표의 마지막 줄("보드와 같은 의미를 같은 색으로")이 무너지므로, **색은 그대로 두고 라벨이 의미를 말합니다.**

| 상태 | 라벨 (`TIMELINE_STATUS_LABELS`) | 왜 |
|------|--------------------------------|-----|
| `todo` | `대기` | |
| `in_progress` | `진행중` | |
| `complete` | **`검토 대기`** | 빨강이지만 실패가 아니라 "에이전트는 끝났고 사람 확인을 기다린다" |
| `done` | `완료` | 예전 범례는 `완료`(빨강)와 `Done`(초록)을 한 줄에 섞어 한 화면에서 상태를 두 언어로 불렀습니다 |

- 라벨의 단일 소스는 `timelineRows.ts`의 `TIMELINE_STATUS_LABELS`입니다. 범례와 날짜 칸 tooltip이 같은 상수를 씁니다.
- **범례 항목은 실제 그려진 것만 나옵니다** — `timelineLegend(rows)`가 rows에서 유도합니다. 고정 6칸이던 시절엔 `대기` 스와치가 상주했는데, 실행된 카드만 그리드에 들어오므로 가리킬 대상이 없는 항목이었습니다. 새 상태 색을 추가하면 처음 그려지는 순간 범례에도 자동으로 나타납니다.

#### 반응형: 인라인 폭은 덮을 수 없으니 **상한을** 건다

라벨 열 폭은 사용자가 드래그로 정하고 `--tl-label-width`를 `.timeline`에 **인라인**으로 얹습니다 — 스타일시트 규칙은 인라인 스타일을 이길 수 없습니다. 그래서 그리드 트랙은 `--tl-label-track: min(var(--tl-label-width), var(--tl-label-cap))`을 읽고, 미디어 쿼리는 `--tl-label-cap`만 낮춥니다(900px → 180px, 480px → 132px). 사용자가 고른 값이 상한보다 작으면 그대로 존중됩니다. `!important`를 쓰지 마세요.

`Timeline.css`에는 미디어 쿼리가 **하나도 없었습니다** — 390px에서 툴바가 잘렸습니다. 지금은 900px에서 범례가 `margin-left: auto`를 버리고 자기 줄로 내려가고, 480px에서 `--tl-col-min`이 줄고 가로 스크롤 안내(`.tl-mobile-hint`)가 나타납니다.

## 다크 테마 (`:root[data-theme="dark"]`)

다크 모드는 `kanban-v2.tokens.css` 끝의 `:root[data-theme="dark"]` 블록으로 **계층 ②만**
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
| `kv2-btn` | 모든 버튼 | `--primary`, `--primary-strong`, `--success`, `--danger`, `--subtle-danger`, `--ghost`, `--outline`, `--small`, `--full`, `--edge-tab` |
| `kv2-input` / `kv2-select` / `kv2-textarea` | 폼 컨트롤 | — |
| `kv2-label`, `kv2-form-group` | 필드 라벨/그룹 | `kv2-form-group--embedded` |
| `kv2-badge` | 상태/카운트 배지 | `--accent`, `--queue`, `--saved`, `--session` |
| `kv2-panel-heading`, `kv2-panel-subtitle` | 패널 제목/부제 | — |
| `kv2-dialog-*` | 모달 구조 (아래 DialogSkeleton 참고) | 상태 variant `kv2-dialog--status-*` |
| `kv2-actions-split` | 좌측 취소 / 우측 진행 액션 행 | 취소 버튼에 `kv2-action-cancel`, 우측 복수 액션은 `kv2-actions-primary`로 그룹화, 좌측 파괴적 액션이 2개 이상이면 `kv2-actions-danger`로 그룹화 |
| `kv2-meta-dropdown` | 커스텀 드롭다운(네이티브 `<select>` 대체) | `--inline` — 조밀한 행 안의 아이콘 트리거용 |

공용 컴포넌트: 에러 표시는 `shared/ErrorAlert`(`.error-banner`)를 사용합니다.

### 컨테이너가 다르면 로컬 override가 아니라 variant

기본 `kv2-meta-dropdown`은 사이드바 **필드** 치수(`width: 100%; flex: 1`)입니다.
이걸 행 안의 아이콘 버튼에 쓰면서 로컬에서 `flex`만 덮으면 `width: 100%`가 남아
flex base size가 되고, **행 전체를 차지해 `min-width: 0`인 형제가 0px로 찌그러집니다**
(Work 상세의 세션 행이 제목을 통째로 잃은 실제 사례). 조밀한 행에서는
`kv2-meta-dropdown--inline`을 함께 붙이고, 다이얼로그 안의 트리거라면
`useAnchoredPopover(w, { boundarySelector: '.kv2-dialog' })`로 팝오버가 다이얼로그
아래로 삐져나가지 않게 합니다.

## 모달 = DialogSkeleton, 예외 없음

모든 모달은 `web/src/components/Card/DialogSkeleton.tsx`를 사용합니다.
직접 오버레이 div를 만들지 마세요 (`*-modal-overlay` 류의 신규 클래스 금지).

DialogSkeleton이 제공하는 계약:

- 구조: `.kv2-dialog-overlay` → `.kv2-dialog-backdrop`(클릭 닫기) →
  `.kv2-dialog`(`role="dialog"`, `aria-modal`) → `.kv2-dialog-header/-title/-close` → `.kv2-dialog-content`
- 접근성: `useModalAccessibility` (포커스 트랩 + Escape 닫기)
- 크기 기억: `persistSizeKey`를 주면 `usePersistedDialogSize`로 리사이즈+localStorage 저장
- 커스텀은 `className` prop으로 `kv2-dialog--*` variant를 얹는 방식
- 왼쪽 modal side sheet는 `overlayClassName="kv2-dialog-overlay--side-sheet"`와
  `className="kv2-dialog--side-sheet"` 조합을 사용한다. desktop은 배경 geometry를 유지한 채 overlay하고 mobile은 full viewport가 된다.
- `dialogId`는 launcher의 `aria-controls` 대상에 사용하고, `initialFocusRef`는 sheet가 열릴 때 첫 업무 action으로 focus를 보낼 때 사용한다.

### 액션 정렬

- `Cancel`, `Close`, `Dismiss`, `Reset`처럼 현재 작업을 중단하거나 빠져나가는 액션은 왼쪽에 둡니다.
- `Start`, `Create`, `Save`, `Apply`, `Import`, `Submit`처럼 작업을 진행하는 액션은 오른쪽에 둡니다. 가장 중요한 primary action은 가장 오른쪽입니다.
- `Delete` 같은 파괴적 액션은 왼쪽 danger 영역에 분리하고 primary action과 섞지 않습니다. 파괴적 액션이 둘 이상이면 `kv2-actions-danger`로 묶고 **위험도가 낮은 것부터** 놓습니다 (예: Work 상세 푸터의 `폐기…`(카드는 그대로) → `삭제…`(Work 자체 제거)).
- 구현은 `kv2-actions-split` + `kv2-action-cancel`을 사용합니다. 진행 버튼이 여러 개면 `kv2-actions-primary`로 묶습니다.
- **`auto` 마진 두 개 사이에 버튼을 두지 마세요.** `kv2-action-cancel`(`margin-right: auto`)과
  `kv2-actions-primary`(`margin-left: auto`) 사이에 낀 버튼은 좌우 어디에도 붙지 못하고
  푸터 가운데에 떠 버립니다 (BulkAssignModal의 `폐기`가 이 상태였습니다). 좌측에 두 종류
  이상을 놓아야 하면 `kv2-actions-danger`로 묶거나, 진행 성격의 액션은 오른쪽 그룹으로 옮깁니다.
- 다이얼로그가 아닌 패널의 푸터도 같은 규칙입니다. 로컬 푸터 클래스를 `kv2-actions-split`과
  함께 쓸 때 그 클래스는 **간격만** 지정합니다 — `justify-content`나 버튼별 마진은 금지
  (프리미티브의 `auto` 마진과 충돌).

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
