// 봇: 혼자서 플레이(추측자·관전)와 학급 시뮬레이션 방. 실제 브라우저 → 실제 서버(Durable Object alarm 으로 봇이 움직임).
// 봇 속도는 ‘빠르게’로 둔다. 사람 추측자의 모든 프레임에 미공개 정답이 없는지도 본다.
import { expect, test, type Page } from '@playwright/test';
import { assertNoSecrets, dismissBriefing, newPlayer, type Player } from './helpers.ts';
import { createClass } from './class-helpers.ts';

test.describe.configure({ timeout: 240_000 });

const shot = (p: Page, name: string) => p.screenshot({ path: `test-results/bots-${name}.png`, fullPage: true });

async function openSolo(p: Player, opts: { role: '추측자 (봇이 힌트)' | '스파이마스터 (봇이 추측)' | '관전만 (봇끼리)'; players?: string; rules?: string }) {
  await p.page.goto('/');
  await p.page.getByRole('button', { name: /혼자서 플레이/ }).click();
  const dlg = p.page.getByRole('dialog');
  await dlg.getByLabel('닉네임').fill(p.name);
  if (opts.rules) await dlg.getByText(opts.rules, { exact: true }).click();
  await dlg.getByText(opts.role, { exact: true }).click();
  if (opts.players) await dlg.getByLabel(/게임 인원|봇 수/).selectOption(opts.players);
  await dlg.getByText('빠르게', { exact: true }).click();
  await shot(p.page, 'solo-dialog');
  await dlg.getByRole('button', { name: '시작', exact: true }).click();
  await expect(p.page.locator('.board .card')).toHaveCount(25);
  await dismissBriefing(p);
}

/** 사람 추측자: 내 차례면 아직 안 덮인 카드 하나를 고르고, 한 번 고른 뒤에는 턴을 끝낸다 */
async function humanOperativeStep(p: Player): Promise<boolean> {
  const page = p.page;
  if (await page.locator('.finish, .finish-mini').isVisible().catch(() => false)) return true;
  const end = page.getByRole('button', { name: '추측 끝내기' });
  if (await end.isVisible().catch(() => false)) {
    if (await end.isEnabled()) {
      await end.click();
      return false;
    }
    const card = page.locator('.board .card:not(.revealed)').first();
    await card.click();
    await card.click();
    await page.getByRole('dialog').getByRole('button', { name: '확정' }).click();
    await page.waitForTimeout(300);
    return false;
  }
  await page.waitForTimeout(500);
  return false;
}

test('혼자서 플레이 (추측자): 봇이 힌트를 주고 상대 봇이 두며, 사람은 정답을 받지 않는다', async ({ browser }) => {
  const me = await newPlayer(browser, '혼자');
  await openSolo(me, { role: '추측자 (봇이 힌트)' });
  // 봇 스파이마스터의 힌트가 온다 (우리 팀이 후공이면 상대 봇 차례가 먼저 지나간다)
  await expect(me.page.locator('.cluebar .clue-word')).toBeVisible({ timeout: 30_000 });
  await shot(me.page, 'solo-operative-clue');
  let done = false;
  for (let i = 0; i < 120 && !done; i++) done = await humanOperativeStep(me);
  await expect(me.page.locator('.finish')).toBeVisible({ timeout: 60_000 });
  await shot(me.page, 'solo-operative-finish');
  // 게임 동안 받은 모든 프레임에 미공개 정답이 없다
  assertNoSecrets(me);
  // 끝난 뒤 봇 스파이마스터가 노린 단어가 기록에 보인다
  await me.page.getByRole('button', { name: '판 보기' }).click();
  await expect(me.page.locator('.bot-intent').first()).toBeVisible();
  // 같은 설정으로 다시
  await me.page.getByRole('button', { name: '결과 보기' }).click();
  await me.page.getByRole('button', { name: /다시 하기/ }).click();
  await expect(me.page.locator('.finish')).toHaveCount(0);
  await expect(me.page.locator('.board .card.revealed')).toHaveCount(0);
  await me.context.close();
});

test('혼자서 플레이 (관전): 봇끼리 끝까지 두고, 정답 보며 관전을 켜면 키가 보인다', async ({ browser }) => {
  const me = await newPlayer(browser, '관전');
  await openSolo(me, { role: '관전만 (봇끼리)', players: '4' });
  await expect(me.page.getByText('정답 보며 관전')).toBeVisible();
  await expect(me.page.locator('.board .card.key-assassin')).toHaveCount(0);
  await me.page.getByLabel(/정답 보며 관전/).click();
  await expect(me.page.getByLabel(/정답 보며 관전/)).toBeChecked();
  await expect(me.page.locator('.board .card.key-assassin')).toHaveCount(1);
  await shot(me.page, 'solo-watch');
  await expect(me.page.locator('.finish')).toBeVisible({ timeout: 120_000 });
  await me.page.getByRole('button', { name: '판 보기' }).click();
  await me.page.getByRole('tab', { name: '토론' }).click();
  await expect(me.page.locator('.chat-list li').first()).toContainText('‘');
  await shot(me.page, 'solo-watch-chat');
  await me.context.close();
});

test('혼자서 플레이 (스파이마스터): 내가 준 힌트를 봇 추측자가 풀어 카드를 고른다', async ({ browser }) => {
  const me = await newPlayer(browser, '지휘');
  await openSolo(me, { role: '스파이마스터 (봇이 추측)' });
  const form = me.page.getByLabel('힌트 단어');
  await expect(form).toBeVisible({ timeout: 30_000 });
  // 내 팀 요원 중 첫 카드와 연결되는 힌트 대신, 사전에 흔한 말 ‘동물’을 준다 (결과가 무엇이든 봇은 최소 한 장 고른다)
  const before = await me.page.locator('.board .card.revealed').count();
  await form.fill('동물');
  await me.page.getByLabel('숫자').selectOption('1');
  await me.page.getByRole('button', { name: '제출…' }).click();
  await me.page.getByRole('dialog').getByRole('button', { name: '제출' }).click();
  await expect.poll(async () => me.page.locator('.board .card.revealed').count(), { timeout: 20_000 }).toBeGreaterThan(before);
  await me.page.getByRole('tab', { name: '토론' }).click();
  await expect(me.page.locator('.chat-list')).toContainText('동물');
  await shot(me.page, 'solo-spymaster');
  await me.context.close();
});

test('학급: 선생님이 봇으로 채운 시뮬레이션 방을 만들고 방장 역할로 시작하면 봇끼리 끝까지 둔다', async ({ browser }) => {
  const teacher = await newPlayer(browser, '선생님');
  await createClass(teacher, '봇 시범반');
  await teacher.page.getByText(/시뮬레이션 방 만들기/).click();
  await teacher.page.getByRole('button', { name: '만들기', exact: true }).click();
  const card = teacher.page.locator('.room-card').first();
  await expect(card).toContainText('봇 4');
  await shot(teacher.page, 'class-teacher-sim');
  await card.getByRole('button', { name: '들어가서 진행' }).click();
  await expect(teacher.page.getByText('선생님 (방장 역할 · 공개 관전)')).toBeVisible();
  await teacher.page.getByLabel('봇 속도').selectOption('fast');
  await expect(teacher.page.getByText('모두 준비되었습니다.')).toBeVisible();
  await shot(teacher.page, 'class-sim-lobby');
  await teacher.page.getByRole('button', { name: '게임 시작' }).click();
  await expect(teacher.page.locator('.board .card')).toHaveCount(25);
  await dismissBriefing(teacher);
  await teacher.page.getByLabel(/정답 보며 관전/).click();
  await expect(teacher.page.getByLabel(/정답 보며 관전/)).toBeChecked();
  await expect(teacher.page.locator('.board .card.key-assassin')).toHaveCount(1);
  await expect(teacher.page.locator('.finish')).toBeVisible({ timeout: 120_000 });
  await shot(teacher.page, 'class-sim-finish');
  await teacher.page.getByRole('button', { name: /대기실로/ }).click();
  await expect(teacher.page.getByRole('button', { name: '게임 시작' })).toBeVisible();
  await teacher.context.close();
});

test('학급: 방장 학생이 모자란 자리를 봇으로 채워 게임을 시작한다', async ({ browser }) => {
  const teacher = await newPlayer(browser, '선생님');
  const link = await createClass(teacher, '봇 채우기반');
  const host = await newPlayer(browser, '방장이');
  await host.page.goto(link);
  await host.page.getByLabel('닉네임 (친구들에게 보이는 이름)').fill(host.name);
  await host.page.getByRole('button', { name: '입장', exact: true }).click();
  await teacher.page.getByRole('row', { name: /방장이/ }).getByRole('button', { name: '방장 지정' }).click();
  await host.page.getByLabel('방 이름').fill('봇모둠');
  await host.page.getByLabel('정원').selectOption('4');
  await host.page.getByRole('button', { name: '만들기', exact: true }).click();
  await host.page.getByLabel('봇모둠 봇 수').selectOption('3');
  await host.page.getByRole('button', { name: '🤖 넣기' }).click();
  await expect(host.page.locator('.host-panel')).toContainText('4/4명');
  await shot(host.page, 'class-host-bots');
  await host.page.getByRole('button', { name: '내 방 입장' }).click();
  // 봇은 빈 역할부터 앉아 있다. 팀을 고르게 나눈 뒤 사람만 준비를 누른다 (봇은 늘 준비)
  await expect(host.page.locator('.badge-bot')).toHaveCount(3);
  await host.page.getByRole('button', { name: '팀 고르게 나누기' }).click();
  await host.page.getByRole('button', { name: '준비 완료', exact: true }).click();
  await expect(host.page.getByText('모두 준비되었습니다.')).toBeVisible();
  await host.page.getByLabel('봇 속도').selectOption('fast');
  await host.page.getByRole('button', { name: '게임 시작' }).click();
  await expect(host.page.locator('.board .card')).toHaveCount(25);
  await dismissBriefing(host);
  // 선생님 대시보드: 게임 중
  await expect(teacher.page.locator('.room-card').first()).toContainText('게임 중');
  await host.context.close();
  await teacher.context.close();
});
