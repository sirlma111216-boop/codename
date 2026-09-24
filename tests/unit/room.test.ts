// 방 권한·경쟁 상태·정보 노출 검증 (room-logic 은 Durable Object 가 그대로 쓰는 함수다)
import { describe, expect, it } from 'vitest';
import type { ClientMessage, Command } from '../../src/shared/protocol.ts';
import {
  applyCommand,
  createRoom,
  joinRoom,
  maybeTransferHost,
  migrateRoom,
  projectRoom,
  type RoomEnv,
  type RoomState,
} from '../../src/server/room-logic.ts';

let counter = 0;
const env = (now = 1000): RoomEnv => ({ now, newId: (n: number) => `id${++counter}`.padEnd(Math.min(n, 12), 'x'), ttlHours: 24, hostGraceSeconds: 180 });

type Cmd = Extract<ClientMessage, { t: 'cmd' }>;
const cmd = (c: Command, extra: Partial<Cmd> = {}): Cmd => ({ t: 'cmd', commandId: `c${++counter}abcdefgh`, cmd: c, ...extra });

function setupRoom() {
  const room = createRoom('room1', 'h-host', '방장', env());
  const ids: Record<string, string> = { host: room.hostId };
  for (const [name, hash] of [
    ['a', 'h-a'],
    ['b', 'h-b'],
    ['c', 'h-c'],
    ['spec', 'h-spec'],
  ] as const) {
    const r = joinRoom(room, hash, true, name, env());
    if (!r.ok) throw new Error(r.code);
    ids[name] = r.memberId;
  }
  return { room, ids };
}

function run(room: RoomState, memberId: string, c: Cmd, online = new Set<string>()) {
  const me = room.members[memberId];
  if (!me) throw new Error('no member');
  return applyCommand(room, me, c, env(), online);
}

function seatStandard(room: RoomState, ids: Record<string, string>) {
  const seats: [string, Command][] = [
    [ids.host as string, { type: 'setSeat', team: 'red', role: 'spymaster' }],
    [ids.a as string, { type: 'setSeat', team: 'red', role: 'operative' }],
    [ids.b as string, { type: 'setSeat', team: 'blue', role: 'spymaster' }],
    [ids.c as string, { type: 'setSeat', team: 'blue', role: 'operative' }],
  ];
  for (const [id, c] of seats) expect(run(room, id, cmd(c)).ok).toBe(true);
}

describe('입장', () => {
  it('초대 토큰이 틀리면 거절, 잠긴 방은 새 입장 거절, 기존 참가자는 재입장 가능', () => {
    const { room, ids } = setupRoom();
    expect(joinRoom(room, 'h-new', false, 'x', env())).toEqual({ ok: false, code: 'badInvite' });
    expect(run(room, ids.host as string, cmd({ type: 'lock', locked: true })).ok).toBe(true);
    expect(joinRoom(room, 'h-new', true, 'x', env())).toEqual({ ok: false, code: 'locked' });
    expect(joinRoom(room, 'h-a', false, 'a', env())).toMatchObject({ ok: true, created: false });
  });

  it('닉네임에서 태그 기호·제어문자를 지우고 길이를 자른다', () => {
    const { room } = setupRoom();
    const r = joinRoom(room, 'h-x', true, '<b>이름\u0000이아주아주아주아주길어요길어요</b>', env());
    if (!r.ok) throw new Error();
    const nick = room.members[r.memberId]?.nickname ?? '';
    expect(nick).not.toMatch(/[<>]/);
    expect([...nick].length).toBeLessThanOrEqual(16);
  });
});

describe('권한', () => {
  it('방장 전용 명령은 다른 참가자가 할 수 없다', () => {
    const { room, ids } = setupRoom();
    for (const c of [{ type: 'startGame' }, { type: 'lock', locked: true }, { type: 'rotateInvite' }, { type: 'closeRoom' }] as Command[]) {
      const r = run(room, ids.a as string, cmd(c));
      expect(r.ok).toBe(false);
    }
  });

  it('역할이 모자라면 시작할 수 없고, 준비되면 시작된다', () => {
    const { room, ids } = setupRoom();
    const r = run(room, ids.host as string, cmd({ type: 'startGame' }));
    expect(r.ok).toBe(false);
    seatStandard(room, ids);
    expect(run(room, ids.host as string, cmd({ type: 'startGame' })).ok).toBe(true);
    expect(room.game?.phase).toBe('awaitingClue');
    // 시작 뒤 자리 잠금
    expect(run(room, ids.a as string, cmd({ type: 'setSeat', team: 'red', role: 'spymaster' })).ok).toBe(false);
  });

  it('정식판 팩은 자료 미확보라 시작할 수 없다', () => {
    const { room, ids } = setupRoom();
    seatStandard(room, ids);
    expect(run(room, ids.host as string, cmd({ type: 'setSettings', packId: 'ko-official-classic' }))).toMatchObject({ ok: false, code: 'contentUnavailable' });
    // 저장 상태를 직접 바꿔도 시작 단계에서 다시 막는다
    room.settings.packId = 'ko-official-classic';
    const r = run(room, ids.host as string, cmd({ type: 'startGame' }));
    expect(r).toMatchObject({ ok: false, code: 'contentUnavailable' });
  });

  it('게임 중 스파이마스터와 관전자는 자유 채팅을 보낼 수 없고, 추측자는 보낼 수 있다', () => {
    const { room, ids } = setupRoom();
    seatStandard(room, ids);
    run(room, ids.host as string, cmd({ type: 'startGame' }));
    expect(run(room, ids.host as string, cmd({ type: 'chat', text: '힌트' })).ok).toBe(false);
    expect(run(room, ids.b as string, cmd({ type: 'chat', text: '힌트' })).ok).toBe(false);
    expect(run(room, ids.spec as string, cmd({ type: 'chat', text: '안녕' })).ok).toBe(false);
    expect(run(room, ids.a as string, cmd({ type: 'chat', text: '이거 아닐까' })).ok).toBe(true);
  });

  it('방장은 관리 역할만으로 키를 볼 수 없다', () => {
    const { room, ids } = setupRoom();
    run(room, ids.host as string, cmd({ type: 'setSeat', team: null, role: 'spectator' }));
    run(room, ids.a as string, cmd({ type: 'setSeat', team: 'red', role: 'spymaster' }));
    run(room, ids.b as string, cmd({ type: 'setSeat', team: 'red', role: 'operative' }));
    run(room, ids.c as string, cmd({ type: 'setSeat', team: 'blue', role: 'spymaster' }));
    run(room, ids.spec as string, cmd({ type: 'setSeat', team: 'blue', role: 'operative' }));
    expect(run(room, ids.host as string, cmd({ type: 'startGame' })).ok).toBe(true);
    const v = projectRoom(room, ids.host as string, new Set(), env());
    expect(v.you.isHost).toBe(true);
    expect(v.game?.cards.every((c) => c.key === undefined)).toBe(true);
    const sm = projectRoom(room, ids.a as string, new Set(), env());
    expect(sm.game?.cards.every((c) => c.key !== undefined)).toBe(true);
  });
});

describe('경쟁 상태', () => {
  function started() {
    const { room, ids } = setupRoom();
    seatStandard(room, ids);
    run(room, ids.host as string, cmd({ type: 'startGame' }));
    const g = room.game!;
    const sm = g.startingTeam === 'red' ? ids.host : ids.b;
    const op = g.startingTeam === 'red' ? ids.a : ids.c;
    run(room, sm as string, cmd({ type: 'game', action: { type: 'giveClue', word: '힌트', number: 1 } }, { gameId: g.gameId, expectedRevision: g.revision }));
    return { room, ids, op: op as string };
  }

  it('같은 revision 으로 온 두 번째 확정은 거절된다 (한 번만 반영)', () => {
    const { room, op } = started();
    const g = room.game!;
    const rev = g.revision;
    const own = g.identities.findIndex((x) => x === g.startingTeam);
    const other = g.identities.findIndex((x, i) => x === g.startingTeam && i !== own);
    const first = run(room, op, cmd({ type: 'game', action: { type: 'guess', index: own } }, { gameId: g.gameId, expectedRevision: rev }));
    expect(first.ok).toBe(true);
    const second = run(room, op, cmd({ type: 'game', action: { type: 'guess', index: other } }, { gameId: g.gameId, expectedRevision: rev }));
    expect(second).toMatchObject({ ok: false, code: 'staleRevision', sendState: true });
    expect(room.game!.revealed.filter(Boolean).length).toBe(1);
  });

  it('이전 gameId 의 명령은 거절된다', () => {
    const { room, op } = started();
    const r = run(room, op, cmd({ type: 'game', action: { type: 'guess', index: 0 } }, { gameId: 'old-game', expectedRevision: room.game!.revision }));
    expect(r).toMatchObject({ ok: false, code: 'staleGame' });
  });
});

describe('강퇴·재지정·방장 이양', () => {
  it('강퇴하면 세션이 차단되고 초대 토큰으로도 다시 못 들어온다', () => {
    const { room, ids } = setupRoom();
    const r = run(room, ids.host as string, cmd({ type: 'kick', memberId: ids.spec as string }));
    expect(r.ok && r.effects.closeSessions[0]?.sessionHash).toBe('h-spec');
    expect(room.members[ids.spec as string]).toBeUndefined();
    expect(joinRoom(room, 'h-spec', true, 'spec', env())).toEqual({ ok: false, code: 'banned' });
  });

  it('게임 중 강퇴된 참가자의 자리는 남고, 새 세션으로 재지정할 수 있다', () => {
    const { room, ids } = setupRoom();
    seatStandard(room, ids);
    run(room, ids.host as string, cmd({ type: 'startGame' }));
    run(room, ids.host as string, cmd({ type: 'kick', memberId: ids.a as string }));
    expect(room.members[ids.a as string]?.sessionHash).toBeNull();
    const nj = joinRoom(room, 'h-a-new', true, 'a새기기', env());
    if (!nj.ok) throw new Error();
    const r = run(room, ids.host as string, cmd({ type: 'reassignSeat', fromMemberId: nj.memberId, toMemberId: ids.a as string }));
    expect(r.ok).toBe(true);
    expect(room.members[ids.a as string]?.sessionHash).toBe('h-a-new');
    expect(room.members[nj.memberId]).toBeUndefined();
  });

  it('정답을 본 참가자를 추측자 자리로 재지정하는 우회를 막는다', () => {
    const { room, ids } = setupRoom();
    seatStandard(room, ids);
    run(room, ids.host as string, cmd({ type: 'startGame' }));
    // b(파랑 스파이마스터)를 교체해 관전자로 만든 뒤, 그 세션을 추측자 자리로 옮기려 한다
    const extra = joinRoom(room, 'h-d', true, 'd', env());
    if (!extra.ok) throw new Error();
    room.game!.sawKey.push(extra.memberId); // 정답을 본 사람으로 가정
    const r = run(room, ids.host as string, cmd({ type: 'reassignSeat', fromMemberId: extra.memberId, toMemberId: ids.c as string }));
    expect(r).toMatchObject({ ok: false, code: 'forbidden' });
  });

  it('방장이 대기 시간 넘게 끊기면 가장 먼저 들어온 온라인 참가자에게 관리 권한만 넘어간다', () => {
    const { room, ids } = setupRoom();
    const online = new Set([ids.a as string, ids.b as string]);
    expect(maybeTransferHost(room, online, env(1000))).toBe(true); // 끊긴 시각 기록
    expect(room.hostId).toBe(ids.host);
    expect(maybeTransferHost(room, online, env(1000 + 60_000))).toBe(false);
    expect(maybeTransferHost(room, online, env(1000 + 181_000))).toBe(true);
    expect(room.hostId).toBe(ids.a);
  });
});

describe('저장 상태 호환', () => {
  it('예전 형태의 상태도 기본값을 채워 읽는다 (방을 초기화하지 않는다)', () => {
    const { room } = setupRoom();
    const old = JSON.parse(JSON.stringify(room)) as Record<string, unknown>;
    delete old.schemaVersion;
    delete old.dedup;
    delete old.timer;
    const m = migrateRoom(old);
    expect(m?.members).toEqual(room.members);
    expect(m?.dedup).toEqual([]);
    expect(migrateRoom(null)).toBeNull();
  });
});
