// 학급 모드: 클래스 객체의 배정·권한·경쟁·잠금·반영 기록 (addendum §2~§6, §8)
import { describe, expect, it } from 'vitest';
import type { ClassCommand } from '../../src/shared/class-protocol.ts';
import {
  applyClassCommand,
  applyReport,
  buildSync,
  cancelStart,
  classStatus,
  confirmStart,
  createClass,
  joinClass,
  layoutSuggestions,
  lockForStart,
  markSynced,
  markSyncFailed,
  pendingSyncs,
  projectClass,
  reconcileLock,
  releaseRoster,
  unconfirmedLocks,
  type Actor,
  type ClassEnv,
  type ClassState,
} from '../../src/server/class-logic.ts';

let n = 0;
const env = (now = 1000, over: Partial<ClassEnv> = {}): ClassEnv => ({ now, newId: (b) => `id${++n}`.padEnd(Math.min(b, 22), 'x'), maxCapacity: 60, maxRooms: 15, ttlHours: 24, ...over });
const T: Actor = { kind: 'teacher', sessionHash: 'teacher-hash' };
const S = (memberId: string): Actor => ({ kind: 'student', memberId });

function newClass(students: number, capacity = 40) {
  const c = createClass('class1', 'teacher-hash', 'rk', '3학년 2반', capacity, env());
  const ids: string[] = [];
  for (let i = 0; i < students; i++) {
    const r = joinClass(c, `s-${i}`, true, `학생${i}`, env());
    if (!r.ok) throw new Error(r.code);
    ids.push(r.memberId);
  }
  return { c, ids };
}

function run(c: ClassState, a: Actor, cmd: ClassCommand, e = env()) {
  return applyClassCommand(c, a, cmd, e);
}
function ok(c: ClassState, a: Actor, cmd: ClassCommand) {
  const r = run(c, a, cmd);
  if (!r.ok) throw new Error(`${cmd.type}: ${r.code} ${r.message}`);
  return r.effects;
}
function code(c: ClassState, a: Actor, cmd: ClassCommand) {
  const r = run(c, a, cmd);
  if (r.ok) throw new Error(`expected rejection: ${cmd.type}`);
  return r.code;
}
/** 방장 지정 → 방 만들기 → 방 id */
function hostRoom(c: ClassState, hostId: string, capacity = 6): string {
  ok(c, T, { type: 'designateHost', memberId: hostId });
  const eff = ok(c, S(hostId), { type: 'createRoom', name: '방', capacity });
  return eff.roomId as string;
}
function syncAll(c: ClassState) {
  for (const r of Object.values(c.rooms)) markSynced(c, r.id, r.syncVersion);
}
function fill(c: ClassState, roomId: string, students: string[]) {
  const r = c.rooms[roomId]!;
  for (const s of students) {
    ok(c, S(s), { type: 'requestJoin', roomId });
    ok(c, S(r.hostMemberId!), { type: 'approve', roomId, memberId: s, expectedRosterVersion: r.syncVersion });
  }
}

describe('클래스 입장과 정원', () => {
  it('기본 정원 40명, 설정 상한 60명, 초과 입장은 거절', () => {
    const { c } = newClass(40);
    expect(joinClass(c, 's-extra', true, '늦은학생', env())).toEqual({ ok: false, code: 'full' });
    expect(code(c, T, { type: 'setSettings', capacity: 61 })).toBe('badCapacity');
    ok(c, T, { type: 'setSettings', capacity: 60 });
    for (let i = 0; i < 20; i++) expect(joinClass(c, `late-${i}`, true, `추가${i}`, env()).ok).toBe(true);
    expect(joinClass(c, 's-61', true, '61번째', env())).toEqual({ ok: false, code: 'full' });
    expect(Object.keys(c.members)).toHaveLength(60);
  });

  it('틀린 초대·잠금·강퇴·교사 세션은 학생으로 들어올 수 없다', () => {
    const { c, ids } = newClass(2);
    expect(joinClass(c, 'x', false, 'x', env())).toEqual({ ok: false, code: 'badInvite' });
    ok(c, T, { type: 'lockJoin', locked: true });
    expect(joinClass(c, 'y', true, 'y', env())).toEqual({ ok: false, code: 'locked' });
    ok(c, T, { type: 'kickMember', memberId: ids[0]! });
    expect(joinClass(c, 's-0', true, '다시', env())).toEqual({ ok: false, code: 'banned' });
    expect(joinClass(c, 'teacher-hash', true, '선생님', env())).toEqual({ ok: false, code: 'teacher' });
    expect(classStatus(c, 'teacher-hash')).toBe('teacher');
    expect(classStatus(c, 's-1')).toBe('member');
    expect(classStatus(c, 'other')).toBe('notMember');
  });
});

describe('방장 지정과 방 만들기', () => {
  it('지정되지 않은 학생은 방을 만들 수 없고, 지정된 학생은 한 방만 만든다 (방장도 좌석 1개)', () => {
    const { c, ids } = newClass(8);
    expect(code(c, S(ids[0]!), { type: 'createRoom', name: 'x', capacity: 6 })).toBe('notDesignated');
    const room = hostRoom(c, ids[0]!);
    expect(c.rooms[room]?.seats).toEqual([ids[0]]);
    expect(c.members[ids[0]!]?.assignment).toBe(room);
    expect(code(c, S(ids[0]!), { type: 'createRoom', name: 'y', capacity: 6 })).toBe('alreadyOwns');
    // 선생님은 학생 방장 없이 방을 만들 수 있다 (시뮬레이션 방). 선생님은 좌석을 쓰지 않는다
    const t = ok(c, T, { type: 'createRoom', name: 't', capacity: 6 }).roomId!;
    expect(c.rooms[t]?.hostMemberId).toBeNull();
    expect(c.rooms[t]?.seats).toEqual([]);
  });

  it('정원은 교사가 허용한 범위(기본 4~8) 안에서만', () => {
    const { c, ids } = newClass(3);
    ok(c, T, { type: 'designateHost', memberId: ids[0]! });
    ok(c, T, { type: 'setSettings', roomCapMin: 5, roomCapMax: 7, roomCapDefault: 6 });
    expect(code(c, S(ids[0]!), { type: 'createRoom', name: 'x', capacity: 4 })).toBe('badCapacity');
    expect(code(c, S(ids[0]!), { type: 'createRoom', name: 'x', capacity: 8 })).toBe('badCapacity');
    expect(run(c, S(ids[0]!), { type: 'createRoom', name: 'x', capacity: 7 }).ok).toBe(true);
  });

  it('방장 지정 해제: 방은 지우지 않고 관리권만 거둔다. 해제된 방장의 명령은 거절된다', () => {
    const { c, ids } = newClass(4);
    const room = hostRoom(c, ids[0]!);
    ok(c, S(ids[1]!), { type: 'requestJoin', roomId: room });
    ok(c, T, { type: 'revokeHost', memberId: ids[0]! });
    expect(c.rooms[room]?.status).toBe('waiting');
    expect(c.rooms[room]?.hostMemberId).toBeNull();
    expect(code(c, S(ids[0]!), { type: 'approve', roomId: room, memberId: ids[1]!, expectedRosterVersion: c.rooms[room]!.syncVersion })).toBe('forbidden');
    ok(c, T, { type: 'closeRoom', roomId: room }); // 다른 방은 영향 없음
    expect(code(c, S(ids[0]!), { type: 'createRoom', name: 'x', capacity: 6 })).toBe('notDesignated');
  });

  it('교사가 같은 방 참가자에게 관리권을 넘기면 옛 방장의 승인은 거절된다', () => {
    const { c, ids } = newClass(5);
    const room = hostRoom(c, ids[0]!);
    fill(c, room, [ids[1]!]);
    ok(c, S(ids[2]!), { type: 'requestJoin', roomId: room });
    ok(c, T, { type: 'setRoomHost', roomId: room, memberId: ids[1]! });
    const v = c.rooms[room]!.syncVersion;
    expect(code(c, S(ids[0]!), { type: 'approve', roomId: room, memberId: ids[2]!, expectedRosterVersion: v })).toBe('forbidden');
    expect(run(c, S(ids[1]!), { type: 'approve', roomId: room, memberId: ids[2]!, expectedRosterVersion: v }).ok).toBe(true);
    expect(code(c, T, { type: 'setRoomHost', roomId: room, memberId: ids[3]! })).toBe('notSeated');
  });
});

describe('참가 신청·승인 (좌석은 승인 뒤에만 확정)', () => {
  it('신청은 좌석을 차지하지 않고, 한 방에만 유지된다 (새 신청이 이전 신청을 취소)', () => {
    const { c, ids } = newClass(6);
    const a = hostRoom(c, ids[0]!);
    const b = hostRoom(c, ids[1]!);
    ok(c, S(ids[2]!), { type: 'requestJoin', roomId: a });
    expect(c.rooms[a]?.seats).toHaveLength(1);
    ok(c, S(ids[2]!), { type: 'requestJoin', roomId: b });
    expect(c.members[ids[2]!]?.request?.roomId).toBe(b);
    // 앞 방의 방장은 더 이상 이 학생을 승인할 수 없다
    expect(code(c, S(ids[0]!), { type: 'approve', roomId: a, memberId: ids[2]!, expectedRosterVersion: c.rooms[a]!.syncVersion })).toBe('noRequest');
  });

  it('다른 방의 방장은 승인할 수 없다', () => {
    const { c, ids } = newClass(5);
    const a = hostRoom(c, ids[0]!);
    const b = hostRoom(c, ids[1]!);
    ok(c, S(ids[2]!), { type: 'requestJoin', roomId: a });
    expect(code(c, S(ids[1]!), { type: 'approve', roomId: a, memberId: ids[2]!, expectedRosterVersion: c.rooms[a]!.syncVersion })).toBe('forbidden');
    expect(code(c, S(ids[1]!), { type: 'approve', roomId: b, memberId: ids[2]!, expectedRosterVersion: c.rooms[b]!.syncVersion })).toBe('noRequest');
  });

  it('마지막 한 자리 동시 승인: 같은 명단 버전으로 온 두 번째 승인은 거절 → 중복 배정 없음', () => {
    const { c, ids } = newClass(8);
    const room = hostRoom(c, ids[0]!, 4);
    fill(c, room, [ids[1]!, ids[2]!]);
    ok(c, S(ids[3]!), { type: 'requestJoin', roomId: room });
    ok(c, S(ids[4]!), { type: 'requestJoin', roomId: room });
    const v = c.rooms[room]!.syncVersion;
    const r1 = run(c, S(ids[0]!), { type: 'approve', roomId: room, memberId: ids[3]!, expectedRosterVersion: v });
    const r2 = run(c, S(ids[0]!), { type: 'approve', roomId: room, memberId: ids[4]!, expectedRosterVersion: v });
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(false);
    expect(c.rooms[room]?.seats).toHaveLength(4);
    // 정원이 차면 남은 신청은 정리되고 신청자에게 알린다
    expect(c.members[ids[4]!]?.request).toBeNull();
    expect(c.members[ids[4]!]?.notice?.kind).toBe('roomFull');
    expect(code(c, S(ids[5]!), { type: 'requestJoin', roomId: room })).toBe('roomFull');
  });

  it('취소와 승인의 경쟁: 먼저 취소하면 승인 불가, 먼저 승인되면 취소할 신청이 없다', () => {
    const { c, ids } = newClass(4);
    const room = hostRoom(c, ids[0]!);
    ok(c, S(ids[1]!), { type: 'requestJoin', roomId: room });
    ok(c, S(ids[1]!), { type: 'cancelRequest' });
    expect(code(c, S(ids[0]!), { type: 'approve', roomId: room, memberId: ids[1]!, expectedRosterVersion: c.rooms[room]!.syncVersion })).toBe('noRequest');
    ok(c, S(ids[2]!), { type: 'requestJoin', roomId: room });
    ok(c, S(ids[0]!), { type: 'approve', roomId: room, memberId: ids[2]!, expectedRosterVersion: c.rooms[room]!.syncVersion });
    expect(code(c, S(ids[2]!), { type: 'cancelRequest' })).toBe('noRequest');
  });

  it('이미 배정된 학생은 다른 방을 신청할 수 없다 (한 학생 = 활성 방 하나)', () => {
    const { c, ids } = newClass(5);
    const a = hostRoom(c, ids[0]!);
    const b = hostRoom(c, ids[1]!);
    fill(c, a, [ids[2]!]);
    expect(code(c, S(ids[2]!), { type: 'requestJoin', roomId: b })).toBe('alreadyAssigned');
    ok(c, S(ids[2]!), { type: 'leaveRoom' });
    expect(run(c, S(ids[2]!), { type: 'requestJoin', roomId: b }).ok).toBe(true);
  });

  it('정원 변경: 현재 인원보다 작게 줄일 수 없다 (승인된 학생을 자동 퇴장시키지 않음)', () => {
    const { c, ids } = newClass(6);
    const room = hostRoom(c, ids[0]!, 6);
    fill(c, room, [ids[1]!, ids[2]!, ids[3]!, ids[4]!]);
    expect(code(c, S(ids[0]!), { type: 'setRoomCapacity', roomId: room, capacity: 4, expectedRosterVersion: c.rooms[room]!.syncVersion })).toBe('belowSeats');
    const v = c.rooms[room]!.syncVersion;
    ok(c, S(ids[0]!), { type: 'setRoomCapacity', roomId: room, capacity: 5, expectedRosterVersion: v });
    expect(c.rooms[room]!.syncVersion).toBeGreaterThan(v); // 방에 반영(준비 초기화)
  });

  it('교사의 대기 중 이동은 두 방의 좌석을 함께 바꾸고 두 방 모두 다시 반영한다', () => {
    const { c, ids } = newClass(6);
    const a = hostRoom(c, ids[0]!);
    const b = hostRoom(c, ids[1]!);
    fill(c, a, [ids[2]!]);
    const va = c.rooms[a]!.syncVersion;
    const vb = c.rooms[b]!.syncVersion;
    const eff = ok(c, T, { type: 'moveStudent', memberId: ids[2]!, toRoomId: b });
    expect(eff.syncRooms.sort()).toEqual([a, b].sort());
    expect(c.rooms[a]!.seats).not.toContain(ids[2]);
    expect(c.rooms[b]!.seats).toContain(ids[2]);
    expect(c.rooms[a]!.syncVersion).toBe(va + 1);
    expect(c.rooms[b]!.syncVersion).toBe(vb + 1);
    expect(code(c, T, { type: 'moveStudent', memberId: ids[0]!, toRoomId: b })).toBe('isHost');
  });
});

describe('게임 시작 잠금 (승인과 시작의 경쟁)', () => {
  function readyRoom() {
    const { c, ids } = newClass(8);
    const room = hostRoom(c, ids[0]!, 4);
    fill(c, room, [ids[1]!, ids[2]!, ids[3]!]);
    syncAll(c);
    return { c, ids, room };
  }

  it('반영이 끝난 최신 명단 버전일 때만 잠그고, 잠긴 뒤에는 승인·이동·신청이 모두 거절된다', () => {
    const { c, ids, room } = readyRoom();
    const r = c.rooms[room]!;
    expect(lockForStart(c, room, r.syncVersion - 1, 'op1', 1).ok).toBe(false); // 오래된 명단
    expect(lockForStart(c, room, r.syncVersion, 'op1', 1).ok).toBe(true);
    expect(lockForStart(c, room, r.syncVersion, 'op1', 1).ok).toBe(true); // 재전송은 멱등
    expect(lockForStart(c, room, r.syncVersion, 'op2', 1).ok).toBe(false);
    expect(code(c, S(ids[4]!), { type: 'requestJoin', roomId: room })).toBe('roomLocked');
    expect(code(c, T, { type: 'moveStudent', memberId: ids[1]!, toRoomId: null })).toBe('roomLocked');
    expect(code(c, S(ids[1]!), { type: 'leaveRoom' })).toBe('roomLocked');
  });

  it('반영이 덜 된 명단으로는 잠글 수 없다', () => {
    const { c, ids } = newClass(6);
    const room = hostRoom(c, ids[0]!, 4);
    fill(c, room, [ids[1]!, ids[2]!, ids[3]!]);
    expect(lockForStart(c, room, c.rooms[room]!.syncVersion, 'op', 1)).toMatchObject({ ok: false, code: 'staleRoster' });
  });

  it('정원이 차지 않으면 잠글 수 없다', () => {
    const { c, ids } = newClass(6);
    const room = hostRoom(c, ids[0]!, 4);
    fill(c, room, [ids[1]!]);
    syncAll(c);
    expect(lockForStart(c, room, c.rooms[room]!.syncVersion, 'op', 1)).toMatchObject({ ok: false, code: 'notFull' });
  });

  it('시작 실패는 잠금을 풀고, 확정된 게임은 끝난 뒤 대기실로 돌아와야 풀린다', () => {
    const { c, room } = readyRoom();
    const v = c.rooms[room]!.syncVersion;
    lockForStart(c, room, v, 'op1', 1);
    expect(cancelStart(c, room, 'op1')).toBe(true);
    expect(c.rooms[room]!.status).toBe('waiting');
    lockForStart(c, room, v, 'op2', 1);
    confirmStart(c, room, 'op2', 'game-1');
    expect(cancelStart(c, room, 'op2')).toBe(false); // 확정된 게임은 취소로 풀지 않는다
    applyReport(c, { roomId: room, syncVersion: v, readyCount: 4, onlineCount: 4, summary: { phase: 'finished', gameId: 'game-1', turnTeam: null, remaining: { red: 0, blue: 3 }, clueCount: 5, winner: 'red', endReason: 'allAgentsFound' } }, 2);
    expect(c.rooms[room]!.status).toBe('finished');
    expect(releaseRoster(c, room, 'other-game')).toBe(false);
    expect(releaseRoster(c, room, 'game-1')).toBe(true);
    expect(c.rooms[room]!.status).toBe('waiting');
  });

  it('잠금 뒤 방의 확인이 없으면 방 상태를 물어 맞춘다 (게임 없으면 해제, 있으면 확정)', () => {
    const { c, room } = readyRoom();
    lockForStart(c, room, c.rooms[room]!.syncVersion, 'op', 1000);
    expect(unconfirmedLocks(c, 5000)).toEqual([]);
    expect(unconfirmedLocks(c, 30_000)).toEqual([room]);
    reconcileLock(c, room, { gameId: null, phase: 'lobby' });
    expect(c.rooms[room]!.status).toBe('waiting');
    lockForStart(c, room, c.rooms[room]!.syncVersion, 'op-b', 1000);
    reconcileLock(c, room, { gameId: 'g', phase: 'playing' });
    expect(c.rooms[room]!.lock?.gameId).toBe('g');
    expect(c.rooms[room]!.status).toBe('playing');
  });
});

describe('클래스 → 방 반영 기록 (실패·재전송·순서 바뀜)', () => {
  it('승인 뒤 반영 전에는 ‘입장 준비 중’, 실패하면 좌석을 유지한 채 재시도 예약', () => {
    const { c, ids } = newClass(4);
    const room = hostRoom(c, ids[0]!);
    syncAll(c);
    fill(c, room, [ids[1]!]);
    const view = projectClass(c, S(ids[1]!), new Set(), env());
    expect(view.you.assignment).toEqual({ roomId: room, synced: false });
    expect(pendingSyncs(c, 0)).toEqual([room]);
    markSyncFailed(c, room, 1000);
    expect(c.rooms[room]!.seats).toContain(ids[1]); // 불확실한 예약을 풀어 다른 학생에게 주지 않는다
    expect(pendingSyncs(c, 1500)).toEqual([]);
    expect(pendingSyncs(c, 5000)).toEqual([room]);
    markSynced(c, room, c.rooms[room]!.syncVersion);
    expect(projectClass(c, S(ids[1]!), new Set(), env()).you.assignment).toEqual({ roomId: room, synced: true });
  });

  it('늦게 도착한 옛 버전의 확인은 새 버전의 확인을 되돌리지 않는다', () => {
    const { c, ids } = newClass(4);
    const room = hostRoom(c, ids[0]!);
    fill(c, room, [ids[1]!, ids[2]!]);
    const latest = c.rooms[room]!.syncVersion;
    expect(markSynced(c, room, latest)).toBe(true);
    expect(markSynced(c, room, latest - 1)).toBe(false);
    expect(c.rooms[room]!.syncedVersion).toBe(latest);
  });

  it('반영 내용은 전체 명단 + 버전 + 교사 세션 (방이 스스로 좌석을 더하지 않게)', () => {
    const { c, ids } = newClass(3);
    const room = hostRoom(c, ids[0]!);
    fill(c, room, [ids[1]!]);
    const p = buildSync(c, room)!;
    expect(p.members.map((m) => m.memberId)).toEqual([ids[0], ids[1]]);
    expect(p.hostMemberId).toBe(ids[0]);
    expect(p.teacherHashes).toEqual(['teacher-hash']);
    expect(p.syncVersion).toBe(c.rooms[room]!.syncVersion);
  });
});

describe('수업 종료·정리', () => {
  it('진행 중 게임은 ‘수업 종료로 중단’(승패 없음)으로 기록하고, 모든 방을 닫고 정리 목록에 올린다', () => {
    const { c, ids } = newClass(8);
    const room = hostRoom(c, ids[0]!, 4);
    fill(c, room, [ids[1]!, ids[2]!, ids[3]!]);
    syncAll(c);
    lockForStart(c, room, c.rooms[room]!.syncVersion, 'op', 1);
    confirmStart(c, room, 'op', 'g1');
    const waiting = hostRoom(c, ids[4]!, 4);
    const eff = ok(c, T, { type: 'endClass' });
    expect(eff.ended).toBe(true);
    expect(eff.syncRooms.sort()).toEqual([room, waiting].sort());
    expect(c.rooms[room]!.status).toBe('closed');
    expect(c.rooms[room]!.report?.summary).toMatchObject({ endReason: 'classEnded', winner: null });
    expect(c.cleanup.sort()).toEqual([room, waiting].sort());
    expect(buildSync(c, room)!.closed).toBe(true);
    expect(code(c, S(ids[5]!), { type: 'requestJoin', roomId: waiting })).toBe('ended');
    expect(classStatus(c, 's-1')).toBe('ended');
    expect(joinClass(c, 'new', true, 'x', env()).ok).toBe(false);
  });

  it('4인 방 15개로 60명을 모두 편성할 수 있고, 16번째 방은 한도로 거절된다', () => {
    const { c, ids } = newClass(60, 60);
    for (let r = 0; r < 15; r++) {
      const host = ids[r * 4]!;
      const room = hostRoom(c, host, 4);
      fill(c, room, [ids[r * 4 + 1]!, ids[r * 4 + 2]!, ids[r * 4 + 3]!]);
    }
    expect(Object.values(c.rooms).every((r) => r.seats.length === 4)).toBe(true);
    expect(projectClass(c, T, new Set(), env()).counts.unassigned).toBe(0);
    const extra = joinClass(c, 'x', true, 'x', env());
    expect(extra.ok).toBe(false); // 정원 60 도달
    ok(c, T, { type: 'designateHost', memberId: ids[1]! });
    ok(c, S(ids[1]!), { type: 'leaveRoom' });
    expect(code(c, S(ids[1]!), { type: 'createRoom', name: 'x', capacity: 4 })).toBe('tooManyRooms');
  });
});

describe('화면용 projection: 비밀과 다른 방 정보가 새지 않는다', () => {
  it('학생은 다른 방의 명단·신청·진행 요약을 받지 않고, 교사 요약에도 정답 정보가 없다', () => {
    const { c, ids } = newClass(6);
    const a = hostRoom(c, ids[0]!);
    const b = hostRoom(c, ids[1]!);
    fill(c, a, [ids[2]!]);
    ok(c, S(ids[3]!), { type: 'requestJoin', roomId: b });
    applyReport(c, { roomId: a, syncVersion: 1, readyCount: 1, onlineCount: 2, summary: { phase: 'playing', gameId: 'g', turnTeam: 'red', remaining: { red: 9, blue: 8 }, clueCount: 1, winner: null, endReason: null } }, 5);
    const student = projectClass(c, S(ids[2]!), new Set(), env());
    const other = student.rooms.find((r) => r.id === b)!;
    expect(other.seats).toBeUndefined();
    expect(other.requests).toBeUndefined();
    expect(student.rooms.find((r) => r.id === a)!.summary).toBeNull();
    expect(student.members).toBeUndefined();
    expect(student.inviteToken).toBeUndefined();
    const teacher = projectClass(c, T, new Set(), env());
    expect(teacher.rooms.find((r) => r.id === a)!.summary?.remaining).toEqual({ red: 9, blue: 8 });
    for (const v of [student, teacher]) expect(JSON.stringify(v)).not.toMatch(/"key"|identities|seed|keyId|sessionHash|recoveryKey|"words"/);
  });

  it('배치 안내는 운영 예시(24명 → 6명×4방, 30명 → 6명×5방, 32명 → 8명×4방)', () => {
    expect(layoutSuggestions(24)).toContain('6명 × 4방');
    expect(layoutSuggestions(30)).toContain('6명 × 5방');
    expect(layoutSuggestions(32)).toContain('8명 × 4방');
  });
});
