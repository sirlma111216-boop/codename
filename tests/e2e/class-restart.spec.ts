// 학급 모드 복원: Workers 런타임을 끄고(모든 Durable Object 메모리 소실) 같은 저장소로 다시 켠 뒤
// 교사 대시보드·학생 배정·방장 관리권·게임 진행이 그대로인지, 게임 뒤 명단 잠금 해제까지 이어지는지 본다.
import { expect, test } from '@playwright/test';
import { execSync, spawn, type ChildProcess } from 'node:child_process';
import { rmSync } from 'node:fs';
import { dismissBriefing, giveClue, guess, newPlayer, readKey, startingTeam, type Player } from './helpers.ts';
import { createClass, fourPlayerRoom, joinClass } from './class-helpers.ts';

const PORT = 8791;
const BASE = `http://127.0.0.1:${PORT}`;
const STATE = '.wrangler/class-restart-state';

const start = (): ChildProcess => spawn(`npx wrangler dev --port ${PORT} --ip 127.0.0.1 --persist-to ${STATE}`, { shell: true, stdio: 'ignore' });
const stop = (p: ChildProcess) => {
  if (process.platform === 'win32') execSync(`taskkill /pid ${p.pid} /T /F`, { stdio: 'ignore' });
  else p.kill('SIGTERM');
};

async function up() {
  for (let i = 0; i < 120; i++) {
    try {
      if ((await fetch(`${BASE}/api/health`)).ok) return;
    } catch {
      /* 아직 */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('server not ready');
}

async function down() {
  for (let i = 0; i < 60; i++) {
    try {
      await fetch(`${BASE}/api/health`);
    } catch {
      return;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
}

/** helpers 는 상대 경로를 쓰므로 이 테스트 전용 서버 주소로 바꿔 부른다 */
function pointAt(p: Player) {
  const goto = p.page.goto.bind(p.page);
  p.page.goto = ((url: string, o?: Parameters<typeof goto>[1]) => goto(url.startsWith('/') ? BASE + url : url, o)) as typeof p.page.goto;
}

test('학급 모드: 런타임 재시작 뒤 배정·관리권·게임 복원', async ({ browser }) => {
  test.setTimeout(240_000);
  rmSync(STATE, { recursive: true, force: true });
  let server = start();
  await up();
  try {
    const all = await Promise.all(['교사', '가람', '나래', '다올', '라온'].map((n) => newPlayer(browser, n)));
    all.forEach(pointAt);
    const [teacher, host, s1, s2, s3] = all as [Player, Player, Player, Player, Player];
    const link = await createClass(teacher, '재시작반');
    const classId = (new URL(link).hash.slice(1).split('.')[0] ?? '') as string;
    for (const p of [host, s1, s2, s3]) await joinClass(p, link);
    await fourPlayerRoom(teacher, host, [s1, s2, s3], '복원방');
    for (const p of [host, s1, s2, s3]) {
      await expect(p.page.locator('.board .card')).toHaveCount(25);
      await dismissBriefing(p);
    }
    const team = await startingTeam(host);
    const sm = team === 'red' ? host : s2;
    const op = team === 'red' ? s1 : s3;
    const key = await readKey(sm);
    const own = Object.entries(key)
      .filter(([, v]) => v === team)
      .map(([k]) => Number(k));
    await giveClue(sm, '복원', '2');
    await guess(op, own[0] as number);
    await expect(op.page.locator('.clue-guesses')).toContainText('추측 1 / 최대 3');
    const words = await op.page.locator('.board .card .card-word').allTextContents();

    // ---- 런타임 완전 종료 → 같은 저장소로 재시작
    stop(server);
    await down();
    server = start();
    await up();

    // 교사 대시보드: 같은 방·같은 방장·게임 중
    await teacher.page.reload();
    await expect(teacher.page.locator('.room-card')).toContainText('복원방');
    await expect(teacher.page.locator('.room-card')).toContainText('방장 가람');
    await expect(teacher.page.locator('.room-card')).toContainText('게임 중');
    // 추측자: 같은 판·같은 추측 수, 여전히 정답 없음
    await op.page.reload();
    await dismissBriefing(op);
    await expect(op.page.locator('.clue-guesses')).toContainText('추측 1 / 최대 3');
    expect(await op.page.locator('.board .card .card-word').allTextContents()).toEqual(words);
    await expect(op.page.locator('.board .card[class*="key-"]')).toHaveCount(0);
    // 학생 클래스 화면: 배정 유지
    await s2.page.goto(`/c/${classId}`);
    await expect(s2.page.getByText('복원방 방에 배정되었습니다', { exact: false })).toBeVisible();
    // 방장 관리권 유지: 게임 중단 → 대기실 → 클래스 명단 잠금 해제까지 이어진다
    await host.page.reload();
    await dismissBriefing(host);
    await host.page.getByRole('tab', { name: '참가자' }).click();
    await host.page.getByRole('button', { name: '게임 중단' }).click();
    await host.page.getByRole('dialog').getByRole('button', { name: '중단' }).click();
    await host.page.getByRole('button', { name: /대기실로/ }).click();
    await expect(teacher.page.locator('.room-card')).toContainText('대기 중', { timeout: 15_000 });
    for (const p of all) await p.context.close();
  } finally {
    stop(server);
  }
});
