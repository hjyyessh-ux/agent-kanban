# 플러그인 도구 레퍼런스

## 개요

이 플러그인은 12개의 도구(칸반 6개 + 스케줄러 6개)를 제공한다. AI 에이전트는 이 도구들을 통해 칸반 보드와 스케줄러를 조작한다. 도구들은 opencode에 등록되며, AI 코딩 세션 중 언제든지 호출할 수 있다.

도구 등록은 `src/plugin/tools/index.ts`의 `createKanbanTools()`와 `createSchedulerTools()`에서 처리한다. 모든 도구는 플러그인에 번들된 zod(`tool.schema`)로 입력을 검증하며, 반환값은 항상 `string` 타입이다.

---

## 칸반 도구 (6개)

### 1. kanban_create

새 칸반 카드를 생성한다.

**설명**: 제목과 설명을 받아 칸반 보드에 새 카드를 추가한다. 생성된 카드는 기본적으로 `todo` 상태로 시작하며, 슬래시 커맨드나 스킬 컨텍스트 정보를 함께 기록할 수 있다.

**파라미터**

| 이름 | 타입 | 필수 | 설명 |
|------|------|------|------|
| title | string | 필수 | 카드 제목 |
| description | string | 필수 | 카드 설명 |
| projectDir | string | 선택 | 작업 대상 프로젝트 디렉토리 경로 |
| command | string | 선택 | 카드를 트리거한 슬래시 커맨드 |
| skills | string[] | 선택 | 세션에 로드된 스킬 목록 |
| sourceContext | string | 선택 | 카드 생성 당시의 소스 컨텍스트 |
| model | string | 선택 | 사용 중인 AI 모델 이름 |

**반환값**: 생성된 카드의 ID와 현재 상태를 담은 JSON 문자열

---

### 2. kanban_update

기존 카드의 상태, 진행 상황, 결과를 업데이트한다.

**설명**: 진행 중인 작업의 상태 변경이나 중간 진행 상황 기록, 최종 결과 저장에 사용한다. 큐 위치도 함께 조정할 수 있다.

**파라미터**

| 이름 | 타입 | 필수 | 설명 |
|------|------|------|------|
| id | string | 필수 | 업데이트할 카드 ID |
| status | 'todo' \| 'in_progress' \| 'complete' \| 'done' | 선택 | 변경할 새 상태 |
| progressSummary | string | 선택 | 현재까지의 진행 상황 요약 |
| result | string | 선택 | 작업 완료 결과 내용 |
| queuePosition | number | 선택 | 큐에서의 위치 번호 |
| queuedAfterCardId | string | 선택 | 이 카드 앞에 위치할 카드의 ID |

**반환값**: 업데이트된 카드의 요약 정보를 담은 JSON 문자열

---

### 3. kanban_get

카드 ID로 특정 카드의 상세 정보를 조회한다.

**설명**: 카드의 모든 필드를 반환한다. 현재 상태 확인, 이전 결과 조회, 부모 카드 연결 정보 확인 등에 활용한다.

**파라미터**

| 이름 | 타입 | 필수 | 설명 |
|------|------|------|------|
| id | string | 필수 | 조회할 카드 ID |

**반환값**: 카드의 전체 상세 정보를 담은 JSON 문자열

---

### 4. kanban_list

보드의 카드 목록을 조회한다. 상태별 필터링이 가능하다.

**설명**: 전체 보드 상태를 파악하거나 특정 상태의 카드만 추려볼 때 사용한다. 결과는 읽기 좋은 텍스트 형식으로 포맷된다.

**파라미터**

| 이름 | 타입 | 필수 | 설명 |
|------|------|------|------|
| status | 'todo' \| 'in_progress' \| 'complete' \| 'done' | 선택 | 조회할 상태 (생략 시 전체 조회) |

**반환값**: 보드 요약 정보가 담긴 포맷된 텍스트 문자열

---

### 5. kanban_delete

카드를 영구 삭제한다.

**설명**: 지정한 카드를 보드에서 완전히 제거한다. 이 작업은 되돌릴 수 없다. 완료된 카드를 보관하려면 삭제 대신 `kanban_archive`를 사용하는 것이 좋다.

**파라미터**

| 이름 | 타입 | 필수 | 설명 |
|------|------|------|------|
| id | string | 필수 | 삭제할 카드 ID |

**반환값**: 삭제 확인 메시지를 담은 JSON 문자열

---

### 6. kanban_archive

완료 상태(`done`)인 카드를 월별 아카이브 파일로 이동한다.

**설명**: 완료된 카드들을 활성 보드에서 분리해 월별 아카이브로 보관한다. `cardIds`를 지정하지 않으면 `done` 상태인 모든 카드를 아카이브한다.

**파라미터**

| 이름 | 타입 | 필수 | 설명 |
|------|------|------|------|
| cardIds | string[] | 선택 | 아카이브할 카드 ID 목록. 생략 시 done 상태의 모든 카드를 아카이브 |

**반환값**: 아카이브 처리 결과(아카이브된 카드 수, 파일 경로 등)를 담은 JSON 문자열

---

## 스케줄러 도구 (6개)

### 1. scheduler_create

새 스케줄러를 생성한다.

**설명**: cron 표현식이나 자연어(한국어/영어)로 실행 주기를 지정하고, `bash` 또는 `prompt` action을 KST 기준으로 반복 예약한다. 생성 즉시 활성 상태로 등록된다.

**파라미터**

| 이름 | 타입 | 필수 | 설명 |
|------|------|------|------|
| name | string | 필수 | 스케줄러 이름 |
| description | string | 필수 | 스케줄러 설명 |
| cron | string | 필수 | cron 표현식(5 필드) 또는 자연어 (예: "매 5분마다", "every hour") |
| actionType | 'bash' \| 'prompt' | 필수 | 실행할 액션 유형 |
| command | string | 선택 | 실행할 Bash 명령 (`actionType='bash'`) |
| cwd | string | 선택 | Bash 실행 디렉토리 |
| prompt | string | 선택 | scheduler-origin 카드의 prompt 본문 (`actionType='prompt'`) |
| projectDir | string | 선택 | prompt scheduler projectDir |
| agentRuntime | 'opencode' \| 'codex' \| 'claude' | 선택 | prompt scheduler runtime |
| model | string | 선택 | prompt scheduler model |
| timezone | string | 선택 | 항상 `"Asia/Seoul"`만 허용 |

**반환값**: 생성된 스케줄러 항목의 전체 정보를 담은 JSON 문자열

---

### 2. scheduler_update

기존 스케줄러의 설정을 수정한다.

**설명**: 스케줄러의 이름, 설명, cron 주기, action을 수정한다. 수정 즉시 새 설정으로 스케줄이 재등록된다.

**파라미터**

| 이름 | 타입 | 필수 | 설명 |
|------|------|------|------|
| id | string | 필수 | 수정할 스케줄러 ID |
| name | string | 선택 | 새 이름 |
| description | string | 선택 | 새 설명 |
| cron | string | 선택 | 새 cron 표현식 또는 자연어 |
| actionType | 'bash' \| 'prompt' | 선택 | 새 액션 유형 |
| command | string | 선택 | 새 Bash 명령 |
| cwd | string | 선택 | 새 Bash 실행 디렉토리 |
| prompt | string | 선택 | 새 prompt 본문 |
| projectDir | string | 선택 | 새 prompt projectDir |
| agentRuntime | 'opencode' \| 'codex' \| 'claude' | 선택 | 새 prompt runtime |
| model | string | 선택 | 새 prompt model |
| timezone | string | 선택 | 새 타임존 |

**반환값**: 수정된 스케줄러 요약 정보를 담은 JSON 문자열

---

### 3. scheduler_list

등록된 스케줄러 목록을 조회한다.

**설명**: 전체 스케줄러 현황을 파악하거나 특정 상태(활성/비활성)의 스케줄러만 필터링해 볼 수 있다.

**파라미터**

| 이름 | 타입 | 필수 | 설명 |
|------|------|------|------|
| status | 'active' \| 'inactive' | 선택 | 필터링할 상태. 생략 시 전체 조회 |

**반환값**: 포맷된 스케줄러 목록 문자열

---

### 4. scheduler_delete

스케줄러를 영구 삭제한다.

**설명**: 지정한 스케줄러를 중단하고 완전히 제거한다. 삭제된 스케줄러의 실행 이력도 함께 사라진다. 이 작업은 되돌릴 수 없다.

**파라미터**

| 이름 | 타입 | 필수 | 설명 |
|------|------|------|------|
| id | string | 필수 | 삭제할 스케줄러 ID |

**반환값**: 삭제 확인 메시지를 담은 JSON 문자열

---

### 5. scheduler_toggle

스케줄러의 활성/비활성 상태를 전환한다.

**설명**: 활성 스케줄러를 일시 중단하거나, 비활성 스케줄러를 다시 활성화한다. 삭제 없이 스케줄 실행을 멈추고 싶을 때 사용한다.

**파라미터**

| 이름 | 타입 | 필수 | 설명 |
|------|------|------|------|
| id | string | 필수 | 상태를 전환할 스케줄러 ID |

**반환값**: 전환 후 스케줄러 상태 정보를 담은 JSON 문자열

---

### 6. scheduler_run

스케줄러를 cron 주기와 관계없이 즉시 수동으로 실행한다.

**설명**: 다음 예약 시간을 기다리지 않고 즉시 실행한다. `bash`는 stdout/stderr 중심 실행 기록을 남기고, `prompt`는 scheduler-origin 카드를 만든 뒤 runtime dispatch를 접수한다. 실행 결과는 해당 스케줄러의 실행 이력에 기록된다.

**파라미터**

| 이름 | 타입 | 필수 | 설명 |
|------|------|------|------|
| id | string | 필수 | 즉시 실행할 스케줄러 ID |

**반환값**: 실행 결과(stdout, stderr, 종료 코드 등)를 담은 JSON 문자열

---

## 사용 예시

### 예시 1: 새 기능 작업 카드 생성

새로운 기능 개발을 시작할 때 카드를 생성하고 즉시 진행 중으로 전환한다.

```
// 카드 생성
kanban_create({
  title: "사용자 인증 API 구현",
  description: "JWT 기반 로그인/로그아웃 엔드포인트 구현. refresh token 전략 포함.",
  projectDir: "/Users/user/workspace/my-app",
  command: "/start-work"
})
// 반환 예: { "id": "card_abc123", "status": "todo" }

// 작업 시작 상태로 전환
kanban_update({
  id: "card_abc123",
  status: "in_progress",
  progressSummary: "JWT 라이브러리 선택 및 미들웨어 구조 설계 중"
})
```

---

### 예시 2: 작업 진행에 따른 카드 상태 업데이트

작업이 단계별로 진행되면서 진행 상황과 최종 결과를 기록한다.

```
// 중간 진행 상황 업데이트
kanban_update({
  id: "card_abc123",
  progressSummary: "로그인 엔드포인트 완료. 로그아웃 및 refresh token 구현 중."
})

// 작업 완료 후 결과 기록
kanban_update({
  id: "card_abc123",
  status: "complete",
  result: "JWT 인증 API 구현 완료. /auth/login, /auth/logout, /auth/refresh 엔드포인트 추가. 단위 테스트 12개 작성."
})
```

---

### 예시 3: 매일 실행되는 헬스체크 스케줄러 설정

서버 상태를 매일 오전 9시에 자동으로 확인하는 스케줄러를 등록한다.

```
// 스케줄러 생성 (자연어 cron 지원)
scheduler_create({
  name: "서버 헬스체크",
  description: "매일 오전 9시에 API 서버 상태를 확인하고 결과를 로깅",
  cron: "매일 오전 9시",
  actionType: "bash",
  command: "curl -f http://localhost:3000/health && echo 'OK' || echo 'FAIL'",
  timezone: "Asia/Seoul"
})

// 등록 후 즉시 테스트 실행
scheduler_run({ id: "sched_xyz789" })
```

---

### 예시 4: 진행 중인 카드 전체 조회

현재 작업 중인 카드가 무엇인지 파악한다.

```
// in_progress 상태 카드만 필터링
kanban_list({ status: "in_progress" })

// 특정 카드 상세 조회
kanban_get({ id: "card_abc123" })
```

---

## 주의사항

**반환 타입**: 모든 도구는 `string`을 반환한다. 결과값은 항상 `JSON.stringify`된 문자열이므로, 도구 호출 결과를 파싱해 사용할 때 주의한다.

**zod 스키마 검증**: 도구 입력 검증에는 플러그인에 번들된 zod(`tool.schema`)를 사용한다. `import { z } from 'zod'`로 직접 zod를 가져오면 다른 zod 인스턴스가 사용되어 타입 오류가 발생한다. 새 도구를 추가할 때 반드시 `tool.schema`를 통해 스키마를 정의해야 한다.

**prompt 액션의 토큰 소비 경고**: `actionType: 'prompt'`로 설정된 스케줄러는 scheduler-origin 카드를 만들고 runtime dispatch를 호출하므로 AI 토큰을 소비한다. 반대로 `bash` 액션은 `Bun.spawn()`으로 실행되므로 토큰을 쓰지 않는다.

**카드 삭제와 아카이브**: `kanban_delete`는 카드를 영구 삭제한다. 완료된 작업의 이력을 보존하려면 `kanban_archive`를 사용해야 한다. 아카이브된 카드는 `~/.agent-kanban/archive/` 디렉토리의 월별 파일에 저장된다. `KANBAN_DATA_DIR`을 설정한 경우 해당 경로가 우선한다.

**상태 전환**: 칸반 카드의 상태 전환에는 별도 제약이 없다. 어떤 상태에서든 다른 상태로 직접 전환할 수 있다.
