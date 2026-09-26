// 런타임 재시작(메모리 소실) 뒤 복원: 같은 보드·차례·추측 횟수·역할. 단어·키·턴을 다시 추첨하지 않는다.
// 이 테스트는 자기 전용 wrangler dev 를 직접 띄우고 끈다 (Durable Object 저장소는 유지).
import { expect, test } from '@playwright/test';
import { execSync, spawn, type ChildProcess } from 'node:child_process';
import { rmSync } from 'node:fs';
import { createRoom, dismissBriefing, giveClue, guess, joinRoom, newPlayer, readKey, sit, startingTeam, waitGame } from './helpers.ts';

const PORT = 8790;
const BASE = `http://127.0.0.1:${PORT}`;
const STATE = '.wrangler/restart-state';

function startServer(): ChildProcess {
  return spawn(`npx wrangler dev --port ${PORT} --ip 127.0.0.1 --persist-to ${STATE}`, { shell: true, stdio: 'ignore' });
}

function stopServer(p: ChildProcess) {
  if (process.platform === 'win32') execSync(`taskkill /pid ${p.pid} /T /F`, { stdio: 'ignore' });
  else p.kill('SIGTERM');
}

async function waitReady() {
  for (let i = 0; i < 120; i++) {
    try {
      const r = await fetch(`${BASE}/api/health`);
      if (r.ok) return;
    } catch {
      /* 아직 */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('server not ready');
}

async function waitDown() {
  for (let i = 0; i < 60; i++) {
    try {
      await fetch(`${BASE}/api/health`);
    } catch {
      return;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
}

test('서버 재시작 뒤에도 같은 게임 상태로 복귀한다', async ({ browser }) => {
  test.setTimeout(180_000);
  rmSync(STATE, { recursive: true, force: true });
  let server = startServer();
  await waitReady();
  try {
    const players = await Promise.all(['재시작방장', '재빨강', '재파랑스', '재파랑'].map((n) => newPlayer(browser, n)));
    for (const p of players) await p.page.goto(BASE); // baseURL 대신 이 서버
    const [h, r, b, bo] = players as [typeof players[0], typeof players[0], typeof players[0], typeof players[0]];
    // helpers 는 상대 경로를 쓰므로 이 서버 주소로 바꿔 부른다
    for (const p of players) {
      const goto = p.page.goto.bind(p.page);
      p.page.goto = ((url: string, opts?: Parameters<typeof goto>[1]) => goto(url.startsWith('/') ? BASE + url : url, opts)) as typeof p.page.goto;
    }
    const link = await createRoom(h);
    for (const p of [r, b, bo]) await joinRoom(p, link);
    await sit(h, 'red-spymaster');
    await sit(r, 'red-operative');
    await sit(b, 'blue-spymaster');
    await sit(bo, 'blue-operative');
    await h.page.getByRole('button', { name: '게임 시작' }).click();
    await waitGame(players);
    const start = await startingTeam(h);
    const sm = start === 'red' ? h : b;
    const op = start === 'red' ? r : bo;
    const key = await readKey(sm);
    const own = Object.entries(key).filter(([, v]) => v === start).map(([k]) => Number(k));
    await giveClue(sm, '재시작', '3');
    await guess(op, own[0] as number);
    await expect(op.page.locator('.clue-guesses')).toContainText('추측 1 / 최대 4');
    const words = await h.page.locator('.board .card .card-word').allTextContents();

    // ---- 런타임을 완전히 끈다 (메모리 소실)
    stopServer(server);
    await waitDown();
    await expect(op.page.locator('.conn-banner')).toBeVisible({ timeout: 20_000 });

    server = startServer();
    await waitReady();
    // 자동 재접속을 기다리거나 버튼으로 바로 붙는다. 자동 재접속이 먼저 성공하면 버튼이 사라지므로 짧게만 기다린다
    await op.page.getByRole('button', { name: '지금 다시 연결' }).click({ timeout: 3000 }).catch(() => {});
    await expect(op.page.locator('.conn-banner')).toHaveCount(0, { timeout: 30_000 });
    await expect(op.page.locator('.clue-word')).toHaveText('재시작');
    await expect(op.page.locator('.clue-guesses')).toContainText('추측 1 / 최대 4');
    await expect(op.page.locator('.board .card.revealed')).toHaveCount(1);

    await sm.page.reload();
    // 새로고침 직후에는 판이 아직 그려지지 않았을 수 있다: 단어가 다 나올 때까지 기다린다
    await expect(sm.page.locator('.board .card .card-word')).toHaveCount(words.length);
    await dismissBriefing(sm);
    expect(await sm.page.locator('.board .card .card-word').allTextContents()).toEqual(words);
    // 키를 다시 뽑지 않았다 (공개된 1장은 덮개가 올라가 키 표시가 없으므로 나머지 24장을 비교)
    const after = await readKey(sm);
    expect(Object.keys(after)).toHaveLength(24);
    for (const [i, v] of Object.entries(after)) expect(key[Number(i)]).toBe(v);
    // 추측자는 여전히 키를 받지 않는다
    await expect(op.page.locator('.board .card[class*="key-"]')).toHaveCount(0);
    // 이어서 진행할 수 있다
    await guess(op, own[1] as number);
    await expect(sm.page.locator('.clue-guesses')).toContainText('추측 2 / 최대 4');
    for (const p of players) await p.context.close();
  } finally {
    stopServer(server);
  }
});
