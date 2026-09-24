// 표준 대전: 독립 browser context 4개(두 팀) + 관전자 1개. 정보 격리·진행·종료·재경기.
import { expect, test } from '@playwright/test';
import {
  assertNoSecrets,
  createRoom,
  dismissBriefing,
  expectRevealed,
  giveClue,
  guess,
  joinRoom,
  newPlayer,
  readKey,
  sit,
  startingTeam,
  waitGame,
} from './helpers.ts';

test('표준 대전 4인 + 관전자: 정보 격리, 추측, 암살자 종료, 재경기, 새로고침 복원', async ({ browser }) => {
  const host = await newPlayer(browser, '방장빨강');
  const redOp = await newPlayer(browser, '빨강추측');
  const blueSm = await newPlayer(browser, '파랑스파이');
  const blueOp = await newPlayer(browser, '파랑추측');
  const spec = await newPlayer(browser, '관전자');
  const all = [host, redOp, blueSm, blueOp, spec];

  const link = await createRoom(host);
  expect(link).toMatch(/\/join#[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]+$/);
  for (const p of [redOp, blueSm, blueOp, spec]) await joinRoom(p, link);
  // 초대 토큰은 주소창에서 지워진다
  expect(redOp.page.url()).not.toContain('#');

  await sit(host, 'red-spymaster');
  await sit(redOp, 'red-operative');
  await sit(blueSm, 'blue-spymaster');
  await sit(blueOp, 'blue-operative');
  await expect(host.page.getByText('역할이 모두 준비되었습니다.')).toBeVisible();
  // 방장이 아닌 사람은 시작 버튼이 없다
  await expect(redOp.page.getByRole('button', { name: '게임 시작' })).toHaveCount(0);
  await host.page.getByRole('button', { name: '게임 시작' }).click();
  await waitGame(all);

  // ---- 정보 격리: 스파이마스터만 키를 본다 (DOM·접근성 이름·WebSocket 프레임)
  await expect(host.page.locator('.board .card[class*="key-"]')).toHaveCount(25);
  await expect(blueSm.page.locator('.board .card[class*="key-"]')).toHaveCount(25);
  for (const p of [redOp, blueOp, spec]) {
    await expect(p.page.locator('.board .card[class*="key-"]')).toHaveCount(0);
    const labels = await p.page.locator('.board .card').evaluateAll((els) => els.map((e) => e.getAttribute('aria-label') ?? ''));
    for (const l of labels) expect(l).not.toMatch(/요원|시민|암살/);
    assertNoSecrets(p);
  }
  const key = await readKey(host);
  expect(Object.keys(key)).toHaveLength(25);

  const start = await startingTeam(host);
  const sm = start === 'red' ? host : blueSm;
  const op = start === 'red' ? redOp : blueOp;
  const otherOp = start === 'red' ? blueOp : redOp;
  const own = Object.entries(key).filter(([, v]) => v === start).map(([k]) => Number(k));
  const assassin = Number(Object.entries(key).find(([, v]) => v === 'assassin')?.[0]);

  // 상대 팀 추측자·스파이마스터는 힌트를 줄 수 없고 카드를 고를 수 없다
  await expect(otherOp.page.getByLabel('힌트 단어')).toHaveCount(0);

  // 보드에 보이는 단어는 힌트로 못 쓴다 (클라이언트 경고 + 서버 거절)
  const visibleWord = (await sm.page.locator(`.board .card[data-index="${own[0]}"] .card-word`).textContent()) ?? '';
  await sm.page.getByLabel('힌트 단어').fill(visibleWord);
  await expect(sm.page.getByText('힌트로 쓸 수 없습니다')).toBeVisible();

  await giveClue(sm, '작전', '2');
  for (const p of all) await expect(p.page.locator('.clue-word')).toHaveText('작전');

  // 자기 팀 요원 → 계속
  await guess(op, own[0] as number);
  await expectRevealed(all, own[0] as number);
  await expect(op.page.locator('.clue-guesses')).toContainText('추측 1 / 최대 3');

  // 새로고침 뒤 같은 보드·차례·추측 횟수로 복원
  await op.page.reload();
  await dismissBriefing(op);
  await expect(op.page.locator('.board .card.revealed')).toHaveCount(1);
  await expect(op.page.locator('.clue-guesses')).toContainText('추측 1 / 최대 3');
  const wordsBefore = await host.page.locator('.board .card .card-word').allTextContents();
  const wordsAfter = await op.page.locator('.board .card .card-word').allTextContents();
  expect(wordsAfter).toEqual(wordsBefore);

  // 관전자는 게임 중 채팅을 보낼 수 없다
  await spec.page.getByRole('tab', { name: '토론' }).click();
  await expect(spec.page.getByText('관전자는 게임 중 읽기만 할 수 있습니다.')).toBeVisible();

  // 암살자 → 즉시 종료, 추측한 팀 패배
  await guess(op, assassin);
  for (const p of all) {
    await expect(p.page.locator('.finish-title')).toHaveText(`${start === 'red' ? '파랑' : '빨강'} 팀 승리`);
    // 종료 뒤에는 모두에게 전체 정체가 공개된다
    await expect(p.page.locator('.board .card.revealed, .board .card[class*="final-"]')).toHaveCount(25);
  }
  await host.page.screenshot({ path: 'screens/standard-finished.png', fullPage: false });

  // 같은 방에서 재경기
  await host.page.getByRole('button', { name: '대기실로 (같은 방에서 새 게임)' }).click();
  for (const p of all) await expect(p.page.getByRole('heading', { name: '작전 대기실' })).toBeVisible();
  await host.page.getByRole('button', { name: '게임 시작' }).click();
  await waitGame(all);
  const key2 = await readKey(blueSm);
  expect(Object.keys(key2)).toHaveLength(25);

  for (const p of all) await p.context.close();
});
