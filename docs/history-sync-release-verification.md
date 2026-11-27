# History 증분 동기화 인수 검증과 출시 경계

## 이 변경의 범위
이 문서와 smoke script는 **History 기능 구현 PR이 아니라 검증 준비물**이다. 현재 main에는 필요한 API가 없어 단독 실행할 수 없다. History 후보를 별도로 제공해야 한다. 후보 코드를 이 변경에 포함하지 않는다.

## 재현
macOS 또는 Linux, Bun과 대상 후보의 설치된 Playwright/Chromium 및 web/dist 필요. 이 명령은 의존성을 설치하지 않는다.

```bash
bun scripts/history-sync-smoke.ts /absolute/path/to/history-candidate
```

스크립트는 임시 HOME·data·Codex/Claude 디렉터리를 생성한 뒤 후보 store/server를 불러온다. 포트0으로 loopback에 서버를 열고 후보의 실제 web/dist를 제공한다. 모델 실행/daemon/scheduler/wiki/source discovery는 시작하지 않는다. 브라우저 외부 요청은 차단하며 로컬 API 응답은 mock하지 않는다. finally에서 서버와 브라우저를 종료한다. 증거는 출력한 임시 폴더에 남으므로 보관이 필요하면 별도로 복사한다.

검증: 기본 disabled → 임시 journal 초기화 → 합성 카드 생성/수정 → events2 → ACK 이전 checkpoint0 → ACK 이후2 → 재조회0 → 실제 Settings 수집2/2·검토0/2. 이 차이는 수집 완료를 검토 완료로 오인하지 않게 한다.

## 관측된 결과 (2026-11-19)
v10 보존 후보에서 정상 회귀21건과 file fixture UI5건 통과. 별도 실제 HTTP 및 built Settings 검증도 통과했다. 전체 suite 과거 통과와 달리 이번에는 정상 기능 범위만 재실행했다.
당시 후보 기준은 main 8a13aebab5f330695855a615c03023f433c38d9d. 운영 API는404, 운영/후보 UI asset hash도 달랐다. 따라서 후보 통과를 운영 적용으로 보고하면 안 된다.

## draft PR과 release는 다르다
- 이 테스트/문서 draft는 재현 절차를 검토할 수 있지만 기능 출시나 전체 후보 승인으로 취급하지 않는다.
- 전체 후보에는 원문 수집·출처 신뢰·scope/auth·민감정보 처리·durable ACK가 결합되어 있다. 정상 기능 검증은 이 경계들의 독립 검토를 대체하지 않는다.
- 앞선 독립 검토 중 하나는 안전 검사로 완료되지 않았다. 다른 실행으로 반복/우회하거나 기능 검토를 consensus로 보고하지 않는다. 전체 후보는 사람 또는 별도로 승인된 검토 경로에서 변경 범위를 평가해야 한다.
- 검토자는 정상 데이터 권한/범위, source 등록, 잘린 원문 비가용 정책, epoch/retention/restart 경계와 미검증 사항을 확인한다. 이 문서는 취약점 재현을 지시하지 않는다.

## 출시 전 gate
1. 공개 가능한 정확한 patch·base·변경 파일을 확정하고 사용자 dirty checkout과 분리.
2. 위 정상 HTTP/UI 테스트, 전체 회귀 및 적절한 독립 코드 검토 완료.
3. 실제 source 등록 범위·권한과 기존 미처리 데이터 인수 계획 승인.
4. frontend/backend가 같은 빌드인지 확인.
5. 백업·복구·journal/cursor 호환 및 유지보수 시점 확정.
6. 구체적인 설치/재시작 승인 후 실행하고 재검증.

현재 install.sh는 build만 하는 명령이 아니다. 플러그인·web 복사, hooks와 전역 설정 등록, daemon 경로 기록까지 수행한다. 읽기 검증이나 단순 UI 갱신 목적으로 실행하지 않는다. 이 PR은 설치·운영 초기화·마이그레이션·재시작을 하지 않는다.
