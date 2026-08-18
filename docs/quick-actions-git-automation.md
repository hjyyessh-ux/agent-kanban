# Quick Action Git 자동화 예제

이 문서는 Quick Action이 단순 명령 바로가기를 넘어 반복적인 Git 전달 작업도 일반 Board 카드로 추적할 수 있음을 설명합니다.

등록된 Script Quick Action은 다음 입력을 받습니다.

- 커밋할 파일 경로
- 현재 작업 브랜치와 PR base 브랜치
- 커밋 메시지
- PR 제목과 본문

실행기는 입력값을 command 문자열에 합치지 않고 `AK_PARAM_*` 환경변수로 전달합니다. Script는 현재 브랜치가 요청한 브랜치와 같은지 확인한 뒤 지정 파일만 stage하고, commit, origin push, `gh pr create`를 순서대로 수행합니다.

실행이 시작되면 Quick Action 카드가 `in_progress`가 되고, Git과 GitHub 작업이 모두 성공하면 `complete`와 `resolution=completed`로 끝납니다. commit hash와 생성된 PR URL은 Script stdout을 포함한 카드 결과에서 확인할 수 있습니다. 중간 단계가 실패하면 카드가 `resolution=failed`로 끝나므로 자동화 실패가 성공처럼 보이지 않습니다.

이 예제의 목적은 범용 shell 입력을 받는 것이 아닙니다. 실행할 동작은 미리 검토된 Script에 고정하고, 사용자는 필요한 값만 typed parameter로 전달하는 것이 Quick Actions의 안전 경계입니다.
