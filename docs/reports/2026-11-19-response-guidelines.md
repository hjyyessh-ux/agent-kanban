# 공통 응답 지침: 현재 Settings 단순 주입 (2026-11-19)

사용자 최종 결정: 세션 시작 시 값 고정이 아니라 매 headless dispatch마다 현재 설정값을 전달한다. 이전 지침 무시/버전 override/disabled reset 안내, 동일값 dedup과 이를 위한 RuntimeRun 저장·조회는 제거했다.

## 현재 구현
- Claude 새 실행·재개: 비어 있지 않으면 append-system-prompt + system-prompt-snapshot off. 빈 값이면 둘 다 전달하지 않는다.
- Codex 새 실행: 기존 developer_instructions 보존 후 현재 block 추가. config 읽기 실패는 기존 지침을 덮어쓰지 않고 요청 접두문 사용.
- Codex 재개: 변경 여부와 무관하게 현재 nonblank block을 요청 앞에 추가. 빈 값이면 원문만 보낸다.
- 카드/제목/prompt.md는 사용자 원문 유지. rollout 표시용 reader는 선두 주입 block만 제거한다.
- 이전 대화 기록의 지침을 삭제하거나 취소하는 기능이 아니다. 비우기는 신규 주입을 중지할 뿐 과거 맥락 제거를 보장하지 않는다.

## 검증
가짜 CLI를 통한 격리 테스트 response-guidelines.test.ts: 9 pass, 0 fail, 85 assertions.
Claude/Codex 새 실행 및 재개 변경·동일·빈 값, 기본 지침 보존, config fallback, 저장 원문과 rollout 원문 매칭 검증.
실제 모델 호출/daemon 재시작/운영 설정 변경/commit/push/PR은 하지 않았다.
이전 보고서의 변경 시에만 주입 및 disabled reset 설명은 폐기되었다.
