# 규칙 출처 대응표 (rule audit)

출처 → 요구사항 → 서버 분기 → 테스트. 요구사항 열은 룰북 원문을 옮긴 것이 아니라 이 프로젝트가 따르는 내용을 요약한 것이다.

## 기준 문서

| 항목 | 내용 |
|---|---|
| 문서 | Codenames 영문 룰북, Czech Games Edition, 8쪽. 마지막 쪽에 `© Czech Games Edition · July 2015` 표기 |
| 받은 곳 | CGE 공식 파일 서버 `https://filemanager.czechgames.com/storage/files/codenames-2015/rules/codenames-rules-en.pdf` (2026-09-24 확인, 9,488,502 바이트) |
| 지시서의 미러 | `https://thegamerules.com/rulebooks/Codenames-Rulebook-en.pdf` 는 2026-09-24 에 HTTP 404 — 그래서 CGE 원본 파일을 읽었다 |
| 구성 확인 | https://www.czechgames.com/games/codenames (단어 카드 200장/400단어, 요원 8+8, 이중 요원 1, 시민 7, 암살자 1, 키 카드 40장) |
| 규칙 프로필 | `rulesetVersion = cge-2015-07-en.1`. 모든 게임에 `rulesetId`·`rulesetVersion` 을 고정하고 진행 중 바꾸지 않는다 |
| 2025 개정판 | 섞지 않는다. 이 앱은 2015 클래식만 구현한다 |
| 한국어 정식판 규칙 | **확인하지 못했다.** 차이가 확인되면 별도 규칙 프로필로 분리한다 (한국어 규칙이라고 단정하지 않는다) |

## 대응표

서버 분기의 `engine.ts` 는 `src/game/engine.ts`, `setup.ts` 는 `src/game/setup.ts`, `rulesets.ts` 는 `src/game/rulesets.ts`, `room-logic.ts` 는 `src/server/room-logic.ts`, `projection.ts` 는 `src/game/projection.ts`.
테스트의 `unit/…` 은 `tests/unit/`, `e2e/…` 는 `tests/e2e/` 다.

| # | 쪽 | 요구사항 (요약) | 서버 분기 | 테스트 |
|---|---|---|---|---|
| 1 | p.1 | 표지(영상 안내). 규칙 없음 | — | — |
| 2 | p.2 | 표준 게임은 4명 이상, 비슷한 두 팀, 팀마다 스파이마스터 1명 | `validateRoster('cge2015-standard')` | unit/room `역할이 모자라면…`, e2e/standard |
| 3 | p.2 | 단어 25개를 무작위로 5×5 배치. 섞을 때 카드를 뒤집어 양면을 섞는다 | `createGame`: 서로 다른 카드 25장 + 카드마다 A/B 면 무작위 | unit/setup `서로 다른 카드 25장…` |
| 4 | p.2 | 키는 무작위로 고르고 어느 방향으로 꽂아도 된다 | `pickKey` + `rotateGrid` 0/90/180/270 (거울 반전 없음) | unit/setup `정식 모드: …회전`, `회전: 시계 방향…` |
| 5 | p.2~3 | 스파이마스터만 키를 보고, 추측자는 단어만 안다 | `projectGame`: 스파이마스터에게만 `key`. 추측자·관전자·방장에게 미공개 정체·keyId·회전·seed·카드 id 를 보내지 않음 | unit/setup `역할별 정보 분리`, unit/room `방장은 관리 역할만으로…`, e2e/standard(DOM·ARIA·WS 프레임), e2e/race-security |
| 6 | p.3 | 키의 불빛이 선공을 정한다. 선공 9, 후공 8 | 정식 키: `key.startingTeam`. 비공식 팩: 무작위 선공 + 무작위 배치(원본 키 아님) | unit/setup `정체 수…` |
| 7 | p.3 | 이중 요원은 선공 팀 요원이 된다 (구성품 1장) | `reveal`: 선공 팀의 아홉 번째 덮개 = `:double` 슬롯. 별도 능력 없음 | unit/engine `선공 팀의 아홉 번째 덮개…` |
| 8 | p.3 | 요원 8+8, 이중 요원 1, 시민 7, 암살자 1 | `CLASSIC` 상수(기본판 모듈 안에 고정, 설정 화면에서 못 바꿈) | unit/setup `정체 수…` |
| 9 | p.4 | 번갈아 진행. 선공 팀이 첫 힌트 | `createGame`: `turnTeam = startingTeam`, `endTurn` 에서 교대 | unit/engine |
| 10 | p.4 | 힌트는 단어 하나 + 숫자 하나. 추가 힌트 금지 | `giveClue` (숫자 0~9·무제한, 1~30자). 제출 뒤 수정 불가. 게임 중 스파이마스터 자유 채팅 차단 | unit/engine `p.4 힌트`, unit/room `…자유 채팅…`, e2e/race-security |
| 11 | p.4 | 보이는 단어 그대로는 힌트 불가. 덮인 뒤에는 가능 | `giveClue`: 미공개 단어와 정규화(NFC·공백·대소문자) 후 **정확히 같으면** 거절. 부분 겹침은 클라이언트 경고만 | unit/engine `보드에 보이는 단어는…`, e2e/standard |
| 12 | p.4 | 자기 팀 요원 → 계속 / 시민 → 턴 종료 / 상대 요원 → 턴 종료 / 암살자 → 그 팀 즉시 패배 | `guess` → `reveal` → `endTurn`/`finish` | unit/engine `p.4~5 접촉과 추측 수` |
| 13 | p.4 | 최소 한 번은 추측해야 한다 | `endTurn`: `guessesMade < 1` 이면 `mustGuessOnce` | unit/engine `최소 1회…`, e2e/standard |
| 14 | p.5 | 최대 추측 수 = 숫자 + 1 | `guessLimit` | unit/engine `…숫자+1 에서 턴 종료` |
| 15 | p.5 | 틀리거나, 멈추거나, 최대에 도달하면 턴 종료 | `endTurn(reason)` | unit/engine |
| 16 | p.5 | 한 팀의 단어가 모두 덮이면 그 팀 승리. 상대 차례에도 이길 수 있다 | `reveal`: `remainingAgents === 0` → `finish(그 팀)` | unit/engine `상대의 마지막 요원을…` |
| 17 | p.5 | 다음 판: 덮개를 치우고 25장을 뒤집는다 | 대기실 `다음 판 준비 = 같은 25장 뒤집기` → `flipFrom` (양면 카드 팩만) | unit/setup `다음 판…` |
| 18 | p.5 | 스파이마스터는 표정을 관리한다 | 스파이마스터의 입력 중 내용·선택·커서를 방송하지 않음. 추측자에게 초안 글자 수 등도 보내지 않음 | 코드 검토(`room-logic.ts`: 스파이마스터 입력은 제출 전 서버로 가지 않음) |
| 19 | p.5 | 잘못된 힌트: 그 팀 턴 즉시 종료 + 상대 스파이마스터가 다음 힌트 전에 자기 요원 1장을 덮을 수 있음. 아무도 못 알아채면 유효 | `reportInvalidClue` → `clueDispute`(공개 멈춤) → `voteDispute` → 두 스파이마스터 모두 ‘잘못됨’이면 `penaltyResolution` → `penaltyCover(index|null)`. 벌칙 공개에서도 즉시 종료 판정 | unit/engine `p.5~6 잘못된 힌트` 6개 |
| 20 | p.5 | 모래시계는 오래 고민하는 사람에게 결정을 부탁하는 도구 | `timerStart/timerCancel`: 서버 기준 종료 시각만 저장. 자동 패스·패배 없음. 길이는 ‘운영 설정’ | 코드 검토, 화면 문구 |
| 21 | p.6 | 힌트는 뜻에 관한 것. 글자·위치 금지. 숫자는 힌트 불가. 보이는 단어의 형태·합성어 일부 금지 | **자동 판정하지 않는다.** 겹침 경고 + 상대 스파이마스터에게 조용히 묻기 + 신고/판정 | 규칙 도움말, unit/engine `사전 문의…` |
| 22 | p.6 | 상대 스파이마스터가 허용하면 유효. 모르면 상대에게 조용히 묻기 | `spyQuery`/`spyQueryAnswer`: 두 스파이마스터에게만 전송, 공개 revision 을 올리지 않음(존재도 새지 않게). 판정에서 상대가 ‘유효’면 유효 | unit/engine `사전 문의는…`, unit/setup `…spyQueries`, e2e/standard `assertNoSecrets` |
| 23 | p.6 | 동음이의어·철자 규칙, 철자 불러 주기 | 사람 판정. 규칙 도움말에 설명 | — |
| 24 | p.7 | 0: 관련 단어 없음. 추측 상한 없음, 최소 1회 | `guessLimit(0) = null` + 최소 1회 유지 | unit/engine `0 과 무제한은…` |
| 25 | p.7 | 무제한: 원하는 만큼 추측 | `guessLimit('unlimited') = null` | unit/engine |
| 26 | p.7 | 유연한 규칙(합성어·고유명사·약어·동음이의어·운)은 모임이 정한다. 지어낸 합성어·이름은 금지 | 공백이 있는 힌트를 거절하지 않고 안내만 함. 규칙 도움말 ‘모임에서 미리 정할 것’ | 규칙 도움말 |
| 27 | p.8 | 2인(또는 경쟁을 원치 않는 여럿) 협력: 한 팀, 사람 팀 선공, 상대 차례마다 스파이마스터가 상대 요원 1장 선택해 덮음 | `cge2015-coop`: `endTurn` → `simulatedOpponentTurn` → `simulatedCover` | unit/engine `p.8 소인원 협력`, e2e/variants |
| 28 | p.8 | 협력: 암살자 또는 상대 요원 전부 덮이면 패배(점수 없음). 승리 점수 = 상대 더미에 남은 요원 수 | `reveal` → `coopEnemyComplete`/`assassin`, `coopScore` | unit/engine `승리하면 점수…`, `상대 요원이 모두 덮이면 패배…` |
| 29 | p.8 | 3인: 협력 변형, 또는 두 스파이마스터 + 한 명이 양쪽을 위해 추측 | `cge2015-shared-operative`: `sharedOperative` 는 모든 차례에 추측 | unit/engine `p.8 3인…`, e2e/variants |
| 30 | p.8 | Codenames Duet 안내 | **구현하지 않음.** 기본판 2인 변형을 ‘듀엣’이라 부르지 않음 | — |

## 룰북에 없는 부분의 처리 원칙 (앱 운영 결정)

| 상황 | 처리 | 이유 |
|---|---|---|
| 신고 뒤 두 스파이마스터 의견이 다를 때 | 벌칙 없이 원래 상태로 계속. 기록에 ‘의견 불일치’ | 지시서: 신고만으로 벌칙을 확정하지 않는다. p.6 에 따라 상대가 ‘유효’면 유효 |
| 이미 끝난 턴의 힌트를 늦게 신고 | 받지 않고 안내만 한다. 공개 취소·단어 회수 없음 | p.5 ‘아무도 못 알아채면 유효’, 지시서: 임의 보정 금지 |
| 협력 변형의 잘못된 힌트 | 신고 기능 없음 | 상대 스파이마스터가 없고 룰북에 규정 없음 |
| 비공식 단어 팩의 정체 배치 | 9/8/7/1 무작위 배치. 화면에 ‘원본 키 카드 아님’ 표시 | 원본 키 카드 40장 미확보 |
| 스파이마스터 교체 | 정답을 안 본 같은 팀 추측자만, 방장 승인으로 승격. 전임은 관전자로 남고 같은 게임의 추측자가 될 수 없음 | 지시서 §5 |
| 모래시계 길이 | 방장이 30/60/90/120/180초 중 선택 (운영 설정) | 원작 규정 시간이 아님 |

## 하지 않는 것 (원본 충실도)

특수 능력, 아이템, 콤보 점수, 경험치, 에너지, 추가 팀, 부활, 임의 승리 조건, AI 플레이어, AI 연관성 채점·정답 추천은 없다. 요원·시민 그림은 공개 뒤 덮는 장식이다.
