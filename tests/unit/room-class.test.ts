// 학급 모드 게임방: 클래스 명단 반영(멱등·순서), 준비·시작 조건, 독립 방 경로 차단, 교사 관전 정보
import { describe, expect, it } from 'vitest';
import type { ClassRoomSync } from '../../src/shared/classroom.ts';
import type { ClientMessage, Command } from '../../src/shared/protocol.ts';
import { applyClassSync, applyCommand, classStartProblems, joinRoom, projectRoom, roomSummary, TEACHER_ID, type RoomEnv, type RoomState } from '../../src/server/room-logic.ts';

let n = 0;
const env = (now = 1000): RoomEnv => ({ now, newId: (b: number) => `r${++n}`.padEnd(Math.min(b, 12), 'x'), ttlHours: 24, hostGraceSeconds: 180 });
type Cmd = Extract<ClientMessage, { t: 'cmd' }>;
const cmd = (c: Command, extra: Partial<Cmd> = {}): Cmd => ({ t: 'cmd', commandId: `c${++n}abcdefgh`, cmd: c, ...extra });

function sync(version: number, memberIds: string[], over: Partial<ClassRoomSync> = {}): ClassRoomSync {
  return {
    classId: 'class1',
    className: '3-2',
    roomId: 'room1',
    syncVersion: version,
    name: '1모둠',
    capacity: memberIds.length,
    hostMemberId: memberIds[0] ?? null,
    members: memberIds.map((id) => ({ memberId: id, nickname: `학생${id}`, sessionHash: `h-${id}` })),
    teacherHashes: ['teacher-hash'],
    closed: false,
    closeReason: null,
    ...over,
  };
}

function classRoom(ids: string[], capacity = ids.length): RoomState {
  const out = applyClassSync(null, sync(1, ids, { capacity }), env());
  if (!out.room) throw new Error('no room');
  return out.room;
}

function run(room: RoomState, id: string, c: Cmd, online = new Set(Object.keys(room.members)), opts = {}) {
  return applyCommand(room, room.members[id]!, c, env(), online, opts);
}

function seatAll(room: RoomState, plan: [string, 'red' | 'blue', 'spymaster' | 'operative'][]) {
  for (const [id, team, role] of plan) {
    expect(run(room, id, cmd({ type: 'setSeat', team, role })).ok).toBe(true);
    expect(run(room, id, cmd({ type: 'setReady', ready: true })).ok).toBe(true);
  }
}

describe('클래스 명단 반영', () => {
  it('처음 반영하면 학급 방이 만들어지고, 같은·옛 버전은 무시된다 (재전송·순서 바뀜에 안전)', () => {
    const r = classRoom(['a', 'b']);
    expect(r.classLink?.syncVersion).toBe(1);
    expect(Object.keys(r.members).sort()).toEqual(['a', 'b']);
    const v3 = applyClassSync(r, sync(3, ['a', 'b', 'c']), env());
    expect(v3.result).toBe('applied');
    const late = applyClassSync(v3.room, sync(2, ['a']), env());
    expect(late.result).toBe('stale');
    expect(Object.keys(late.room!.members).sort()).toEqual(['a', 'b', 'c']);
    expect(applyClassSync(v3.room, sync(3, ['a', 'b', 'c']), env()).result).toBe('stale');
  });

  it('다른 클래스의 반영은 거절한다', () => {
    const r = classRoom(['a']);
    expect(applyClassSync(r, sync(5, ['z'], { classId: 'other-class' }), env()).result).toBe('mismatch');
  });

  it('명단·정원·방장 변경은 준비 상태를 초기화하고, 빠진 학생의 세션을 끊는다', () => {
    const r = classRoom(['a', 'b', 'c', 'd']);
    seatAll(r, [
      ['a', 'red', 'spymaster'],
      ['b', 'red', 'operative'],
      ['c', 'blue', 'spymaster'],
      ['d', 'blue', 'operative'],
    ]);
    expect(Object.values(r.members).every((m) => m.ready)).toBe(true);
    const out = applyClassSync(r, sync(2, ['a', 'b', 'c']), env());
    expect(out.closeSessions).toEqual([{ sessionHash: 'h-d', reason: 'removed' }]);
    expect(Object.values(out.room!.members).every((m) => !m.ready)).toBe(true);
    expect(out.room!.members.d).toBeUndefined();
  });

  it('닫힘 반영: 진행 중이던 게임은 ‘수업 종료로 중단’(승패 없음)', () => {
    const r = classRoom(['a', 'b', 'c', 'd']);
    seatAll(r, [
      ['a', 'red', 'spymaster'],
      ['b', 'red', 'operative'],
      ['c', 'blue', 'spymaster'],
      ['d', 'blue', 'operative'],
    ]);
    expect(run(r, 'a', cmd({ type: 'startGame' }), undefined, { classStartApproved: true }).ok).toBe(true);
    const out = applyClassSync(r, sync(2, ['a', 'b', 'c', 'd'], { closed: true, closeReason: 'classEnded' }), env());
    expect(out.closedNow).toBe(true);
    expect(out.room!.game?.phase).toBe('finished');
    expect(out.room!.game?.endReason).toBe('classEnded');
    expect(out.room!.game?.winner).toBeNull();
  });

  it('진행 중에는 좌석을 빼지 않고 세션만 반영한다 (자동 재배치 없음)', () => {
    const r = classRoom(['a', 'b', 'c', 'd']);
    seatAll(r, [
      ['a', 'red', 'spymaster'],
      ['b', 'red', 'operative'],
      ['c', 'blue', 'spymaster'],
      ['d', 'blue', 'operative'],
    ]);
    run(r, 'a', cmd({ type: 'startGame' }), undefined, { classStartApproved: true });
    const p = sync(2, ['a', 'b', 'c', 'd']);
    p.members[3]!.sessionHash = null; // 교사가 d 를 강퇴 → 연결만 끊김
    const out = applyClassSync(r, p, env());
    expect(out.room!.members.d?.sessionHash).toBeNull();
    expect(out.room!.game?.roster.some((x) => x.memberId === 'd')).toBe(true);
  });
});

describe('학급 방 시작 조건', () => {
  it('정원 미충족·미준비·역할 누락·팀 불균형이면 시작 조건을 보고한다', () => {
    const r = classRoom(['a', 'b', 'c', 'd'], 5);
    const online = new Set(['a', 'b', 'c', 'd']);
    expect(classStartProblems(r, online).join()).toContain('정원 5명');
    const full = classRoom(['a', 'b', 'c', 'd', 'e']);
    const on5 = new Set(['a', 'b', 'c', 'd', 'e']);
    expect(classStartProblems(full, on5).join()).toContain('팀·역할을 고르지 않은 사람');
    // 5명: 3 대 2 는 가능
    seatAll(full, [
      ['a', 'red', 'spymaster'],
      ['b', 'red', 'operative'],
      ['c', 'red', 'operative'],
      ['d', 'blue', 'spymaster'],
      ['e', 'blue', 'operative'],
    ]);
    expect(classStartProblems(full, on5)).toEqual([]);
    // 접속이 끊긴 사람이 있으면 시작 불가
    expect(classStartProblems(full, new Set(['a', 'b', 'c', 'd'])).join()).toContain('접속하지 않은 사람');
  });

  it('7명은 4 대 3 가능, 6명이 4 대 2 면 불균형으로 거절', () => {
    const seven = classRoom(['a', 'b', 'c', 'd', 'e', 'f', 'g']);
    seatAll(seven, [
      ['a', 'red', 'spymaster'],
      ['b', 'red', 'operative'],
      ['c', 'red', 'operative'],
      ['d', 'red', 'operative'],
      ['e', 'blue', 'spymaster'],
      ['f', 'blue', 'operative'],
      ['g', 'blue', 'operative'],
    ]);
    expect(classStartProblems(seven, new Set(Object.keys(seven.members)))).toEqual([]);
    const six = classRoom(['a', 'b', 'c', 'd', 'e', 'f']);
    seatAll(six, [
      ['a', 'red', 'spymaster'],
      ['b', 'red', 'operative'],
      ['c', 'red', 'operative'],
      ['d', 'red', 'operative'],
      ['e', 'blue', 'spymaster'],
      ['f', 'blue', 'operative'],
    ]);
    expect(classStartProblems(six, new Set(Object.keys(six.members))).join()).toContain('인원 차이');
  });

  it('준비 없이 역할을 바꾸면 준비가 풀리고, 팀 자동 배정은 차이 1명 이하로 나눈다', () => {
    const r = classRoom(['a', 'b', 'c', 'd', 'e', 'f', 'g']);
    expect(run(r, 'a', cmd({ type: 'autoBalance' })).ok).toBe(true);
    const red = Object.values(r.members).filter((m) => m.team === 'red').length;
    const blue = Object.values(r.members).filter((m) => m.team === 'blue').length;
    expect(Math.abs(red - blue)).toBeLessThanOrEqual(1);
    expect(Object.values(r.members).filter((m) => m.role === 'spymaster')).toHaveLength(2);
    expect(run(r, 'b', cmd({ type: 'autoBalance' })).ok).toBe(false); // 방장만
    run(r, 'c', cmd({ type: 'setReady', ready: true }));
    run(r, 'c', cmd({ type: 'setSeat', team: 'red', role: 'operative' }));
    expect(r.members.c?.ready).toBe(false);
  });

  it('클래스의 명단 잠금 없이 방장이 직접 시작할 수 없다', () => {
    const r = classRoom(['a', 'b', 'c', 'd']);
    seatAll(r, [
      ['a', 'red', 'spymaster'],
      ['b', 'red', 'operative'],
      ['c', 'blue', 'spymaster'],
      ['d', 'blue', 'operative'],
    ]);
    expect(run(r, 'a', cmd({ type: 'startGame' }))).toMatchObject({ ok: false, code: 'needClassLock' });
  });
});

describe('독립 방 경로로 학급 방을 우회할 수 없다', () => {
  it('초대 링크 입장·강퇴·잠금·초대 변경·방 닫기·방장 넘기기·자리 재지정은 클래스가 관리한다', () => {
    const r = classRoom(['a', 'b']);
    expect(joinRoom(r, 'h-x', true, '외부', env())).toEqual({ ok: false, code: 'classManaged' });
    for (const c of [
      { type: 'kick', memberId: 'b' },
      { type: 'lock', locked: true },
      { type: 'rotateInvite' },
      { type: 'closeRoom' },
      { type: 'transferHost', memberId: 'b' },
      { type: 'reassignSeat', fromMemberId: 'b', toMemberId: 'a' },
    ] as Command[]) {
      expect(run(r, 'a', cmd(c))).toMatchObject({ ok: false, code: 'classManaged' });
    }
    expect(run(r, 'a', cmd({ type: 'setSeat', team: null, role: 'spectator' })).ok).toBe(false);
    expect(run(r, 'a', cmd({ type: 'setSettings', rulesetId: 'cge2015-coop' }))).toMatchObject({ ok: false, code: 'classStandardOnly' });
    expect(projectRoom(r, 'a', new Set(), env()).inviteToken).toBe('');
  });
});

describe('교사 관전·클래스 요약에는 정답이 없다', () => {
  it('교사는 공개 정보만 받고, 클래스에 보내는 요약에도 키·단어가 없다', () => {
    const r = classRoom(['a', 'b', 'c', 'd']);
    seatAll(r, [
      ['a', 'red', 'spymaster'],
      ['b', 'red', 'operative'],
      ['c', 'blue', 'spymaster'],
      ['d', 'blue', 'operative'],
    ]);
    run(r, 'a', cmd({ type: 'startGame' }), undefined, { classStartApproved: true });
    const t = projectRoom(r, TEACHER_ID, new Set(), env());
    expect(t.game?.cards.every((c) => c.key === undefined)).toBe(true);
    expect(t.you.isHost).toBe(false);
    expect(t.classMode?.isTeacher).toBe(true);
    const sum = JSON.stringify(roomSummary(r, new Set()));
    expect(sum).not.toMatch(/"key"|identities|seed|keyId|words|"word"/);
    for (const w of r.game!.words) expect(sum).not.toContain(w);
  });
});
