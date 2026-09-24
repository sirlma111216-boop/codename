// npm run release:check [-- --e2e] [-- --require-official]
// 배포 전 점검. '엔진/통신 구현'과 '원본 콘텐츠 검증'을 따로 보고한다.
// 기본은 콘텐츠 미완료여도 종료 코드 0 (대기실 배포는 가능), --require-official 이면 1.

import { execSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const e2e = process.argv.includes('--e2e');
const requireOfficial = process.argv.includes('--require-official');
const results: { name: string; ok: boolean; note?: string }[] = [];

function step(name: string, cmd: string) {
  process.stdout.write(`▶ ${name} … `);
  try {
    execSync(cmd, { stdio: 'pipe' });
    results.push({ name, ok: true });
    console.log('통과');
  } catch (e) {
    const out = (e as { stdout?: Buffer; stderr?: Buffer }).stdout?.toString() ?? '';
    results.push({ name, ok: false, note: out.split('\n').slice(-15).join('\n') });
    console.log('실패');
  }
}

step('타입 검사', 'npm run typecheck');
step('린트', 'npm run lint');
step('단위 테스트 (엔진·방·정보 분리)', 'npm test');
step('프로덕션 빌드', 'npm run build');

// 번들·정적 경로에 콘텐츠 원본·키가 없는지
const leaks: string[] = [];
function scan(dir: string) {
  for (const f of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, f.name);
    if (f.isDirectory()) scan(p);
    else if (/\.(js|html|json|css)$/.test(f.name)) {
      const s = readFileSync(p, 'utf8');
      if (/koo-0\d\d|sourceReference|"startingTeam"|keyRotation|"faceB"/.test(s)) leaks.push(p);
    }
  }
}
if (existsSync('dist/client')) scan('dist/client');
results.push({ name: '클라이언트 번들·정적 파일에 콘텐츠 원본·키 없음', ok: leaks.length === 0, note: leaks.join(', ') });

// Wrangler 설정
const cfg = readFileSync('wrangler.jsonc', 'utf8');
results.push({
  name: 'Wrangler: SQLite Durable Object 마이그레이션·/api 우선 라우팅·staging 분리',
  ok: cfg.includes('new_sqlite_classes') && cfg.includes('"run_worker_first"') && cfg.includes('codename-staging'),
});

if (e2e) step('브라우저 멀티클라이언트 (Playwright, 로컬 Workers 런타임)', 'npm run test:e2e');

let contentOk = true;
let report: string;
try {
  report = execSync('npm run content:verify', { stdio: 'pipe', encoding: 'utf8' });
} catch (e) {
  contentOk = false;
  report = (e as { stdout?: string }).stdout ?? '';
}
const officialReady = report.includes('정식 모드(한국어 정식판 + 원본 키 카드): 사용 가능');

console.log('\n================ 릴리스 점검 ================');
for (const r of results) console.log(`${r.ok ? '✅' : '❌'} ${r.name}${r.ok || !r.note ? '' : `\n${r.note}`}`);
console.log(`${contentOk ? '✅' : '❌'} 콘텐츠 팩 구조 검사`);
if (!e2e) console.log('ℹ️ 브라우저 멀티클라이언트 테스트는 이번에 실행하지 않았습니다 (--e2e 로 실행).');
console.log('--------------------------------------------');
const engineOk = results.every((r) => r.ok) && contentOk;
console.log(`엔진/통신 구현: ${engineOk ? '점검 통과' : '문제 있음'}`);
console.log(`원본 콘텐츠 검증: ${officialReady ? '완료' : '미완료 — 한국어 정식판 400단어·원본 키 카드 40장 미확보 (정식 모드 비활성, 비공식 팩으로만 플레이)'}`);
process.exit(!engineOk || (requireOfficial && !officialReady) ? 1 : 0);
