// 학급 모드의 봇(시뮬레이션): 방장·선생님만 봇을 넣고 빼며, 좌석 권한은 클래스가 가진다.
// 방에는 버전 붙은 명단으로 반영되고, 방에서는 사람과 같은 규칙으로 움직인다.
import { describe, expect, it } from 'vitest';
import type { ClassCommand } from '../../src/shared/class-protocol.ts';
import type { ClientMessage, Command } from '../../src/shared/protocol.ts';
import { applyClassCommand, buildSync, createClass, joinClass, lockForStart, markSynced, projectClass, type Actor, type ClassEnv, type ClassState } from '../../src/server/class-logic.ts';
import { applyClassSync, applyCommand, classStartProblems, projectRoom, roomSummary, TEACHER_ID, type RoomEnv, type RoomState } from '../../src/server/room-logic.ts';

let n = 0;
const cenv = (over: Partial<ClassEnv> = {}): ClassEnv => ({ now: 1000, newId: (b) => `id${++n}`.padEnd(Math.min(b, 22), 'x'), maxCapacity: 60, maxRooms: 15, ttlHours: 24, ...over });
const renv = (): RoomEnv => ({ now: 2000, newId: (b: number) => `r${++n}`.padEnd(Math.min(b, 12), 'x'), ttlHours: 24, hostGraceSeconds: 180 });
const T: Actor = { kind: 'teacher', sessionHash: 'teacher-hash' };
const S = (memberId: string): Actor => ({ kind: 'student', memberId });
type Cmd = Extract<ClientMessage, { t: 'cmd' }>;
const rcmd = (c: Command): Cmd => ({ t: 'cmd', commandId: `c${++n}abcdefgh`, cmd: c });

function setup(students = 3) {
  const c = createClass('class1', 'teacher-hash', 'rk', '3-2', 40, cenv());
  const ids: string[] = [];
  for (let i = 0; i < students; i++) {
    const r = joinClass(c, `s-${i}`, true, `학생${i}`, cenv());
    if (!r.ok) throw new Error(r.code);
    ids.push(r.memberId);
  }
  return { c, ids };
}
const run = (c: ClassState, a: Actor, cmd: ClassCommand) => applyClassCommand(c, a, cmd, cenv());
function ok(c: ClassState, a: Actor, cmd: ClassCommand) {
  const r = run(c, a, cmd);
  if (!r.ok) throw new Error(`${cmd.type}: ${r.code} ${r.message}`);
  return r.effects;
}
const codeOf = (c: ClassState, a: Actor, cmd: ClassCommand) => {
  const r = run(c, a, cmd);
  return r.ok ? 'ok' : r.code;
};

describe('클래스: 봇 좌석', () => {
  it('선생님은 학생 방장 없이 시뮬레이션 방을 만들고 처음부터 봇으로 채울 수 있다', () => {
    const { c } = setup(0);
    const eff = ok(c, T, { type: 'createRoom', name: '시범 게임', capacity: 4, bots: { count: 4, level: 'hard' } });
    const r = c.rooms[eff.roomId!]!;
    expect(r.hostMemberId).toBeNull();
    expect(r.seats).toHaveLength(4);
    expect(Object.values(c.bots).every((b) => b.roomId === r.id && b.level === 'hard')).toBe(true);
    // 학생 정원·미배정 수에는 들어가지 않는다
    const tv = projectClass(c, T, new Set(), cenv());
    expect(tv.counts.total).toBe(0);
    expect(tv.rooms[0]!.botCount).toBe(4);
    expect(tv.rooms[0]!.seats!.every((s) => s.bot && s.online)).toBe(true);
    const sync = buildSync(c, r.id)!;
    expect(sync.hostMemberId).toBeNull();
    expect(sync.members.every((m) => m.bot?.level === 'hard' && m.sessionHash === null)).toBe(true);
  });

  it('봇은 그 방의 방장이나 선생님만 넣고 뺀다. 빈자리보다 많이 넣을 수 없다', () => {
    const { c, ids } = setup(3);
    const [host, other] = ids as [string, string];
    ok(c, T, { type: 'designateHost', memberId: host });
    const roomId = ok(c, S(host), { type: 'createRoom', name: '1모둠', capacity: 4 }).roomId!;
    expect(codeOf(c, S(other), { type: 'addBots', roomId, count: 1, level: 'easy' })).toBe('forbidden');
    expect(codeOf(c, S(host), { type: 'addBots', roomId, count: 4, level: 'easy' })).toBe('roomFull');
    ok(c, S(host), { type: 'addBots', roomId, count: 2, level: 'easy' });
    ok(c, T, { type: 'addBots', roomId, count: 1, level: 'normal' });
    const r = c.rooms[roomId]!;
    expect(r.seats).toHaveLength(4);
    const botId = r.seats.find((id) => c.bots[id])!;
    expect(codeOf(c, S(other), { type: 'removeBot', roomId, botId })).toBe('forbidden');
    ok(c, S(host), { type: 'removeBot', roomId, botId });
    expect(c.bots[botId]).toBeUndefined();
    expect(r.seats).toHaveLength(3);
  });

  it('게임이 시작되면 봇도 명단과 함께 잠기고, 방을 닫으면 봇은 사라진다', () => {
    const { c, ids } = setup(1);
    const host = ids[0]!;
    ok(c, T, { type: 'designateHost', memberId: host });
    const roomId = ok(c, S(host), { type: 'createRoom', name: '1모둠', capacity: 4, bots: { count: 3, level: 'normal' } }).roomId!;
    const r = c.rooms[roomId]!;
    markSynced(c, roomId, r.syncVersion);
    expect(lockForStart(c, roomId, r.syncVersion, 'op-start-1', 1000).ok).toBe(true);
    const botId = r.seats.find((id) => c.bots[id])!;
    expect(codeOf(c, S(host), { type: 'removeBot', roomId, botId })).toBe('roomLocked');
    expect(codeOf(c, T, { type: 'addBots', roomId, count: 1, level: 'easy' })).toBe('roomLocked');
    ok(c, T, { type: 'closeRoom', roomId });
    expect(Object.keys(c.bots)).toHaveLength(0);
  });
});

describe('학급 방: 봇 명단 반영', () => {
  function classRoomWithBots(humans: number, bots: number, teacherRoom = false): { c: ClassState; room: RoomState; ids: string[] } {
    const { c, ids } = setup(humans);
    let roomId: string;
    if (teacherRoom) {
      roomId = ok(c, T, { type: 'createRoom', name: '시범', capacity: bots, bots: { count: bots, level: 'normal' } }).roomId!;
    } else {
      const host = ids[0]!;
      ok(c, T, { type: 'designateHost', memberId: host });
      roomId = ok(c, S(host), { type: 'createRoom', name: '1모둠', capacity: humans + bots, bots: { count: bots, level: 'normal' } }).roomId!;
      for (const s of ids.slice(1)) ok(c, T, { type: 'moveStudent', memberId: s, toRoomId: roomId });
    }
    const out = applyClassSync(null, buildSync(c, roomId)!, renv());
    return { c, room: out.room!, ids };
  }

  it('봇은 빈 역할부터 앉고 늘 준비 완료다. 사람 방장이 준비하면 시작 조건을 채운다', () => {
    const { room, ids } = classRoomWithBots(1, 3);
    const host = ids[0]!;
    const bots = Object.values(room.members).filter((m) => m.bot);
    expect(bots).toHaveLength(3);
    expect(bots.every((b) => b.ready && b.team)).toBe(true);
    const online = new Set([host]);
    expect(classStartProblems(room, online).some((p) => p.includes('팀·역할'))).toBe(true);
    const me = room.members[host]!;
    // 봇이 자리를 채운 뒤 남은 역할 (빨강 추측자 등)에 앉는다
    const red = Object.values(room.members).filter((m) => m.team === 'red');
    const team = red.length <= 1 ? 'red' : 'blue';
    expect(applyCommand(room, me, rcmd({ type: 'setSeat', team, role: 'operative' }), renv(), online).ok).toBe(true);
    expect(applyCommand(room, me, rcmd({ type: 'setReady', ready: true }), renv(), online).ok).toBe(true);
    expect(classStartProblems(room, online)).toEqual([]);
    const sum = roomSummary(room, online);
    expect(sum.onlineCount).toBe(4);
    expect(sum.readyCount).toBe(4);
  });

  it('학생 방장이 없는 방에서는 선생님이 방장 역할(시작·팀 나누기)을 한다', () => {
    const { room } = classRoomWithBots(0, 4, true);
    expect(room.hostId).toBe(TEACHER_ID);
    const v = projectRoom(room, TEACHER_ID, new Set(), renv());
    expect(v.you.isHost).toBe(true);
    expect(v.members.every((m) => m.bot && m.online && !m.detached)).toBe(true);
    expect(classStartProblems(room, new Set())).toEqual([]);
  });

  it('학급 방의 봇은 방 명령으로 넣고 뺄 수 없다 (좌석은 클래스가 정한다)', () => {
    const { room, ids } = classRoomWithBots(1, 3);
    const host = room.members[ids[0]!]!;
    const r = applyCommand(room, host, rcmd({ type: 'addBot', level: 'easy' }), renv(), new Set([host.id]));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('classManaged');
    // 자리(팀·역할) 옮기기는 방장이 방 안에서 한다
    const bot = Object.values(room.members).find((m) => m.bot)!;
    expect(applyCommand(room, host, rcmd({ type: 'setBotSeat', memberId: bot.id, team: 'blue', role: 'operative' }), renv(), new Set([host.id])).ok).toBe(true);
    expect(applyCommand(room, host, rcmd({ type: 'setBotSeat', memberId: bot.id, team: null, role: 'spectator' }), renv(), new Set([host.id])).ok).toBe(false);
  });

  it('클래스가 봇을 빼면 방에서도 빠진다 (버전 순서 유지)', () => {
    const { c, room } = classRoomWithBots(1, 3);
    const roomId = room.roomId;
    const botId = c.rooms[roomId]!.seats.find((id) => c.bots[id])!;
    ok(c, T, { type: 'removeBot', roomId, botId });
    const out = applyClassSync(room, buildSync(c, roomId)!, renv());
    expect(out.result).toBe('applied');
    expect(out.room!.members[botId]).toBeUndefined();
    expect(out.closeSessions).toEqual([]); // 봇은 끊을 연결이 없다
  });
});
