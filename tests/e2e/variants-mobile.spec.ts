// 기본판 소인원 변형(p.8) 과 모바일 360px 화면
import { expect, test } from '@playwright/test';
import { createRoom, dismissBriefing, giveClue, guess, joinRoom, newPlayer, readKey, sit, startingTeam, waitGame } from './helpers.ts';

test('소인원 협력: 사람 팀 선공 → 턴 종료 뒤 스파이마스터가 가상 상대 요원 1장을 덮는다', async ({ browser }) => {
  const sm = await newPlayer(browser, '협력스파이');
  const op = await newPlayer(browser, '협력추측');
  const link = await createRoom(sm);
  await joinRoom(op, link);
  await sm.page.getByText('소인원 협력 (가상 상대)').click();
  await sit(sm, 'blue-spymaster');
  await sit(op, 'blue-operative');
  await sm.page.getByRole('button', { name: '게임 시작' }).click();
  await waitGame([sm, op]);
  expect(await startingTeam(sm)).toBe('blue');
  await expect(sm.page.getByText('(가상 상대)').first()).toBeVisible();

  const key = await readKey(sm);
  const bystander = Number(Object.entries(key).find(([, v]) => v === 'bystander')?.[0]);
  const enemy = Number(Object.entries(key).find(([, v]) => v === 'red')?.[0]);
  await giveClue(sm, '협력', '1');
  await guess(op, bystander); // 시민 → 턴 종료 → 가상 상대 차례
  await expect(sm.page.getByText('가상 상대의 차례').first()).toBeVisible();
  // 신고 기능은 협력 변형에 없다
  await expect(op.page.getByRole('button', { name: '이 힌트에 이의 신고' })).toHaveCount(0);
  // 추측자는 가상 상대 카드를 고를 수 없다
  await expect(op.page.locator('.board .card.selectable')).toHaveCount(0);
  await guess(sm, enemy);
  await expect(op.page.locator(`.board .card[data-index="${enemy}"]`)).toHaveClass(/revealed-red/);
  await expect(sm.page.getByLabel('힌트 단어')).toBeVisible();
  await sm.context.close();
  await op.context.close();
});

test('3인 공용 추측자: 한 사람이 양쪽 팀을 위해 추측한다', async ({ browser }) => {
  const rs = await newPlayer(browser, '빨강스파이');
  const bs = await newPlayer(browser, '파랑스파이');
  const so = await newPlayer(browser, '공용추측');
  const link = await createRoom(rs);
  await joinRoom(bs, link);
  await joinRoom(so, link);
  await rs.page.getByText('3인 공용 추측자').click();
  await sit(rs, 'red-spymaster');
  await sit(bs, 'blue-spymaster');
  await sit(so, 'shared');
  await rs.page.getByRole('button', { name: '게임 시작' }).click();
  await waitGame([rs, bs, so]);
  const start = await startingTeam(rs);
  const sm = start === 'red' ? rs : bs;
  const smOther = start === 'red' ? bs : rs;
  const key = await readKey(sm);
  const bystander = Number(Object.entries(key).find(([, v]) => v === 'bystander')?.[0]);
  await giveClue(sm, '첫힌트', '1');
  await guess(so, bystander);
  await expect(smOther.page.getByLabel('힌트 단어')).toBeVisible();
  await giveClue(smOther, '둘째', '1');
  const other = start === 'red' ? 'blue' : 'red';
  const otherOwn = Number(Object.entries(key).find(([, v]) => v === other)?.[0]);
  await guess(so, otherOwn);
  await expect(rs.page.locator(`.board .card[data-index="${otherOwn}"]`)).toHaveClass(new RegExp(`revealed-${other}`));
  for (const p of [rs, bs, so]) await p.context.close();
});

test('모바일 360px: 5열 유지, 가로 스크롤 없음, 단어 잘림 없음, 확정 창', async ({ browser }) => {
  const size = { width: 360, height: 740 };
  const players = await Promise.all(['M방장', 'M빨강', 'M파랑스', 'M파랑'].map((n) => newPlayer(browser, n, size)));
  const [h, r, b, bo] = players as [typeof players[0], typeof players[0], typeof players[0], typeof players[0]];
  const link = await createRoom(h);
  for (const p of [r, b, bo]) await joinRoom(p, link);
  await h.page.screenshot({ path: 'screens/mobile-lobby.png', fullPage: true });
  await sit(h, 'red-spymaster');
  await sit(r, 'red-operative');
  await sit(b, 'blue-spymaster');
  await sit(bo, 'blue-operative');
  await h.page.getByRole('button', { name: '게임 시작' }).click();
  await waitGame(players);
  for (const p of players) await dismissBriefing(p);

  for (const p of [h, r]) {
    const layout = await p.page.evaluate(() => {
      const cards = [...document.querySelectorAll('.board .card')] as HTMLElement[];
      const xs = new Set(cards.map((c) => Math.round(c.getBoundingClientRect().left)));
      const clipped = [...document.querySelectorAll('.board .card-word')].filter((w) => (w as HTMLElement).scrollWidth > (w.parentElement as HTMLElement).clientWidth + 1).length;
      return { columns: xs.size, pageScroll: document.documentElement.scrollWidth - window.innerWidth, clipped, cardWidth: cards[0]?.getBoundingClientRect().width ?? 0 };
    });
    expect(layout.columns).toBe(5);
    expect(layout.pageScroll).toBeLessThanOrEqual(0);
    expect(layout.clipped).toBe(0);
    expect(layout.cardWidth).toBeGreaterThan(50);
  }
  await h.page.screenshot({ path: 'screens/mobile-spymaster.png' });
  await r.page.screenshot({ path: 'screens/mobile-operative.png' });

  // 확정 창에 단어가 크게 보인다
  const start = await startingTeam(h);
  const sm = start === 'red' ? h : b;
  const op = start === 'red' ? r : bo;
  await giveClue(sm, '모바일', '1');
  const first = op.page.locator('.board .card').first();
  await first.click();
  await first.click();
  await expect(op.page.locator('.confirm-word')).toBeVisible();
  await op.page.screenshot({ path: 'screens/mobile-confirm.png' });
  await op.page.getByRole('dialog').getByRole('button', { name: '취소' }).click();
  for (const p of players) await p.context.close();
});

test('아이폰 크기 + 브라우저 글자 크기 확대: 카드 단어가 쪼개지거나 카드 밖으로 넘치지 않는다', async ({ browser }) => {
  const me = await newPlayer(browser, '아이폰', { width: 390, height: 844 });
  await me.page.goto('/');
  await me.page.getByRole('button', { name: /혼자서 플레이/ }).click();
  const dlg = me.page.getByRole('dialog');
  await dlg.getByLabel('닉네임').fill(me.name);
  await dlg.getByText('천천히', { exact: true }).click();
  await dlg.getByRole('button', { name: '시작', exact: true }).click();
  await expect(me.page.locator('.board .card')).toHaveCount(25);
  await dismissBriefing(me);
  // 카카오톡 인앱 ‘가가’·사파리 텍스트 크기처럼 글자만 약 2배 키운다 — 신고된 화면(‘외계/인’, ‘플라스/틱’으로 쪼개짐)과 비슷한 크기 (카드 크기는 그대로)
  await me.page.addStyleTag({
    content: `.board .card-word.w-2{font-size:52cqi}.board .card-word.w-3{font-size:44cqi}.board .card-word.w-4{font-size:36cqi}.board .card-word.w-6{font-size:26cqi}.board .card-word.w-9{font-size:21cqi}.board .card-word.w-long{font-size:18cqi}`,
  });
  await me.page.setViewportSize({ width: 391, height: 844 }); // 다시 맞추기(ResizeObserver)
  await me.page.waitForTimeout(300);
  const bad = await me.page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('.board .card-word')]
      .map((w) => {
        const face = (w.parentElement as HTMLElement).getBoundingClientRect();
        const r = w.getBoundingClientRect();
        // 줄 수: 글자 높이로 나눈 값 (inline 이든 inline-block 이든 같게 잰다)
        const lines = Math.round(r.height / (parseFloat(getComputedStyle(w).fontSize) * 1.1)) || w.getClientRects().length;
        const short = [...(w.textContent ?? '')].length <= 6;
        const outside = r.left < face.left - 1 || r.right > face.right + 1 || r.top < face.top - 1 || r.bottom > face.bottom + 1 || w.scrollWidth > w.clientWidth + 1;
        return { word: w.textContent, outside, split: short && lines > 1 };
      })
      .filter((x) => x.outside || x.split),
  );
  await me.page.screenshot({ path: 'test-results/mobile-text-zoom.png' });
  expect(bad).toEqual([]);
  await me.context.close();
});
