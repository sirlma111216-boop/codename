// 봇: 연상 사전, 판단의 정직성(추측자는 정답을 못 본다), 힌트의 적법성, 봇끼리 끝까지 두기, 혼자 하기 구성, 정답 보기 관전
import { describe, expect, it } from 'vitest';
import { projectGame } from '../../src/game/projection.ts';
import { validateRoster } from '../../src/game/rulesets.ts';
import type { GameState, Team } from '../../src/game/types.ts';
import type { BotLevel, SoloConfig } from '../../src/shared/bots.ts';
import type { ClientMessage, Command } from '../../src/shared/protocol.ts';
import { chooseClue, chooseGuess, clashesWithBoard, LEVELS } from '../../src/server/bots/brain.ts';
import { LEXICON, lexiconCovers } from '../../src/server/bots/lexicon.ts';
import { decideBotCommand, nextBotTask, recordBotDecision } from '../../src/server/bots/room-bots.ts';
import { applyCommand, createRoom, createSoloRoom, projectRoom, type Member, type RoomEnv, type RoomState } from '../../src/server/room-logic.ts';
import cards from '../../content/packs/ko-original-v1/cards.json' with { type: 'json' };

let n = 0;
const env = (): RoomEnv => ({ now: 1000 + n, newId: (b: number) => `id${++n}`.padEnd(Math.min(b, 16), 'x'), ttlHours: 24, hostGraceSeconds: 180 });
type Cmd = Extract<ClientMessage, { t: 'cmd' }>;
const cmd = (c: Command, room?: RoomState): Cmd => ({ t: 'cmd', commandId: `c${++n}abcdefgh`, gameId: room?.game?.gameId ?? null, expectedRevision: room?.game?.revision, cmd: c });

const solo = (over: Partial<SoloConfig> = {}): SoloConfig => ({ rulesetId: 'cge2015-standard', myRole: 'spectator', myTeam: 'red', players: 4, allyLevel: 'normal', enemyLevel: 'normal', botSpeed: 'fast', ...over });

function startSolo(cfg: SoloConfig): RoomState {
  const room = createSoloRoom(`room${++n}`, `h${n}`, '나', cfg, env());
  const host = room.members[room.hostId] as Member;
  const res = applyCommand(room, host, cmd({ type: 'startGame' }), env(), new Set([host.id]));
  if (!res.ok) throw new Error(res.message);
  return room;
}

/** 봇 차례를 끝날 때까지 적용한다. 모든 명령은 사람과 같은 applyCommand 를 거친다. */
function playOut(room: RoomState, maxSteps = 600): number {
  for (let i = 0; i < maxSteps; i++) {
    const g = room.game as GameState;
    if (g.phase === 'finished') return i;
    const task = nextBotTask(room);
    if (!task) throw new Error(`봇 할 일 없음: ${g.phase}`);
    const d = decideBotCommand(room, task);
    if (!d) throw new Error(`결정 없음: ${task.kind}`);
    const bot = room.members[task.memberId] as Member;
    const before = g.nextClueId;
    const res = applyCommand(room, bot, cmd(d.cmd, room), env(), new Set());
    if (!res.ok) throw new Error(`거절: ${task.kind} ${res.code} ${res.message} ${JSON.stringify(d.cmd)}`);
    recordBotDecision(room, d, task.kind === 'clue' ? before : null);
  }
  throw new Error('끝나지 않음');
}

describe('연상 사전', () => {
  it('기본 단어 팩(자체 제작) 400단어를 모두 안다', () => {
    const words = (cards as { faceA: string; faceB: string }[]).flatMap((c) => [c.faceA, c.faceB]);
    expect(words).toHaveLength(400);
    expect(lexiconCovers(words)).toBe(true);
  });

  it('직접 연결이 겹치는 이웃보다 강하고, 별칭·접미사를 사전 표기로 맞춘다', () => {
    expect(LEXICON.score('크리스마스', '산타')).toBeGreaterThanOrEqual(0.9);
    expect(LEXICON.score('산타', '썰매')).toBeGreaterThan(0.6);
    expect(LEXICON.score('크리스마스', '화산')).toBeLessThan(0.3);
    expect(LEXICON.canonical('빨간색')).toBe('빨강');
    expect(LEXICON.canonical('동물들')).toBe('동물');
    expect(LEXICON.score('빨간색', '딸기')).toBeGreaterThan(0.6);
  });
});

describe('봇의 정직성', () => {
  it('추측자 봇의 화면에는 미공개 정답이 없고, 정답 배치를 바꿔도 같은 카드를 고른다', () => {
    const room = startSolo(solo());
    const g = room.game as GameState;
    // 첫 힌트까지 진행
    const t = nextBotTask(room)!;
    const d = decideBotCommand(room, t)!;
    expect(applyCommand(room, room.members[t.memberId] as Member, cmd(d.cmd, room), env(), new Set()).ok).toBe(true);
    const op = g.roster.find((r) => r.role === 'operative' && r.team === room.game!.turnTeam)!.memberId;
    const view = projectGame(room.game!, op, '');
    expect(view.cards.every((c) => c.key === undefined)).toBe(true);
    const pick = chooseGuess(view, 'normal', 'seed');
    // 서버의 정답 배치만 뒤섞은 상태
    const shuffled: GameState = structuredClone(room.game!);
    shuffled.identities = shuffled.identities.slice().reverse();
    const view2 = projectGame(shuffled, op, '');
    expect(chooseGuess(view2, 'normal', 'seed')).toEqual(pick);
  });

  it('스파이마스터 봇의 힌트는 판에 보이는 단어와 겹치지 않고, 노린 카드는 모두 자기 팀 요원이다', () => {
    for (let i = 0; i < 40; i++) {
      const room = startSolo(solo({ allyLevel: (['easy', 'normal', 'hard'] as BotLevel[])[i % 3]! }));
      const g = room.game!;
      const sm = g.roster.find((r) => r.role === 'spymaster' && r.team === g.turnTeam)!.memberId;
      const view = projectGame(g, sm, '');
      const level = room.members[sm]!.bot!.level;
      const c = chooseClue(view, level, `s${i}`);
      expect(c.word).toMatch(/^[가-힣]+$/);
      expect(clashesWithBoard(view, c.word)).toBe(false);
      expect(c.number).toBeGreaterThanOrEqual(1);
      expect(c.number).toBeLessThanOrEqual(LEVELS[level].maxTargets);
      expect(c.targets).toHaveLength(c.number);
      for (const idx of c.targets) expect(g.identities[idx]).toBe(g.turnTeam);
      const assassin = g.identities.indexOf('assassin');
      expect(LEXICON.score(c.word, g.words[assassin]!)).toBeLessThan(0.6);
    }
  });
});

describe('봇끼리 끝까지', () => {
  const run = (red: BotLevel, blue: BotLevel, games: number, players = 4) => {
    const stats = { games, redWins: 0, assassin: 0, turns: 0, clueSum: 0, clues: 0 };
    for (let i = 0; i < games; i++) {
      const room = startSolo(solo({ allyLevel: red, enemyLevel: blue, players }));
      playOut(room);
      const g = room.game!;
      if (g.winner === 'red') stats.redWins++;
      if (g.endReason === 'assassin') stats.assassin++;
      stats.turns += g.turnNumber;
      for (const c of g.clues) {
        stats.clues++;
        stats.clueSum += typeof c.number === 'number' ? c.number : 0;
      }
    }
    return stats;
  };

  it.each([
    ['easy', 'easy'],
    ['normal', 'normal'],
    ['hard', 'hard'],
  ] as [BotLevel, BotLevel][])('%s 대 %s: 거절 없이 모든 게임이 끝난다', (a, b) => {
    const s = run(a, b, 25);
    const avg = s.clueSum / s.clues;
    console.log(`[bots] ${a} vs ${b}: ${s.games}판, 빨강 승 ${s.redWins}, 암살자 ${s.assassin}, 평균 턴 ${(s.turns / s.games).toFixed(1)}, 힌트 평균 숫자 ${avg.toFixed(2)}`);
    expect(avg).toBeLessThanOrEqual(LEVELS[a].maxTargets);
  }, 60_000);

  it('난이도가 높을수록 한 번에 노리는 단어가 많다', () => {
    const e = run('easy', 'easy', 15);
    const h = run('hard', 'hard', 15);
    expect(h.clueSum / h.clues).toBeGreaterThan(e.clueSum / e.clues);
  }, 60_000);

  it('어려움 봇 팀이 쉬움 봇 팀보다 많이 이긴다 (60판)', () => {
    const s = run('hard', 'easy', 60);
    console.log(`[bots] hard(빨강) vs easy(파랑): 60판 중 빨강 ${s.redWins}승, 암살자 ${s.assassin}`);
    expect(s.redWins).toBeGreaterThan(30);
  }, 60_000);

  it('협력 변형: 봇 팀이 가상 상대 차례까지 처리하며 끝까지 간다', () => {
    for (let i = 0; i < 10; i++) {
      const room = startSolo(solo({ rulesetId: 'cge2015-coop', players: 3 }));
      playOut(room);
      expect(room.game!.phase).toBe('finished');
    }
  }, 60_000);
});

describe('혼자 하기 구성', () => {
  it.each([
    ['cge2015-standard', 'operative', 4],
    ['cge2015-standard', 'spymaster', 5],
    ['cge2015-standard', 'spectator', 8],
    ['cge2015-coop', 'operative', 2],
    ['cge2015-coop', 'spymaster', 6],
    ['cge2015-coop', 'spectator', 3],
  ] as [SoloConfig['rulesetId'], SoloConfig['myRole'], number][])('%s · 나=%s · %i명: 규칙에 맞는 자리', (rulesetId, myRole, players) => {
    const room = createSoloRoom('r', 'h', '나', solo({ rulesetId, myRole, players, myTeam: 'blue' }), env());
    const people = Object.values(room.members);
    const inGame = people.filter((m) => m.role !== 'spectator');
    expect(inGame).toHaveLength(players);
    const check = validateRoster(rulesetId, people.map((m) => ({ memberId: m.id, team: m.team, role: m.role })));
    expect(check.ok).toBe(true);
    const me = room.members[room.hostId]!;
    expect(me.bot).toBeUndefined();
    if (myRole !== 'spectator') expect(me.team).toBe('blue');
    expect(room.solo).toBe(true);
    expect(room.locked).toBe(true);
  });

  it('사람 추측자가 있는 팀에서는 봇이 카드를 고르지 않고 해석만 한 번 남긴다', () => {
    const room = startSolo(solo({ myRole: 'operative', players: 6 }));
    const g = room.game!;
    // 사람 팀이 선공이 아닐 수 있으므로 사람 팀 차례가 될 때까지 봇이 진행
    for (let i = 0; i < 200 && !(g.phase === 'guessing' && room.game!.turnTeam === 'red') && room.game!.phase !== 'finished'; i++) {
      const cur = room.game!;
      if (cur.phase === 'guessing' && cur.turnTeam === 'red') break;
      const t = nextBotTask(room);
      if (!t) break;
      const d = decideBotCommand(room, t)!;
      const before = cur.nextClueId;
      expect(applyCommand(room, room.members[t.memberId]!, cmd(d.cmd, room), env(), new Set()).ok).toBe(true);
      recordBotDecision(room, d, t.kind === 'clue' ? before : null);
    }
    const cur = room.game!;
    if (cur.phase !== 'guessing' || cur.turnTeam !== 'red') return; // 드물게 상대가 먼저 끝냄
    const t = nextBotTask(room);
    expect(t?.kind).toBe('advise');
    const d = decideBotCommand(room, t!)!;
    expect(d.cmd.type).toBe('chat');
    expect(applyCommand(room, room.members[t!.memberId]!, cmd(d.cmd, room), env(), new Set()).ok).toBe(true);
    recordBotDecision(room, d, null);
    expect(nextBotTask(room)).toBeNull(); // 결정은 사람이 한다
  });
});

describe('봇만 있는 게임의 정답 보기 관전', () => {
  it('모두 봇이면 방장이 켠 ‘정답 보기’로 관전자에게 정답·노린 단어를 보여 준다', () => {
    const room = startSolo(solo());
    const t = nextBotTask(room)!;
    const d = decideBotCommand(room, t)!;
    const before = room.game!.nextClueId;
    applyCommand(room, room.members[t.memberId]!, cmd(d.cmd, room), env(), new Set());
    recordBotDecision(room, d, before);
    const me = room.hostId;
    let v = projectRoom(room, me, new Set([me]), env());
    expect(v.game!.cards.some((c) => c.key)).toBe(false);
    expect(v.botIntents).toEqual([]);
    expect(applyCommand(room, room.members[me]!, cmd({ type: 'setWatchKey', on: true }), env(), new Set([me])).ok).toBe(true);
    v = projectRoom(room, me, new Set([me]), env());
    expect(v.game!.cards.every((c) => c.key)).toBe(true);
    expect(v.botIntents[0]!.words.length).toBeGreaterThan(0);
  });

  it('사람 참가자가 있으면 정답 보기를 켜도 관전자에게 정답을 보내지 않는다', () => {
    const room = createRoom('r2', 'host', '방장', env());
    const host = room.members[room.hostId]!;
    const e = env();
    room.members.p = { id: 'p', nickname: '사람', sessionHash: 'hp', joinedAt: 1, team: 'red', role: 'operative' };
    room.members.w = { id: 'w', nickname: '관전', sessionHash: 'hw', joinedAt: 1, team: null, role: 'spectator' };
    for (let i = 0; i < 3; i++) applyCommand(room, host, cmd({ type: 'addBot', level: 'normal' }), e, new Set());
    applyCommand(room, host, cmd({ type: 'setWatchKey', on: true }), e, new Set());
    const res = applyCommand(room, host, cmd({ type: 'startGame' }), e, new Set());
    expect(res.ok).toBe(true);
    const v = projectRoom(room, 'w', new Set(), e);
    expect(v.game!.cards.some((c) => c.key)).toBe(false);
  });
});

describe('독립 방의 봇', () => {
  it('방장만 봇을 넣고 빼며, 빈 역할부터 앉힌다. 게임 중에는 못 바꾼다', () => {
    const room = createRoom('r3', 'host', '방장', env());
    const host = room.members[room.hostId]!;
    host.team = 'red';
    host.role = 'operative';
    room.members.x = { id: 'x', nickname: '손님', sessionHash: 'hx', joinedAt: 2, team: null, role: 'spectator' };
    expect(applyCommand(room, room.members.x!, cmd({ type: 'addBot', level: 'easy' }), env(), new Set()).ok).toBe(false);
    for (let i = 0; i < 3; i++) expect(applyCommand(room, host, cmd({ type: 'addBot', level: 'hard' }), env(), new Set()).ok).toBe(true);
    const bots = Object.values(room.members).filter((m) => m.bot);
    expect(bots.map((b) => `${b.team}:${b.role}`).sort()).toEqual(['blue:operative', 'blue:spymaster', 'red:spymaster']);
    expect(new Set(bots.map((b) => b.nickname)).size).toBe(3);
    expect(applyCommand(room, host, cmd({ type: 'startGame' }), env(), new Set()).ok).toBe(true);
    expect(applyCommand(room, host, cmd({ type: 'removeBot', memberId: bots[0]!.id }), env(), new Set()).ok).toBe(false);
    expect(applyCommand(room, host, cmd({ type: 'kick', memberId: bots[0]!.id }), env(), new Set()).ok).toBe(false);
  });

  it('봇 스파이마스터는 모르는 단어 팩(직접 입력)으로 시작할 수 없다. 봇이 추측자만이면 된다', () => {
    const room = createRoom('r4', 'host', '방장', env());
    const host = room.members[room.hostId]!;
    const e = env();
    const words = Array.from({ length: 30 }, (_, i) => `광합성${i}`);
    applyCommand(room, host, cmd({ type: 'setCustomWords', words }), e, new Set());
    applyCommand(room, host, cmd({ type: 'setSettings', packId: 'custom' }), e, new Set());
    host.team = 'red';
    host.role = 'spymaster';
    for (let i = 0; i < 3; i++) applyCommand(room, host, cmd({ type: 'addBot', level: 'normal' }), e, new Set());
    let res = applyCommand(room, host, cmd({ type: 'startGame' }), e, new Set());
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe('botPack');
    const blueSm = Object.values(room.members).find((m) => m.bot && m.team === 'blue' && m.role === 'spymaster')!;
    room.members.y = { id: 'y', nickname: '사람2', sessionHash: 'hy', joinedAt: 3, team: 'blue', role: 'spymaster' };
    applyCommand(room, host, cmd({ type: 'setBotSeat', memberId: blueSm.id, team: 'blue' as Team, role: 'operative' }), e, new Set());
    res = applyCommand(room, host, cmd({ type: 'startGame' }), e, new Set());
    expect(res.ok).toBe(true);
  });

  it('게임 중 봇 자리를 새로 온 사람이 이어받을 수 있다 (방장 재지정)', () => {
    const room = createRoom('r5', 'host', '방장', env());
    const host = room.members[room.hostId]!;
    host.team = 'red';
    host.role = 'spymaster';
    const e = env();
    for (let i = 0; i < 3; i++) applyCommand(room, host, cmd({ type: 'addBot', level: 'normal' }), e, new Set());
    expect(applyCommand(room, host, cmd({ type: 'startGame' }), e, new Set()).ok).toBe(true);
    const bot = Object.values(room.members).find((m) => m.bot && m.role === 'operative')!;
    room.members.late = { id: 'late', nickname: '지각생', sessionHash: 'hl', joinedAt: 9, team: null, role: 'spectator' };
    const res = applyCommand(room, host, cmd({ type: 'reassignSeat', fromMemberId: 'late', toMemberId: bot.id }), e, new Set([room.hostId, 'late']));
    expect(res.ok).toBe(true);
    expect(room.members[bot.id]!.bot).toBeUndefined();
    expect(room.members[bot.id]!.sessionHash).toBe('hl');
    expect(room.members[bot.id]!.nickname).toBe('지각생');
  });
});
