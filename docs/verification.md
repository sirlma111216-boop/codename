# 검증 보고서

작성: 2026-09-25. 결과는 **엔진/통신 구현**과 **원본 콘텐츠 검증**을 나눠 적는다.

| 구분 | 상태 |
|---|---|
| 엔진/통신 구현 | 완료. 아래 검사를 로컬 Workers 런타임과 **실제 production** 에서 통과 |
| 원본 콘텐츠 검증 | **미완료.** 한국어 정식판 400단어·앞뒤 짝·원본 키 카드 40장 미확보 → 정식 모드 잠금. 테스트용 게임의 성공을 원본 재현 완료로 보지 않는다 ([content-status.md](content-status.md)) |

## 실행한 검사

| # | 묶음 | 방법 | 결과 |
|---|---|---|---|
| 1 | 콘텐츠·준비 | `npm test` (setup-projection): 25장 선택, 카드당 한 면, 양면 동시 등장 없음, 선공 9/후공 8/시민 7/암살자 1, 정식 키 회전 0/90/180/270·거울 반전 없음, 협력 변형 선공, 다음 판 뒤집기, 검증 안 된 정식 팩 시작 거부. `npm run content:verify` | 통과. 정식 팩은 ‘미완료’로 보고 |
| 2 | 엔진 | `npm test` (engine): 모든 턴 종료 원인, 0·무제한, 숫자+1, 최소 1회, 상대 마지막 요원, 이중 요원 덮개, 잘못된 힌트 신고·판정·벌칙·벌칙 중 승리·의견 불일치·철회·늦은 신고, 협력 변형(가상 상대·점수·패배 2종·신고 없음), 3인 공용 추측자, 사전 문의, 스파이마스터 교체 | 27개 통과 |
| 3 | 권한 | 단위(room) + e2e(race-security): 다른 팀·다른 턴·관전자·비스파이마스터의 힌트/추측 거절, 방장 전용 명령, 방장은 키 못 봄, 게임 중 스파이마스터·관전자 채팅 차단, 정답 본 사람의 추측자 재지정 차단, 강퇴 세션 재입장 차단, 초대 없는 방 주소 접근·WebSocket 차단 | 통과 |
| 4 | 정보 노출 | 단위(projection JSON 검사) + e2e: 추측자·관전자의 **모든 WebSocket 프레임**에 미공개 `key`·seed·keyId·keyRotation·identities·cardId·sessionHash·dedup 없음, DOM 클래스·ARIA 이름에 정체 없음, 스파이마스터 문의는 스파이마스터에게만. 프런트엔드 번들·정적 경로에 콘텐츠 원본·키 없음(`release:check` + e2e) | 통과 |
| 5 | 경쟁 상태 | e2e(race-security), 각 참가자의 브라우저 안에서 원시 WebSocket 프레임: 다른 카드 동시 확정 → 1개만 반영, 같은 카드 동시 확정 → 1번만 공개, 같은 commandId 재전송(같은 연결·새 탭) → 한 번만 반영, 오래된 revision 거절, 이전 gameId 거절 | 통과 |
| 6 | 복원 | e2e(standard): 새로고침 뒤 같은 보드·추측 수. e2e(restart): **Workers 런타임을 완전히 종료(메모리 소실)** 후 같은 저장소로 재시작 → 자동 재접속, 같은 힌트·추측 수·공개 카드·단어·키, 이어서 진행 | 통과 (로컬) |
| 7 | 멀티클라이언트 | Playwright 독립 browser context (localStorage 공유 없음): 표준 4인 + 관전자 1 전체 흐름·종료·재경기, 6인 경쟁, 협력 2인, 3인 공용 추측자 | 통과 |
| 8 | 배포 | `npm run release:check` (typecheck·lint·unit·build·번들 누출·wrangler 설정·콘텐츠). production 배포 후 HTTP 점검(세션 쿠키 플래그, 다른 Origin POST 403, `/api/*` 오류는 JSON, SPA 경로, 그림 캐시 헤더) + **production 에서 e2e 5개 시나리오**(`E2E_BASE_URL=https://codename.sirlma.workers.dev npm run test:e2e`) | 통과 |
| 9 | 접근성·미술 | e2e(mobile 360×740): 5열 유지, 가로 스크롤 없음, 단어 잘림 0, 카드 폭 > 50px, 확정 창. 스크린숏 눈 검사(데스크톱·모바일). 코드: 화살표 키 이동(roving tabindex)·포커스 표시·aria-live 공개 안내·`prefers-reduced-motion`·팀 = 색 + 글자 + 기호(◆/●/○/✕)·그림 없으면 단색 대체 | 통과 |

## 학급 모드 (addendum)

| 묶음 | 방법 | 결과 |
|---|---|---|
| 클래스 로직 | 단위 `class.test.ts` 25개 · `room-class.test.ts` 11개 (전체 단위 테스트 89개) (정원·권한·신청·승인 경쟁·시작 잠금·반영 기록·수업 종료·60명/15방·projection) | 통과 |
| 실제 화면 흐름 | 브라우저 `classroom.spec.ts` (교사 1 + 학생 5, 독립 context): 생성·QR·방장 지정·방 생성·신청·승인·입장·준비·시작·교사 공개 관전(정답 없음)·게임 중 공지·지각생 차단·수업 종료 | 통과 (로컬) |
| 재시작 복원 | 브라우저 `class-restart.spec.ts`: 게임 중 런타임 종료·재시작 → 교사 대시보드·배정·방장·게임·명단 잠금 해제 복원 | 통과 (로컬) |
| 규모·경쟁·권한 | 봇 시뮬레이션 `tests/load/class-sim.ts` (flow24·race·perm·load60·rooms15) | 로컬 54/54, **production 54/54** 통과. 측정값: [class-sim/local.md](class-sim/local.md), [class-sim/production.md](class-sim/production.md) |
| 실제 화면 흐름 (production) | 브라우저 e2e 6개 (`E2E_BASE_URL=… npm run test:e2e`, 학급 흐름 포함, 재시작 테스트 제외) | 통과 |

자세한 대응표: [classroom.md §8](classroom.md#8-검증-addendum-8-대응표).

## 봇 (혼자서 플레이 · 학급 시뮬레이션)

| 묶음 | 방법 | 결과 |
|---|---|---|
| 판단·정직성 | 단위 `bots.test.ts` 22개: 연상 사전 400/400, 추측자 봇은 정답 배치를 바꿔도 같은 선택(정답을 못 봄), 봇 힌트 40판 모두 판의 단어와 겹치지 않고 노린 카드는 자기 팀, 봇끼리 110판·협력 10판 거절 없이 끝까지, 사람 추측자 팀에서는 해석만, 정답 보기는 모두 봇일 때만 | 통과 |
| 학급 좌석 | 단위 `class-bots.test.ts` 7개: 방장·선생님만 봇 넣기·빼기, 정원, 시작 뒤 잠금, 방 닫으면 삭제, 방 반영(자동 착석·늘 준비), 학생 방장이 없으면 선생님이 방장 역할 | 통과 |
| 실제 화면 | 브라우저 `bots.spec.ts` 5개: 혼자서 플레이(추측자·관전·스파이마스터), 선생님 시뮬레이션 방, 방장 학생이 봇으로 채워 시작. 사람 추측자의 모든 WebSocket 프레임에 미공개 정답 없음 | 통과 (로컬) |

봇끼리 측정값과 한계: [bots.md](bots.md).

## 실행하지 않은 것 / 한계

- **staging 환경은 배포하지 않았다.** 대신 production 에서 직접 WebSocket·새로고침·초대 링크 입장을 검증했다. staging 은 `npm run deploy:staging` 으로 만들 수 있다(별도 Worker·별도 Durable Object 저장소).
- **실제 휴면(hibernation) 퇴거**는 강제로 일으킬 수 없어, 런타임 종료·재시작으로 같은 조건(메모리 소실, 저장소 유지)을 재현했다. production 에서는 재시작 테스트를 하지 않았다.
- 24시간 무활동 정리(alarm)는 코드와 단위 검사(방장 이양 시간 계산)로만 확인했고, 실제 24시간 경과는 기다리지 않았다.
- 화면 낭독기(NVDA·VoiceOver) 실사용 점검은 하지 않았다. ARIA 이름·aria-live 는 코드와 DOM 검사로만 확인했다.
- Safari·Firefox·실제 휴대폰은 검사하지 않았다(Chromium 만).
- 익명 사용자가 다른 브라우저로 다시 오는 것까지 완벽히 막지는 못한다(초대 갱신·방 잠금으로 보완).
- 한국어 정식판 규칙과의 차이는 확인하지 않았다.
- 학급 모드 60명은 한 PC 의 봇으로 측정했다. 실제 학교 와이파이·휴대폰 60대는 재현하지 않았다. 60명 초과는 검증하지 않았다.
- 클래스↔방 RPC 실패는 단위 테스트와 런타임 재시작으로 재현했고, 운영 환경에서 강제로 일으키지는 않았다.
- 봇의 실력은 봇끼리 대전으로만 쟀다. 사람과 둘 때의 체감 난이도, 사전에 없는 힌트에 대한 봇의 해석 품질은 측정하지 않았다.

## 다시 실행하는 법

```bash
npm run release:check -- --e2e
E2E_BASE_URL=https://codename.sirlma.workers.dev npm run test:e2e
```

production 에서 e2e 를 돌리면 테스트용 방이 만들어지며, 24시간 뒤 자동으로 정리된다.
