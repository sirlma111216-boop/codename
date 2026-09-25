# 코드네임 · 모임용 실시간 웹 구현

코드네임(Codenames, Czech Games Edition, 2015) 기본판 규칙으로, 여러 사람이 각자 브라우저에서 실시간으로 함께 하는 **비공식** 웹앱입니다. 내부·교육·친목 모임용이며 공식 제품이 아닙니다.

- 회원가입·이메일·소셜 로그인 없음. 닉네임만 정하고 **초대 링크**로 들어옵니다. 공개 방 목록은 없습니다.
- 모든 판정(정답·추측 수·턴·승패)은 서버가 합니다. 추측자·관전자·방장에게는 미공개 정체가 **전송되지 않습니다**.
- 규칙 프로필: 표준 대전(4인+), 소인원 협력(가상 상대, 룰북 p.8), 3인 공용 추측자(룰북 p.8)
- **학급 모드:** 교사가 클래스를 만들고(초대 링크·QR), 지정한 학생 방장이 게임방을 만들고, 학생은 참가 신청 → 방장 승인으로 들어간다. 여러 방이 동시에 독립 진행되고, 교사는 대시보드에서 현황·공개 관전·공지·수업 종료를 한다. 자세한 설명: [docs/classroom.md](docs/classroom.md)
- 구조: `브라우저 ↔ Cloudflare Worker(API·WebSocket) ↔ 게임방마다 GameRoomDurableObject 하나 (+ 학급 모드는 클래스마다 ClassroomDurableObject 하나)`. 별도 DB 서비스 없이 방·클래스 상태를 Cloudflare Durable Object 내장 저장소(SQLite)에 보관합니다.

> **콘텐츠 현황:** 엔진·통신 구현은 끝났지만 **한국어 정식판 400단어와 원본 키 카드 40장은 확보·검증되지 않았습니다.** 정식 모드는 잠겨 있고, 지금은 이 프로젝트가 만든 비공식 단어 팩(무작위 9/8/7/1 배치)이나 방장이 직접 입력한 단어로 플레이합니다. 자세한 내용: [docs/content-status.md](docs/content-status.md)

## 문서

| 문서 | 내용 |
|---|---|
| [docs/rule-audit.md](docs/rule-audit.md) | 룰북 쪽별 요구사항 → 서버 분기 → 테스트 대응표 |
| [docs/content-status.md](docs/content-status.md) | 콘텐츠 현황, 데이터 미확보 목록, 정식 자료 넣는 순서 |
| [docs/content-verify-report.md](docs/content-verify-report.md) | `npm run content:verify -- --write` 결과 |
| [docs/verification.md](docs/verification.md) | 검증 보고서 (실행한 것 / 실행하지 않은 것) |
| [docs/classroom.md](docs/classroom.md) | 학급 모드: 흐름, 권한, 클래스↔방 배정 일관성, 수명·정리, 검증 대응표 |
| [docs/class-sim/](docs/class-sim/) | 학급 모드 봇 시뮬레이션 결과 (로컬·production 측정값) |
| [public/assets/manifest.json](public/assets/manifest.json) | 그림 파일·대체색·비율·쓰임 |

## 로컬 실행

Node 22 이상 (`.nvmrc` = 24).

```bash
npm ci
npm run dev
```

`npm run dev` 는 화면을 빌드하며 지켜보고(`vite build --watch`), 로컬 Workers 런타임(`wrangler dev`, Durable Object 포함)을 http://127.0.0.1:8787 에 띄웁니다. 화면을 고친 뒤에는 브라우저를 새로고침하세요.

여러 명을 흉내 내려면 **서로 다른 브라우저 프로필이나 시크릿 창**을 쓰세요. 같은 창의 탭은 쿠키를 공유해서 같은 사람으로 취급됩니다.

## 스크립트

| 명령 | 하는 일 |
|---|---|
| `npm run dev` | 로컬 개발 서버 |
| `npm run build` | 화면 빌드 → `dist/client` |
| `npm run typecheck` | 화면·Worker·스크립트 타입 검사 |
| `npm run lint` | ESLint (화면 코드가 콘텐츠 원본·서버 코드를 import 하면 오류) |
| `npm test` | 엔진·방 로직·정보 분리 단위 테스트 (Vitest) |
| `npm run test:e2e` | Playwright: 로컬 Workers 런타임에 독립 브라우저 context 여러 개로 실제 대전·경쟁 상태·보안·재시작 복원 검사 |
| `npm run test:class-sim -- --base <주소>` | 학급 모드 봇 시뮬레이션: 24명 4방 동시 게임, 경쟁·권한·비밀, 60+1명 동시 연결·재접속, 4인 방 15개 (`--only flow24,race`, `--report 파일`) |
| `npm run content:verify` | 콘텐츠 팩 검사, 정식 플레이 준비 상태 보고 (`-- --write` 로 보고서 갱신) |
| `npm run content:import` | CSV → 콘텐츠 JSON (`docs/content-status.md` 참고) |
| `npm run release:check` | 타입·린트·테스트·빌드·번들 누출 검사·콘텐츠 상태를 한 번에. `-- --e2e` 로 브라우저 테스트 포함, `-- --require-official` 이면 정식 콘텐츠 미완료 시 실패 |
| `npm run assets:build -- "<원본 그림 폴더>"` | 원본 PNG → 서비스용 WebP + `public/assets/manifest.json` (원본 약 84MB → 약 1.5MB) |
| `npm run deploy` | 빌드 후 production 배포 (`wrangler deploy`) |
| `npm run deploy:staging` | 빌드 후 staging 배포 (`codename-staging` Worker, 데이터 분리) |

처음 e2e 를 돌릴 때 Playwright 브라우저가 없으면 `npx playwright install chromium` 을 한 번 실행하세요.
배포된 주소를 검사하려면 `E2E_BASE_URL=https://codename.sirlma.workers.dev npm run test:e2e` (로컬 서버를 띄우지 않고, 재시작 테스트는 건너뜁니다).

## 배포된 주소

- production: https://codename.sirlma.workers.dev

## 배포 (Cloudflare Workers)

정적 화면·그림과 실시간 서버가 **한 Worker 프로젝트**(`wrangler.jsonc`, `name = "codename"`)로 배포됩니다. Cloudflare Pages 만으로는 실시간 서버가 되지 않습니다.

### 직접 배포

```bash
npx wrangler login
npm run deploy
```

마이그레이션: `v1` 은 게임방 클래스를 SQLite 저장소로 만들고, `v2` 는 그 이름만 `GameRoomDurableObject` 로 바꾸며(저장된 방 유지) 학급용 `ClassroomDurableObject` 를 추가합니다.

### GitHub push 로 자동 배포 (Workers Builds)

1. Cloudflare 대시보드 → **Workers & Pages** → `codename` Worker → **Settings** → **Builds** → **Connect**
2. GitHub 계정과 이 저장소를 고릅니다. (참가자는 GitHub 계정이 필요 없습니다. 연결은 배포하는 사람의 계정입니다.)
3. 빌드 설정:
   - Build command: `npm run build`
   - Deploy command: `npx wrangler deploy`
   - Production branch: `main`
4. 대시보드의 Worker 이름은 `wrangler.jsonc` 의 `name`(`codename`)과 **같아야** 합니다. 다르면 빌드가 실패합니다.
5. 이후 `main` 에 push 하면 빌드·배포됩니다.

Durable Object 를 구현한 Worker 는 **버전별 미리보기 URL(Preview URL)이 생성되지 않습니다.** 미리 확인이 필요하면 staging 을 쓰세요.

### staging

`npm run deploy:staging` → 별도 Worker `codename-staging` 으로 배포됩니다. Durable Object 네임스페이스가 따로라서 production 방 데이터와 섞이지 않습니다.

### 비밀값 (선택: 공용 입장 암호)

초대 링크만으로 충분하면 설정하지 않아도 됩니다. 모임 밖 사람이 주소를 알아도 방을 만들지 못하게 하려면:

```bash
npx wrangler secret put ENTRY_PASSWORD
```

staging 은 `npx wrangler secret put ENTRY_PASSWORD --env staging`. 로컬은 `.dev.vars.example` 을 `.dev.vars` 로 복사해 씁니다. 실제 암호·토큰을 저장소에 커밋하지 마세요.

## 운영

| 항목 | 내용 |
|---|---|
| 학급 모드 인원 | 클래스 정원 기본 40명(교사 제외), 상한 `CLASS_MAX_STUDENTS`(기본 60), 클래스당 게임방 `CLASS_MAX_ROOMS`(기본 15), 방 정원 4~8명(기본 6). 모두 운영 설정이며 원작 인원 규정이 아닙니다. 60명은 봇 시뮬레이션으로 측정한 범위입니다([docs/classroom.md](docs/classroom.md)) |
| 학급 전용 배포 | `ALLOW_STANDALONE_ROOMS` 를 `"false"` 로 두면 독립 게임방 만들기를 막고 학급 모드만 씁니다 |
| 교사 복구 키 | 클래스를 만들 때 한 번만 보여 줍니다. 다른 기기에서 이어서 관리할 때 씁니다. 잃어버리면 같은 브라우저로만 관리할 수 있습니다 |
| 방 정리 (보존 정책) | 마지막 활동 뒤 `ROOM_TTL_HOURS`(기본 24시간)가 지나면 Durable Object alarm 이 소켓을 닫고 방 데이터·초대 정보를 지웁니다. 카드 규칙이 아닙니다. `wrangler.jsonc` 의 `vars` 에서 바꿉니다 |
| 방장 이양 | 방장 연결이 `HOST_GRACE_SECONDS`(기본 180초) 넘게 끊기면 가장 먼저 들어온 온라인 참가자에게 **관리 권한만** 넘어갑니다. 게임 역할·정답 열람권은 바뀌지 않습니다 |
| 쿠키를 잃은 참가자 | 자동 복구되지 않습니다. 초대 링크로 새로 들어온 뒤 방장이 ‘자리 재지정’으로 원래 자리에 연결합니다. 이미 정답을 본 사람은 같은 게임에서 추측자 자리로 옮길 수 없습니다 |
| 강퇴 | 기존 소켓을 끊고 그 세션을 차단합니다. 새 브라우저로 다시 오는 것까지 완벽히 막지는 못하므로, 필요하면 ‘초대 링크 새로 만들기’와 ‘방 잠그기’를 함께 쓰세요 |
| 로그 | `npx wrangler tail` (production) · `npx wrangler tail --env staging`. 로그에 세션 id·초대 토큰·미공개 키를 남기지 않습니다 |
| 캐시 | `/static/*`(해시 파일) 1년, `/assets/*`(그림) 7일, HTML 은 매번 확인, `/api/*` 는 `no-store` |
| 그림 교체 | 같은 이름으로 `public/assets/` 파일을 바꾸면 코드 수정 없이 반영됩니다(최대 7일 캐시). 새 원본 세트는 `npm run assets:build -- "<폴더>"` |
| 프로토콜 변경 | 화면 버전이 서버와 다르면 새로고침 안내를 띄웁니다. 진행 중 보드는 서버에 그대로 남습니다. 저장 상태는 `schemaVersion` 과 호환 처리(`migrateRoom`)로 읽으며 방을 초기화하지 않습니다 |
| 장애 복구 | 코드 문제면 대시보드 **Deployments** 에서 이전 버전으로 롤백하거나 `npx wrangler rollback`. 방 상태는 Durable Object 저장소에 남아 있으므로 재배포·재시작 뒤에도 같은 보드·차례로 이어집니다(e2e `restart.spec.ts` 로 확인) |

### 사용량과 비용

Workers Free 플랜에서도 SQLite 저장소를 쓰는 Durable Object 를 쓸 수 있습니다. 2026-09 기준 문서의 무료 한도는 Durable Object 요청 하루 100,000건, 실행 시간 하루 13,000 GB-s, 행 읽기 하루 500만, 행 쓰기 하루 10만, 저장 5GB 입니다. 한도를 넘으면 그 종류의 작업이 오류로 실패합니다. 들어오는 WebSocket 메시지는 20개가 요청 1건으로 계산되고, 휴면(Hibernation) 중에는 실행 시간이 과금되지 않습니다. 연결 유지용 ping 은 런타임이 객체를 깨우지 않고 응답합니다.

**무료 운영을 보장하지 않습니다.** 한도와 요금은 바뀔 수 있으니 [Durable Objects 요금](https://developers.cloudflare.com/durable-objects/platform/pricing/)을 확인하세요.

## 저장소 공개 범위

지시서의 기본은 **비공개 저장소**입니다. 비공개 저장소라고 웹사이트 접근이 막히는 것은 아니며, 앱 접근은 초대 토큰(과 선택적 공용 입장 암호)으로 제어합니다. 한국어 정식판 단어·키 카드 같은 출판사 자료를 넣게 되면, 그 전에 저장소를 비공개로 바꾸세요.

## 폴더 구조

```
src/client/   화면(React), 접근성, 효과음, 로컬 표시 상태
src/server/   Worker 라우팅·세션·Origin 검사(index.ts), 게임방 DO(room.ts)·방 로직(room-logic.ts), 클래스 DO(classroom.ts)·클래스 로직(class-logic.ts)
src/game/     규칙 엔진(engine.ts), 준비(setup.ts), 규칙 프로필(rulesets.ts), 역할별 정보 분리(projection.ts), 콘텐츠 검증(content.ts)
src/shared/   공개 프로토콜(zod 스키마)·표시용 타입. 비밀 키 원본 없음
content/      서버용 단어·키·출처 manifest, JSON Schema, CSV 예시
public/assets 서비스용 그림과 manifest.json
tests/        unit(엔진·방·클래스), e2e(멀티클라이언트·경쟁·보안·재시작·학급 모드), load(학급 봇 시뮬레이션), fixtures(합성 테스트 데이터)
docs/         규칙 대응표, 콘텐츠 현황, 검증 보고서
scripts/      그림 변환, 콘텐츠 검사·가져오기, 릴리스 점검
```

## 확장판을 위한 경계

`ContentPack`(content.ts) · `Ruleset`(rulesets.ts, engine.ts) · `ViewProjection`(projection.ts) · `ThemePack`(client/theme.ts + assets manifest) · 모드 목록(`RULESETS`, 대기실의 팩 목록은 설치·검증된 것만 선택 가능)이 나뉘어 있습니다. 보드 크기·정체 수는 기본판 모듈(`CLASSIC`) 안에 고정되어 있고 설정 화면에서 바꿀 수 없습니다. 듀엣·픽처스 등은 해당 룰북과 검증된 콘텐츠를 확보한 뒤 별도로 구현해야 하며, 지금은 화면에 나타나지 않습니다.

## 저작권·출처

- 게임 규칙: Codenames © Czech Games Edition (게임 디자인 Vlaada Chvátil). 이 저장소에는 룰북 원문을 싣지 않고, 규칙 도움말은 자체 문장으로 요약했습니다.
- 일러스트: 이 프로젝트를 위해 새로 만든 그림(`01-illustration-prompts.md` 기준).
- 효과음: 코드로 합성한 짧은 소리. 외부 음원 없음.
- 자체 제작 단어 팩 `ko-original-v1`: 이 프로젝트가 고른 일반 명사 목록.
