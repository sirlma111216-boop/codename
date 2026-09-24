import { expect, type Browser, type BrowserContext, type Page } from '@playwright/test';

export interface Player {
  name: string;
  context: BrowserContext;
  page: Page;
  /** 이 참가자가 받은 WebSocket 프레임 전부 (정보 노출 검사용) */
  frames: string[];
}

export async function newPlayer(browser: Browser, name: string, viewport?: { width: number; height: number }): Promise<Player> {
  const context = await browser.newContext(viewport ? { viewport } : {});
  const page = await context.newPage();
  const frames: string[] = [];
  page.on('websocket', (ws) => {
    ws.on('framereceived', (f) => {
      if (typeof f.payload === 'string') frames.push(f.payload);
    });
  });
  return { name, context, page, frames };
}

export async function createRoom(p: Player): Promise<string> {
  await p.page.goto('/');
  await p.page.getByRole('button', { name: '새 방 만들기' }).click();
  await p.page.getByLabel('닉네임 (다른 참가자에게 보이는 이름)').fill(p.name);
  await p.page.getByRole('button', { name: '방 만들기', exact: true }).click();
  await expect(p.page.getByRole('heading', { name: '작전 대기실' })).toBeVisible();
  return p.page.getByLabel('초대 링크').inputValue();
}

export async function joinRoom(p: Player, link: string) {
  await p.page.goto(link);
  await p.page.getByLabel('닉네임').fill(p.name);
  await p.page.getByRole('button', { name: '입장', exact: true }).click();
  await expect(p.page.getByRole('heading', { name: '작전 대기실' })).toBeVisible();
}

export async function sit(p: Player, what: 'red-spymaster' | 'red-operative' | 'blue-spymaster' | 'blue-operative' | 'shared' | 'spectator') {
  const names: Record<typeof what, string> = {
    'red-spymaster': '◆ 스파이마스터 하기',
    'red-operative': '◆ 추측자 하기',
    'blue-spymaster': '● 스파이마스터 하기',
    'blue-operative': '● 추측자 하기',
    shared: '공용 추측자 하기',
    spectator: '관전하기',
  };
  const btn = p.page.getByRole('button', { name: names[what] });
  await btn.click();
  await expect(btn).toHaveAttribute('aria-pressed', 'true');
}

export async function dismissBriefing(p: Player) {
  const b = p.page.getByRole('button', { name: '시작', exact: true });
  if (await b.isVisible().catch(() => false)) await b.click();
}

export async function waitGame(players: Player[]) {
  for (const p of players) {
    await expect(p.page.locator('.board .card')).toHaveCount(25);
    await dismissBriefing(p);
  }
}

/** 스파이마스터 화면에서 키를 읽는다: index → 정체 */
export async function readKey(spymaster: Player): Promise<Record<number, string>> {
  const out: Record<number, string> = {};
  for (const id of ['red', 'blue', 'bystander', 'assassin']) {
    const idx = await spymaster.page.locator(`.board .card.key-${id}`).evaluateAll((els) => els.map((e) => Number((e as HTMLElement).dataset.index)));
    for (const i of idx) out[i] = id;
  }
  return out;
}

export async function startingTeam(p: Player): Promise<'red' | 'blue'> {
  const cls = (await p.page.locator('main.game').getAttribute('class')) ?? '';
  return cls.includes('team-turn-red') ? 'red' : 'blue';
}

export async function giveClue(spymaster: Player, word: string, number: string) {
  await spymaster.page.getByLabel('힌트 단어').fill(word);
  await spymaster.page.getByLabel('숫자').selectOption(number);
  await spymaster.page.getByRole('button', { name: '제출…' }).click();
  await spymaster.page.getByRole('dialog').getByRole('button', { name: '제출' }).click();
}

export async function guess(p: Player, index: number) {
  const card = p.page.locator(`.board .card[data-index="${index}"]`);
  await card.click();
  await card.click();
  await p.page.getByRole('dialog').getByRole('button', { name: '확정' }).click();
}

export async function expectRevealed(players: Player[], index: number) {
  for (const p of players) await expect(p.page.locator(`.board .card[data-index="${index}"]`)).toHaveClass(/revealed/);
}

/** 이 참가자가 받은 모든 프레임에 미공개 키 정보가 없는지 */
export function assertNoSecrets(p: Player) {
  for (const f of p.frames) {
    if (!f.startsWith('{')) continue;
    const msg = JSON.parse(f) as { t: string; room?: { game?: { cards: { key?: string; revealed: unknown }[]; phase: string; spyQueries?: unknown } | null } };
    const g = msg.room?.game;
    if (!g) continue;
    expect(f).not.toMatch(/"seed"|"keyId"|"keyRotation"|"identities"|"cardId"|"sessionHash"|"dedup"/);
    if (g.phase !== 'finished') {
      for (const c of g.cards) if (!c.revealed) expect(c.key, `${p.name} 이(가) 미공개 카드의 키를 받았다`).toBeUndefined();
      expect(g.spyQueries, `${p.name} 이(가) 스파이마스터 문의를 받았다`).toBeUndefined();
    }
  }
}
