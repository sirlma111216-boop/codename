// 경쟁 상태·멱등·권한·정보 노출. 각 참가자의 브라우저 context 안에서 WebSocket 원시 프레임을 보낸다
// (쿠키 세션·Origin 검사를 그대로 거친다).
import { expect, test, type Page } from '@playwright/test';
import { createRoom, joinRoom, newPlayer, sit, waitGame, type Player } from './helpers.ts';

interface RawRoom {
  revision: number;
  you: { memberId: string };
  game: { gameId: string; revision: number; phase: string; turnTeam: 'red' | 'blue'; cards: { index: number; key?: string; revealed: unknown }[] } | null;
}

async function openRaw(page: Page) {
  const roomId = new URL(page.url()).pathname.split('/')[2] as string;
  await page.evaluate(async (roomId) => {
    const w = window as unknown as { __raw: { ws: WebSocket; msgs: Record<string, unknown>[] } };
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/rooms/${roomId}/ws`);
    const msgs: Record<string, unknown>[] = [];
    w.__raw = { ws, msgs };
    ws.onmessage = (e) => {
      if (e.data !== 'pong') msgs.push(JSON.parse(e.data as string) as Record<string, unknown>);
    };
    await new Promise((res, rej) => {
      ws.onopen = res;
      ws.onerror = rej;
    });
    ws.send(JSON.stringify({ t: 'hello', protocol: 1 }));
    await new Promise<void>((res) => {
      const t = setInterval(() => {
        if (msgs.some((m) => m.t === 'hello')) {
          clearInterval(t);
          res();
        }
      }, 30);
    });
  }, roomId);
}

async function rawState(page: Page): Promise<RawRoom> {
  return page.evaluate(() => {
    const w = window as unknown as { __raw: { msgs: { t: string; room?: unknown }[] } };
    const states = w.__raw.msgs.filter((m) => m.t === 'state');
    return states[states.length - 1]?.room as RawRoom;
  });
}

async function rawSend(page: Page, frame: object): Promise<{ ok: boolean; code?: string }> {
  return page.evaluate(async (frame) => {
    const w = window as unknown as { __raw: { ws: WebSocket; msgs: { t: string; commandId?: string; ok?: boolean; code?: string }[] } };
    const id = (frame as { commandId: string }).commandId;
    const before = w.__raw.msgs.filter((m) => m.t === 'ack' && m.commandId === id).length;
    const errorsBefore = w.__raw.msgs.filter((m) => m.t === 'error').length;
    w.__raw.ws.send(JSON.stringify(frame));
    return await new Promise((res) => {
      const t = setInterval(() => {
        const acks = w.__raw.msgs.filter((m) => m.t === 'ack' && m.commandId === id);
        const errors = w.__raw.msgs.filter((m) => m.t === 'error');
        if (errors.length > errorsBefore) {
          clearInterval(t);
          res({ ok: false, code: (errors[errors.length - 1] as { code?: string }).code });
          return;
        }
        if (acks.length > before) {
          clearInterval(t);
          const a = acks[acks.length - 1] as { ok: boolean; code?: string };
          res({ ok: a.ok, code: a.code });
        }
      }, 20);
    });
  }, frame);
}

let seq = 0;
const cid = () => `e2e${Date.now().toString(36)}${(seq++).toString(36)}xx`;
const gameCmd = (g: NonNullable<RawRoom['game']>, action: object, extra: object = {}) => ({ t: 'cmd', commandId: cid(), gameId: g.gameId, expectedRevision: g.revision, cmd: { type: 'game', action }, ...extra });

async function settle(page: Page, pred: (r: RawRoom) => boolean) {
  await expect.poll(async () => pred(await rawState(page)), { timeout: 8000 }).toBe(true);
}

test('동시 확정·재전송·stale revision·이전 gameId·권한·강퇴·번들 검사', async ({ browser }) => {
  const names = ['R스파이', 'R추측1', 'R추측2', 'B스파이', 'B추측1', 'B추측2'];
  const [rs, ro1, ro2, bs, bo1, bo2] = await Promise.all(names.map((n) => newPlayer(browser, n))) as Player[] & { length: 6 };
  const everyone = [rs, ro1, ro2, bs, bo1, bo2] as Player[];
  const link = await createRoom(rs as Player);
  for (const p of everyone.slice(1)) await joinRoom(p, link);
  await sit(rs as Player, 'red-spymaster');
  await sit(ro1 as Player, 'red-operative');
  await sit(ro2 as Player, 'red-operative');
  await sit(bs as Player, 'blue-spymaster');
  await sit(bo1 as Player, 'blue-operative');
  await sit(bo2 as Player, 'blue-operative');
  await (rs as Player).page.getByRole('button', { name: '게임 시작' }).click();
  await waitGame(everyone);
  for (const p of everyone) await openRaw(p.page);

  const smState = await rawState((rs as Player).page);
  const start = smState.game!.turnTeam;
  const sm = start === 'red' ? (rs as Player) : (bs as Player);
  const [op1, op2] = start === 'red' ? [ro1 as Player, ro2 as Player] : [bo1 as Player, bo2 as Player];
  const otherOp = start === 'red' ? (bo1 as Player) : (ro1 as Player);
  const key = (await rawState(sm.page)).game!.cards.map((c) => c.key);
  const own = key.map((k, i) => (k === start ? i : -1)).filter((i) => i >= 0);

  // 추측자에게는 키가 없다
  expect((await rawState(op1.page)).game!.cards.every((c) => c.key === undefined)).toBe(true);

  // 스파이마스터가 아닌 사람은 힌트를 줄 수 없다
  let g = (await rawState(op1.page)).game!;
  expect(await rawSend(op1.page, gameCmd(g, { type: 'giveClue', word: '해킹', number: 2 }))).toMatchObject({ ok: false, code: 'notYourTurn' });

  g = (await rawState(sm.page)).game!;
  expect(await rawSend(sm.page, gameCmd(g, { type: 'giveClue', word: '경쟁', number: 'unlimited' }))).toEqual({ ok: true });
  await settle(op1.page, (r) => r.game?.phase === 'guessing');
  await settle(op2.page, (r) => r.game?.phase === 'guessing');

  // ---- 다른 카드 동시 확정: 같은 revision 으로 두 명이 보낸다 → 하나만 반영
  let g1 = (await rawState(op1.page)).game!;
  let g2 = (await rawState(op2.page)).game!;
  expect(g1.revision).toBe(g2.revision);
  const [a1, a2] = await Promise.all([
    rawSend(op1.page, gameCmd(g1, { type: 'guess', index: own[0] })),
    rawSend(op2.page, gameCmd(g2, { type: 'guess', index: own[1] })),
  ]);
  expect([a1.ok, a2.ok].filter(Boolean)).toHaveLength(1);
  expect([a1.code, a2.code]).toContain('staleRevision');
  await settle(op1.page, (r) => r.game!.cards.filter((c) => c.revealed).length === 1);

  // ---- 같은 카드 동시 확정 → 한 번만 공개
  await settle(op2.page, (r) => r.game!.cards.filter((c) => c.revealed).length === 1);
  g1 = (await rawState(op1.page)).game!;
  g2 = (await rawState(op2.page)).game!;
  const target = own.find((i) => !g1.cards[i]?.revealed) as number;
  const [b1, b2] = await Promise.all([rawSend(op1.page, gameCmd(g1, { type: 'guess', index: target })), rawSend(op2.page, gameCmd(g2, { type: 'guess', index: target }))]);
  expect([b1.ok, b2.ok].filter(Boolean)).toHaveLength(1);
  await settle(op1.page, (r) => r.game!.cards.filter((c) => c.revealed).length === 2);

  // ---- 같은 commandId 재전송(연결 복구 상황) → 서버가 멱등 처리, 두 번 반영되지 않는다
  g1 = (await rawState(op1.page)).game!;
  const next = own.find((i) => !g1.cards[i]?.revealed) as number;
  const frame = gameCmd(g1, { type: 'guess', index: next });
  expect(await rawSend(op1.page, frame)).toEqual({ ok: true });
  await settle(op1.page, (r) => r.game!.cards.filter((c) => c.revealed).length === 3);
  expect(await rawSend(op1.page, frame)).toEqual({ ok: true });
  // 같은 명령을 다른 탭(같은 세션의 새 연결)에서 다시 보내도 결과는 같다
  const dupTab = await op1.context.newPage();
  await dupTab.goto(op1.page.url());
  await openRaw(dupTab);
  expect(await rawSend(dupTab, frame)).toEqual({ ok: true });
  await dupTab.waitForTimeout(300);
  expect((await rawState(op1.page)).game!.cards.filter((c) => c.revealed).length).toBe(3);
  await dupTab.close();

  // ---- 오래된 revision · 이전 gameId
  const stale = { ...g1, revision: g1.revision - 1 }; // 한 수 뒤처진 화면
  expect(await rawSend(op1.page, gameCmd(stale, { type: 'guess', index: own[4] }))).toMatchObject({ ok: false, code: 'staleRevision' });
  const cur = (await rawState(op1.page)).game!;
  expect(await rawSend(op1.page, gameCmd({ ...cur, gameId: 'old-game-id' }, { type: 'guess', index: own[4] }))).toMatchObject({ ok: false, code: 'staleGame' });

  // ---- 다른 팀 추측자는 추측할 수 없다
  await settle(otherOp.page, (r) => r.game!.revision === cur.revision);
  const og = (await rawState(otherOp.page)).game!;
  expect(await rawSend(otherOp.page, gameCmd(og, { type: 'guess', index: own[4] }))).toMatchObject({ ok: false, code: 'notYourTurn' });

  // ---- 방장이 아닌 참가자는 강퇴·방 닫기 불가
  expect(await rawSend(op1.page, { t: 'cmd', commandId: cid(), cmd: { type: 'closeRoom' } })).toMatchObject({ ok: false, code: 'forbidden' });

  // ---- 게임 중 스파이마스터는 자유 채팅을 보낼 수 없다
  expect(await rawSend(sm.page, { t: 'cmd', commandId: cid(), cmd: { type: 'chat', text: '힌트 더 줄게' } })).toMatchObject({ ok: false, code: 'forbidden' });

  // ---- 강퇴: 기존 소켓이 끊기고 초대 링크로도 다시 못 들어온다
  const victim = bo2 as Player;
  const victimId = (await rawState(victim.page)).you.memberId;
  expect(await rawSend((rs as Player).page, { t: 'cmd', commandId: cid(), cmd: { type: 'kick', memberId: victimId } })).toEqual({ ok: true });
  await expect(victim.page.getByText('방장이 이 방에서 내보냈습니다.')).toBeVisible();
  await victim.page.goto(link);
  await expect(victim.page.getByText('강퇴되어 다시 들어갈 수 없습니다')).toBeVisible();

  // ---- 초대 없이 방 주소만 아는 사람은 들어갈 수 없다
  const stranger = await newPlayer(browser, '외부인');
  await stranger.page.goto((rs as Player).page.url());
  await expect(stranger.page.getByText('이 브라우저는 이 방의 참가자가 아닙니다.')).toBeVisible();
  const opened = await stranger.page.evaluate(async (path) => {
    return await new Promise<boolean>((res) => {
      const ws = new WebSocket(`ws://${location.host}/api/rooms/${path}/ws`);
      ws.onopen = () => res(true);
      ws.onerror = () => res(false);
      ws.onclose = () => res(false);
    });
  }, new URL((rs as Player).page.url()).pathname.split('/')[2]);
  expect(opened).toBe(false);

  // ---- 프런트엔드 번들·정적 경로에 키·콘텐츠 원본이 없다
  const html = await (await stranger.page.request.get('/')).text();
  const scripts = [...html.matchAll(/src="(\/static\/[^"]+\.js)"/g)].map((m) => m[1] as string);
  expect(scripts.length).toBeGreaterThan(0);
  for (const s of scripts) {
    const js = await (await stranger.page.request.get(s)).text();
    expect(js).not.toMatch(/koo-0\d\d|sourceReference|"startingTeam":|keyRotation|faceB/);
  }
  for (const path of ['/content/registry.ts', '/content/packs/ko-original-v1/cards.json', '/content/packs/ko-official-classic/keys.json']) {
    const r = await stranger.page.request.get(path);
    expect((await r.text()).includes('koo-001')).toBe(false);
  }
  // /api/* 오류는 index.html 이 아니라 JSON 으로 응답한다
  const api404 = await stranger.page.request.get('/api/does-not-exist');
  expect(api404.headers()['content-type']).toContain('application/json');

  for (const p of [...everyone, stranger]) await p.context.close();
});
