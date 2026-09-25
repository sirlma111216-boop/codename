import { expect } from '@playwright/test';
import type { Player } from './helpers.ts';

export async function createClass(t: Player, name: string): Promise<string> {
  await t.page.goto('/');
  await t.page.getByRole('button', { name: '수업 만들기 (선생님)' }).click();
  await t.page.getByLabel('클래스 이름').fill(name);
  await t.page.getByRole('button', { name: '수업 만들기', exact: true }).click();
  await expect(t.page.getByRole('heading', { name })).toBeVisible();
  await t.page.getByRole('button', { name: 'QR 크게 보기' }).click();
  const link = (await t.page.locator('.invite-text').textContent()) ?? '';
  await t.page.getByRole('dialog').getByRole('button', { name: '닫기' }).click();
  return link;
}

export async function joinClass(p: Player, link: string) {
  await p.page.goto(link);
  await p.page.getByLabel('닉네임 (친구들에게 보이는 이름)').fill(p.name);
  await p.page.getByRole('button', { name: '입장', exact: true }).click();
  await expect(p.page.getByRole('heading', { name: '내 자리' })).toBeVisible();
}

/** 방장 지정 → 4인 방 → 신청·승인 → 입장 → 팀·준비 → 시작 */
export async function fourPlayerRoom(teacher: Player, host: Player, others: Player[], roomName: string) {
  await teacher.page.getByRole('row', { name: new RegExp(host.name) }).getByRole('button', { name: '방장 지정' }).click();
  await host.page.getByLabel('방 이름').fill(roomName);
  await host.page.getByLabel('정원').selectOption('4');
  await host.page.getByRole('button', { name: '만들기', exact: true }).click();
  for (const p of others) await p.page.getByRole('button', { name: '참가 신청' }).click();
  await expect(host.page.getByRole('heading', { name: `참가 신청 ${others.length}명` })).toBeVisible();
  for (let i = 0; i < others.length; i++) {
    await host.page.getByRole('button', { name: '승인' }).first().click();
    await expect(host.page.getByRole('heading', { name: `참가 신청 ${others.length - 1 - i}명` })).toBeVisible();
  }
  for (const p of others) await p.page.getByRole('button', { name: '입장하기' }).click();
  await host.page.getByRole('button', { name: '내 방 입장' }).click();
  const seats = ['◆ 스파이마스터', '◆ 추측자', '● 스파이마스터', '● 추측자'];
  for (const [i, p] of [host, ...others].entries()) {
    await p.page.getByRole('button', { name: seats[i] as string, exact: true }).click();
    await p.page.getByRole('button', { name: '준비 완료', exact: true }).click();
  }
  await expect(host.page.getByText('모두 준비되었습니다.')).toBeVisible();
  await host.page.getByRole('button', { name: '게임 시작' }).click();
}
