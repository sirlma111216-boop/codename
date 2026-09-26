// 게임방 초대 QR: 대기실에 QR 이 보이고, 크게 보기의 링크가 초대 링크와 같으며, 그 링크로 휴대폰 참가자가 들어온다.
import { expect, test } from '@playwright/test';
import { createRoom, joinRoom, newPlayer } from './helpers.ts';

test('게임방 초대 QR 로 휴대폰 참가자가 들어온다', async ({ browser }) => {
  const host = await newPlayer(browser, 'QR방장');
  const link = await createRoom(host);
  await expect(host.page.getByRole('img', { name: '게임방 초대 QR 코드' })).toBeVisible();
  await host.page.getByRole('button', { name: 'QR 크게 보기' }).click();
  const dlg = host.page.getByRole('dialog', { name: '게임방 초대' });
  await expect(dlg.getByRole('img', { name: '게임방 초대 QR 코드' })).toBeVisible();
  await expect(dlg.locator('.invite-text')).toHaveText(link);
  await host.page.screenshot({ path: 'test-results/invite-qr.png' });
  await dlg.getByRole('button', { name: '닫기' }).click();

  // QR 을 찍으면 이 링크가 열린다
  const guest = await newPlayer(browser, 'QR손님', { width: 390, height: 844 });
  await joinRoom(guest, link);
  await expect(host.page.getByText('QR손님').first()).toBeVisible();
  await host.context.close();
  await guest.context.close();
});
