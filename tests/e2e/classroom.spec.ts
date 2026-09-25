// 학급 모드 실제 화면 흐름 (독립 browser context: 교사 1 + 학생 5)
// 교사 클래스 생성 → 학생 입장 → 방장 지정 → 방장 방 생성 → 참가 신청 → 승인 → 방 입장 →
// 팀·역할·준비 → 시작(명단 잠금) → 교사 공개 관전·공지 → 지각생 차단 → 수업 종료(승패 없음)
import { expect, test } from '@playwright/test';
import { assertNoSecrets, dismissBriefing, newPlayer, readKey, type Player } from './helpers.ts';

async function createClass(t: Player, name: string): Promise<string> {
  await t.page.goto('/');
  await t.page.getByRole('button', { name: '수업 만들기 (선생님)' }).click();
  await t.page.getByLabel('클래스 이름').fill(name);
  await t.page.getByRole('button', { name: '수업 만들기', exact: true }).click();
  await expect(t.page.getByRole('heading', { name })).toBeVisible();
  await expect(t.page.getByText('교사 복구 키 — 지금 적어 두세요')).toBeVisible();
  await t.page.getByRole('button', { name: 'QR 크게 보기' }).click();
  const link = (await t.page.locator('.invite-text').textContent()) ?? '';
  await expect(t.page.getByRole('img', { name: '수업 초대 QR 코드' })).toBeVisible();
  await t.page.getByRole('dialog').getByRole('button', { name: '닫기' }).click();
  return link;
}

async function joinClass(p: Player, link: string) {
  await p.page.goto(link);
  await p.page.getByLabel('닉네임 (친구들에게 보이는 이름)').fill(p.name);
  await p.page.getByRole('button', { name: '입장', exact: true }).click();
  await expect(p.page.getByRole('heading', { name: '내 자리' })).toBeVisible();
}

test('학급 모드: 교사·방장·학생 전체 흐름', async ({ browser }) => {
  test.setTimeout(150_000);
  const teacher = await newPlayer(browser, '선생님');
  const host = await newPlayer(browser, '가람');
  const s1 = await newPlayer(browser, '나래');
  const s2 = await newPlayer(browser, '다올');
  const s3 = await newPlayer(browser, '라온');
  const late = await newPlayer(browser, '마루');
  const students = [host, s1, s2, s3];

  const link = await createClass(teacher, '테스트반');
  expect(link).toMatch(/\/c\/join#[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]+$/);
  for (const p of students) await joinClass(p, link);
  expect(s1.page.url()).not.toContain('#');
  await expect(teacher.page.locator('.stat').first()).toContainText('4');

  // 방장이 아닌 학생에게는 방 만들기가 없다
  await expect(s1.page.getByRole('heading', { name: '게임방 만들기' })).toHaveCount(0);

  // ---- 교사가 방장 지정 → 그 학생에게만 ‘게임방 만들기’
  await teacher.page.getByRole('row', { name: new RegExp(host.name) }).getByRole('button', { name: '방장 지정' }).click();
  await expect(host.page.getByRole('heading', { name: '게임방 만들기' })).toBeVisible();
  await host.page.getByLabel('방 이름').fill('1모둠');
  await host.page.getByLabel('정원').selectOption('4');
  await host.page.getByRole('button', { name: '만들기', exact: true }).click();
  await expect(host.page.getByRole('heading', { name: /내 방 관리/ })).toBeVisible();
  await expect(host.page.getByRole('region', { name: '내 방 관리' })).toContainText('1/4명');

  // ---- 학생 참가 신청 → 방장 승인 (신청은 좌석을 차지하지 않는다)
  for (const p of [s1, s2, s3]) await p.page.getByRole('button', { name: '참가 신청' }).click();
  await expect(host.page.getByRole('heading', { name: '참가 신청 3명' })).toBeVisible();
  await expect(host.page.getByRole('region', { name: '내 방 관리' })).toContainText('1/4명');
  for (let i = 0; i < 3; i++) {
    await host.page.getByRole('button', { name: '승인' }).first().click();
    await expect(host.page.getByRole('heading', { name: `참가 신청 ${2 - i}명` })).toBeVisible();
  }
  await expect(host.page.getByRole('region', { name: '내 방 관리' })).toContainText('4/4명');
  await expect(teacher.page.locator('.room-card')).toContainText('4/4명');
  await teacher.page.screenshot({ path: 'screens/class-teacher.png', fullPage: true });
  await s1.page.screenshot({ path: 'screens/class-student.png', fullPage: true });

  // ---- 방 입장 (반영이 끝나야 ‘입장하기’가 켜진다)
  for (const p of [s1, s2, s3]) {
    await expect(p.page.getByRole('button', { name: '입장하기' })).toBeEnabled();
    await p.page.getByRole('button', { name: '입장하기' }).click();
  }
  await host.page.getByRole('button', { name: '내 방 입장' }).click();
  for (const p of students) await expect(p.page.getByRole('heading', { name: '1모둠' })).toBeVisible();

  // 준비 전에는 시작 불가, 시작 조건을 알려 준다
  await expect(host.page.getByRole('button', { name: '게임 시작' })).toBeDisabled();
  await expect(host.page.getByText(/팀·역할을 고르지 않은 사람/)).toBeVisible();

  const plan: [Player, string][] = [
    [host, '◆ 스파이마스터'],
    [s1, '◆ 추측자'],
    [s2, '● 스파이마스터'],
    [s3, '● 추측자'],
  ];
  for (const [p, seat] of plan) {
    await p.page.getByRole('button', { name: seat, exact: true }).click();
    await p.page.getByRole('button', { name: '준비 완료', exact: true }).click();
    await expect(p.page.getByRole('button', { name: /✓ 준비 완료/ })).toBeVisible();
  }
  await expect(host.page.getByText('모두 준비되었습니다.')).toBeVisible();
  await host.page.screenshot({ path: 'screens/class-room-lobby.png', fullPage: true });
  await host.page.getByRole('button', { name: '게임 시작' }).click();
  for (const p of students) {
    await expect(p.page.locator('.board .card')).toHaveCount(25);
    await dismissBriefing(p);
  }
  // 방장이 자동으로 스파이마스터가 된 것이 아니라, 고른 역할의 정보만 받는다
  expect(Object.keys(await readKey(host))).toHaveLength(25);
  await expect(s1.page.locator('.board .card[class*="key-"]')).toHaveCount(0);
  assertNoSecrets(s1);
  assertNoSecrets(s3);

  // ---- 교사: 클래스 요약에 게임 중 표시, 공개 관전은 정답 없이
  await expect(teacher.page.locator('.room-card')).toContainText('게임 중');
  await expect(teacher.page.locator('.room-card .room-summary')).toContainText('남은 요원');
  assertNoSecrets(teacher);
  const spectator = await teacher.context.newPage();
  const spectatorFrames: string[] = [];
  spectator.on('websocket', (ws) => ws.on('framereceived', (f) => typeof f.payload === 'string' && spectatorFrames.push(f.payload)));
  const roomUrl = s1.page.url();
  await spectator.goto(roomUrl);
  await expect(spectator.locator('.board .card')).toHaveCount(25);
  await expect(spectator.locator('.board .card[class*="key-"]')).toHaveCount(0);
  await expect(spectator.getByText('선생님 (공개 관전)', { exact: true })).toBeVisible();
  assertNoSecrets({ name: '교사 관전', frames: spectatorFrames } as Player);
  await spectator.screenshot({ path: 'screens/class-spectate.png' });

  // ---- 게임 중에도 교사 공지를 받는다
  await teacher.page.getByLabel('공지 내용').fill('5분 뒤에 정리합니다');
  await teacher.page.getByRole('button', { name: '보내기', exact: true }).click();
  await expect(s1.page.locator('.class-feed')).toContainText('5분 뒤에 정리합니다');

  // ---- 지각생: 진행 중인 방에는 신청할 수 없다 (명단 잠금)
  await joinClass(late, link);
  await expect(late.page.getByRole('button', { name: '게임 중' })).toBeDisabled();

  // ---- 수업 종료: 진행 중 게임은 승패 없이 중단, 학생 연결 종료
  await teacher.page.getByRole('button', { name: '수업 종료' }).click();
  await teacher.page.getByRole('dialog').getByRole('button', { name: '수업 종료' }).click();
  await expect(teacher.page.getByRole('heading', { name: '수업이 끝났습니다' })).toBeVisible();
  await expect(teacher.page.locator('.room-card .room-summary')).toContainText('수업 종료로 중단');
  await expect(late.page.getByText('수업이 끝났습니다. 수고했어요!')).toBeVisible();
  await expect(s1.page.getByText(/게임방이 닫혔습니다|수업이 끝났습니다/)).toBeVisible({ timeout: 15_000 });
  await teacher.page.screenshot({ path: 'screens/class-ended.png', fullPage: true });

  for (const p of [teacher, ...students, late]) await p.context.close();
});
