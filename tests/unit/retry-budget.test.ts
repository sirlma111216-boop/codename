// 재시도 예산: 실패가 계속돼도 alarm·RPC 가 짧은 간격으로 끝없이 되풀이되지 않는다.
// (Cloudflare 무료 플랜은 Durable Object 요청이 하루 10만 건이다. 3초 간격 무한 재시도 하나가 하루 5만 건 이상을 쓴다.)
import { describe, expect, it } from 'vitest';
import { applyClassCommand, createClass, deferLockCheck, joinClass, lockForStart, markSynced, markSyncFailed, nextWakeAt, unconfirmedLocks, type ClassEnv } from '../../src/server/class-logic.ts';
import { classRetryDelayMs } from '../../src/server/room-logic.ts';

let n = 0;
const env = (now = 1000): ClassEnv => ({ now, newId: (b) => `id${++n}`.padEnd(Math.min(b, 22), 'x'), maxCapacity: 60, maxRooms: 15, ttlHours: 24 });
const DAY = 24 * 3600_000;

function classWithRoom() {
  const c = createClass('c1', 'teacher-hash', 'rk', '반', 40, env());
  const j = joinClass(c, 's-1', true, '학생', env());
  if (!j.ok) throw new Error(j.code);
  applyClassCommand(c, { kind: 'teacher', sessionHash: 'teacher-hash' }, { type: 'designateHost', memberId: j.memberId }, env());
  const r = applyClassCommand(c, { kind: 'student', memberId: j.memberId }, { type: 'createRoom', name: '방', capacity: 4, bots: { count: 3, level: 'normal' } }, env());
  if (!r.ok) throw new Error(r.code);
  return { c, roomId: r.effects.roomId as string };
}

/** 하루 동안 실패만 계속될 때 몇 번 시도하는지 */
function attemptsPerDay(delay: (attempt: number) => number): number {
  let t = 0;
  let k = 0;
  while (t < DAY) {
    k++;
    t += delay(k);
  }
  return k;
}

describe('재시도 간격', () => {
  it('방 → 클래스 알림: 3초에서 두 배씩, 최대 5분 — 하루 내내 실패해도 300번 남짓', () => {
    expect(classRetryDelayMs(1)).toBe(3000);
    expect(classRetryDelayMs(2)).toBe(6000);
    expect(classRetryDelayMs(20)).toBe(300_000);
    expect(attemptsPerDay(classRetryDelayMs)).toBeLessThan(300);
  });

  it('클래스 → 방 명단 반영: 실패가 계속되면 최대 5분 간격', () => {
    const { c, roomId } = classWithRoom();
    let now = 1000;
    for (let i = 0; i < 30; i++) {
      markSyncFailed(c, roomId, now);
      now = c.rooms[roomId]!.nextSyncAt;
    }
    markSyncFailed(c, roomId, 0);
    expect(c.rooms[roomId]!.nextSyncAt).toBe(300_000);
  });

  it('확인이 없는 시작 잠금: 방에 묻지 못하면 다음 확인을 늦추고, alarm 은 1초보다 자주 오지 않는다', () => {
    const { c, roomId } = classWithRoom();
    markSynced(c, roomId, c.rooms[roomId]!.syncVersion);
    expect(lockForStart(c, roomId, c.rooms[roomId]!.syncVersion, 'op-1', 0).ok).toBe(true);
    // 20초가 지나 확인 대상이 됐고, 묻다가 실패했다
    const now = 25_000;
    expect(unconfirmedLocks(c, now)).toEqual([roomId]);
    deferLockCheck(c, roomId, now);
    expect(unconfirmedLocks(c, now + 1000)).toEqual([]);
    // 예전에는 여기서 0.5초마다 깨어났다
    expect(nextWakeAt(c, now + 1000, DAY)).toBeGreaterThanOrEqual(now + 20_000);
    for (let i = 0; i < 10; i++) deferLockCheck(c, roomId, now);
    expect(c.rooms[roomId]!.lock!.checkAt).toBe(now + 300_000);
    expect(nextWakeAt(c, now, DAY)).toBeGreaterThanOrEqual(now + 1000);
  });

  it('정리 실패 뒤에는 정리 재시도 시각까지 깨지 않는다', () => {
    const { c, roomId } = classWithRoom();
    markSynced(c, roomId, c.rooms[roomId]!.syncVersion);
    c.cleanup = ['room-x'];
    c.cleanupRetryAt = 100_000;
    expect(nextWakeAt(c, 10_000, DAY)).toBe(100_000);
  });
});
