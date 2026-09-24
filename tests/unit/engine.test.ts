// 엔진 검증: 룰북 페이지별 분기 (docs/rule-audit.md 의 대응표와 같은 번호)
import { describe, expect, it } from 'vitest';
import { applyAction, guessLimit, type GameAction } from '../../src/game/engine.ts';
import { createGame } from '../../src/game/setup.ts';
import type { GameState, Identity, RosterEntry, RulesetId, Team } from '../../src/game/types.ts';
import { syntheticUnofficialPack } from '../fixtures/test-pack.ts';

const STANDARD_ROSTER: RosterEntry[] = [
  { memberId: 'rs', team: 'red', role: 'spymaster' },
  { memberId: 'ro', team: 'red', role: 'operative' },
  { memberId: 'ro2', team: 'red', role: 'operative' },
  { memberId: 'bs', team: 'blue', role: 'spymaster' },
  { memberId: 'bo', team: 'blue', role: 'operative' },
];

/** 인덱스 0~8 = 선공, 9~16 = 후공, 17~23 = 시민, 24 = 암살자 인 고정 배치 */
function fixedLayout(s: GameState): GameState {
  const other: Team = s.startingTeam === 'red' ? 'blue' : 'red';
  const ids: Identity[] = [];
  for (let i = 0; i < 9; i++) ids.push(s.startingTeam);
  for (let i = 0; i < 8; i++) ids.push(other);
  for (let i = 0; i < 7; i++) ids.push('bystander');
  ids.push('assassin');
  return { ...s, identities: ids };
}

function game(rulesetId: RulesetId = 'cge2015-standard', roster = STANDARD_ROSTER, coopTeam: Team | null = null, seed = 'seed-red'): GameState {
  const res = createGame({ gameId: 'g1', rulesetId, pack: syntheticUnofficialPack(), seed, roster, coopTeam, now: 1000 });
  if (!res.ok) throw new Error(res.message);
  return fixedLayout(res.state);
}

/** 선공이 red 인 게임을 얻는다 */
function redStarts(rulesetId: RulesetId = 'cge2015-standard', roster = STANDARD_ROSTER): GameState {
  for (let i = 0; i < 50; i++) {
    const g = game(rulesetId, roster, null, `seed-${i}`);
    if (g.startingTeam === 'red') return g;
  }
  throw new Error('no red start');
}

function act(s: GameState, actor: string, action: GameAction): GameState {
  const r = applyAction(s, actor, action, 2000);
  if (!r.ok) throw new Error(`${action.type}: ${r.error.code} ${r.error.message}`);
  return r.state;
}

function reject(s: GameState, actor: string, action: GameAction): string {
  const r = applyAction(s, actor, action, 2000);
  if (r.ok) throw new Error(`expected rejection for ${action.type}`);
  return r.error.code;
}

// 빨강 선공 기준: red 0~8, blue 9~16, bystander 17~23, assassin 24
const RED = [0, 1, 2, 3, 4, 5, 6, 7, 8];
const BLUE = [9, 10, 11, 12, 13, 14, 15, 16];
const BYSTANDER = 17;
const ASSASSIN = 24;

describe('p.4 힌트', () => {
  it('차례 팀 스파이마스터만 힌트를 줄 수 있다', () => {
    const g = redStarts();
    expect(reject(g, 'bs', { type: 'giveClue', word: '나무', number: 2 })).toBe('notYourTurn');
    expect(reject(g, 'ro', { type: 'giveClue', word: '나무', number: 2 })).toBe('notYourTurn');
    const s = act(g, 'rs', { type: 'giveClue', word: '나무', number: 2 });
    expect(s.phase).toBe('guessing');
    expect(s.currentClue?.word).toBe('나무');
  });

  it('보드에 보이는 단어는 힌트가 될 수 없지만, 덮인 뒤에는 쓸 수 있다', () => {
    const g = redStarts();
    const word = g.words[BYSTANDER] as string;
    expect(reject(g, 'rs', { type: 'giveClue', word: `  ${word} `, number: 1 })).toBe('clueIsVisibleWord');
    let s = act(g, 'rs', { type: 'giveClue', word: '다른말', number: 1 });
    s = act(s, 'ro', { type: 'guess', index: BYSTANDER }); // 시민 → 턴 종료
    s = act(s, 'bs', { type: 'giveClue', word: '또다른', number: 1 });
    s = act(s, 'bo', { type: 'guess', index: 9 });
    s = act(s, 'bo', { type: 'endTurn' });
    // 이제 BYSTANDER 단어는 덮였다
    expect(act(s, 'rs', { type: 'giveClue', word, number: 1 }).currentClue?.word).toBe(word);
  });

  it('숫자는 0~9 또는 무제한', () => {
    const g = redStarts();
    expect(reject(g, 'rs', { type: 'giveClue', word: 'x', number: 10 })).toBe('badInput');
    expect(reject(g, 'rs', { type: 'giveClue', word: 'x', number: -1 })).toBe('badInput');
    expect(guessLimit(2)).toBe(3);
    expect(guessLimit(0)).toBeNull();
    expect(guessLimit('unlimited')).toBeNull();
  });
});

describe('p.4~5 접촉과 추측 수', () => {
  it('자기 요원이면 계속, 숫자+1 에서 턴 종료', () => {
    let s = act(redStarts(), 'rs', { type: 'giveClue', word: '나무', number: 2 });
    s = act(s, 'ro', { type: 'guess', index: RED[0] as number });
    expect(s.phase).toBe('guessing');
    s = act(s, 'ro2', { type: 'guess', index: RED[1] as number }); // 같은 팀 다른 추측자도 가능
    expect(s.phase).toBe('guessing');
    s = act(s, 'ro', { type: 'guess', index: RED[2] as number }); // 3번째 = 2+1
    expect(s.phase).toBe('awaitingClue');
    expect(s.turnTeam).toBe('blue');
    expect(s.log.at(-1)).toMatchObject({ kind: 'turnEnd', reason: 'maxGuesses' });
  });

  it('시민이면 턴 종료', () => {
    let s = act(redStarts(), 'rs', { type: 'giveClue', word: '나무', number: 3 });
    s = act(s, 'ro', { type: 'guess', index: BYSTANDER });
    expect(s.turnTeam).toBe('blue');
    expect(s.log.at(-1)).toMatchObject({ kind: 'turnEnd', reason: 'wrongGuess' });
  });

  it('상대 요원이면 턴 종료하고 상대 요원 수가 줄어든다', () => {
    let s = act(redStarts(), 'rs', { type: 'giveClue', word: '나무', number: 3 });
    s = act(s, 'ro', { type: 'guess', index: BLUE[0] as number });
    expect(s.turnTeam).toBe('blue');
    expect(s.revealed[BLUE[0] as number]?.identity).toBe('blue');
  });

  it('암살자면 즉시 패배', () => {
    let s = act(redStarts(), 'rs', { type: 'giveClue', word: '나무', number: 3 });
    s = act(s, 'ro', { type: 'guess', index: ASSASSIN });
    expect(s.phase).toBe('finished');
    expect(s.winner).toBe('blue');
    expect(s.endReason).toBe('assassin');
    expect(reject(s, 'bs', { type: 'giveClue', word: 'x', number: 1 })).toBe('gameOver');
  });

  it('최소 1회 추측해야 턴을 끝낼 수 있다', () => {
    let s = act(redStarts(), 'rs', { type: 'giveClue', word: '나무', number: 1 });
    expect(reject(s, 'ro', { type: 'endTurn' })).toBe('mustGuessOnce');
    s = act(s, 'ro', { type: 'guess', index: 0 });
    s = act(s, 'ro', { type: 'endTurn' });
    expect(s.turnTeam).toBe('blue');
  });

  it('다른 팀·스파이마스터·관전자는 추측할 수 없다', () => {
    const s = act(redStarts(), 'rs', { type: 'giveClue', word: '나무', number: 1 });
    expect(reject(s, 'bo', { type: 'guess', index: 0 })).toBe('notYourTurn');
    expect(reject(s, 'rs', { type: 'guess', index: 0 })).toBe('notYourTurn');
    expect(reject(s, 'spectator', { type: 'guess', index: 0 })).toBe('notYourTurn');
  });

  it('이미 공개된 카드는 다시 고를 수 없다', () => {
    let s = act(redStarts(), 'rs', { type: 'giveClue', word: '나무', number: 3 });
    s = act(s, 'ro', { type: 'guess', index: 0 });
    expect(reject(s, 'ro', { type: 'guess', index: 0 })).toBe('alreadyRevealed');
  });
});

describe('p.5 종료', () => {
  it('자기 요원을 모두 찾으면 승리', () => {
    let s = act(redStarts(), 'rs', { type: 'giveClue', word: '전부', number: 'unlimited' });
    for (const i of RED) s = act(s, 'ro', { type: 'guess', index: i });
    expect(s.phase).toBe('finished');
    expect(s.winner).toBe('red');
    expect(s.endReason).toBe('allAgentsFound');
  });

  it('상대의 마지막 요원을 찾아 주면 상대가 즉시 승리', () => {
    let s = redStarts();
    // 파랑 요원 7장을 먼저 덮어 둔다 (파랑 차례에 파랑이 찾음)
    s = act(s, 'rs', { type: 'giveClue', word: 'a', number: 1 });
    s = act(s, 'ro', { type: 'guess', index: BYSTANDER });
    s = act(s, 'bs', { type: 'giveClue', word: 'b', number: 0 });
    for (const i of BLUE.slice(0, 7)) s = act(s, 'bo', { type: 'guess', index: i });
    s = act(s, 'bo', { type: 'endTurn' });
    s = act(s, 'rs', { type: 'giveClue', word: 'c', number: 1 });
    s = act(s, 'ro', { type: 'guess', index: BLUE[7] as number });
    expect(s.phase).toBe('finished');
    expect(s.winner).toBe('blue');
  });

  it('0 과 무제한은 추측 상한이 없다 (p.7)', () => {
    for (const number of [0, 'unlimited'] as const) {
      let s = act(redStarts(), 'rs', { type: 'giveClue', word: '깃털', number });
      for (const i of RED.slice(0, 6)) s = act(s, 'ro', { type: 'guess', index: i });
      expect(s.phase).toBe('guessing');
      expect(s.guessesMade).toBe(6);
    }
  });

  it('선공 팀의 아홉 번째 덮개는 이중 요원이다', () => {
    let s = act(redStarts(), 'rs', { type: 'giveClue', word: '전부', number: 'unlimited' });
    for (const i of RED.slice(0, 8)) s = act(s, 'ro', { type: 'guess', index: i });
    expect(s.revealed.filter(Boolean).every((r) => r?.cover !== 'red:double')).toBe(true);
    s = act(s, 'ro', { type: 'guess', index: 8 });
    expect(s.revealed[8]?.cover).toBe('red:double');
  });
});

describe('p.5~6 잘못된 힌트', () => {
  function withClue() {
    return act(redStarts(), 'rs', { type: 'giveClue', word: '의심', number: 2 });
  }

  it('신고하면 새 카드 공개를 막고, 상대가 유효라고 하면 원래대로 돌아간다', () => {
    let s = act(withClue(), 'ro', { type: 'guess', index: 0 });
    s = act(s, 'bo', { type: 'reportInvalidClue' });
    expect(s.phase).toBe('clueDispute');
    expect(reject(s, 'ro', { type: 'guess', index: 1 })).toBe('wrongPhase');
    s = act(s, 'bs', { type: 'voteDispute', verdict: 'valid' });
    expect(s.phase).toBe('guessing');
    expect(s.guessesMade).toBe(1); // 기존 상태 복구
    expect(s.revealed[0]).not.toBeNull(); // 이미 공개된 카드는 되돌리지 않는다
  });

  it('두 스파이마스터가 모두 잘못됨이면 턴 종료 + 상대의 선택적 자기 요원 공개', () => {
    let s = act(withClue(), 'bs', { type: 'reportInvalidClue' });
    expect(s.dispute?.votes.blue).toBe('invalid');
    s = act(s, 'rs', { type: 'voteDispute', verdict: 'invalid' });
    expect(s.phase).toBe('penaltyResolution');
    expect(s.turnTeam).toBe('blue');
    expect(reject(s, 'rs', { type: 'penaltyCover', index: 9 })).toBe('forbidden');
    expect(reject(s, 'bs', { type: 'penaltyCover', index: 0 })).toBe('badInput'); // 상대 카드는 안 된다
    s = act(s, 'bs', { type: 'penaltyCover', index: 9 });
    expect(s.revealed[9]?.by).toBe('penalty');
    expect(s.phase).toBe('awaitingClue');
    expect(s.turnTeam).toBe('blue');
  });

  it('벌칙을 건너뛸 수 있다', () => {
    let s = act(withClue(), 'bs', { type: 'reportInvalidClue' });
    s = act(s, 'rs', { type: 'voteDispute', verdict: 'invalid' });
    s = act(s, 'bs', { type: 'penaltyCover', index: null });
    expect(s.phase).toBe('awaitingClue');
    expect(s.log.at(-1)).toMatchObject({ kind: 'penaltySkipped' });
  });

  it('벌칙 공개로 마지막 요원이 덮이면 즉시 승리', () => {
    let s = redStarts();
    s = act(s, 'rs', { type: 'giveClue', word: 'a', number: 1 });
    s = act(s, 'ro', { type: 'guess', index: BYSTANDER });
    s = act(s, 'bs', { type: 'giveClue', word: 'b', number: 0 });
    for (const i of BLUE.slice(0, 7)) s = act(s, 'bo', { type: 'guess', index: i });
    s = act(s, 'bo', { type: 'endTurn' });
    s = act(s, 'rs', { type: 'giveClue', word: '의심', number: 1 });
    s = act(s, 'bs', { type: 'reportInvalidClue' });
    s = act(s, 'rs', { type: 'voteDispute', verdict: 'invalid' });
    s = act(s, 'bs', { type: 'penaltyCover', index: BLUE[7] as number });
    expect(s.phase).toBe('finished');
    expect(s.winner).toBe('blue');
  });

  it('의견이 다르면 벌칙 없이 복구', () => {
    let s = act(withClue(), 'bs', { type: 'reportInvalidClue' });
    s = act(s, 'rs', { type: 'voteDispute', verdict: 'valid' });
    expect(s.phase).toBe('guessing');
    expect(s.log.at(-1)).toMatchObject({ kind: 'dispute', outcome: 'disagreement' });
  });

  it('신고자가 철회할 수 있고, 끝난 턴은 신고할 수 없다', () => {
    let s = act(withClue(), 'bo', { type: 'reportInvalidClue' });
    expect(reject(s, 'ro', { type: 'withdrawDispute' })).toBe('forbidden');
    s = act(s, 'bo', { type: 'withdrawDispute' });
    expect(s.phase).toBe('guessing');
    s = act(s, 'ro', { type: 'guess', index: BYSTANDER });
    expect(reject(s, 'bo', { type: 'reportInvalidClue' })).toBe('wrongPhase');
  });
});

describe('p.8 소인원 협력 (가상 상대)', () => {
  const roster: RosterEntry[] = [
    { memberId: 'cs', team: 'blue', role: 'spymaster' },
    { memberId: 'co', team: 'blue', role: 'operative' },
  ];
  const coop = () => game('cge2015-coop', roster, 'blue');
  // 파랑 선공: blue 0~8, red 9~16

  it('사람 팀이 선공이고, 턴이 끝나면 가상 상대 차례에 스파이마스터가 상대 요원 1장을 덮는다', () => {
    let s = coop();
    expect(s.startingTeam).toBe('blue');
    s = act(s, 'cs', { type: 'giveClue', word: 'a', number: 1 });
    s = act(s, 'co', { type: 'guess', index: 0 });
    s = act(s, 'co', { type: 'endTurn' });
    expect(s.phase).toBe('simulatedOpponentTurn');
    expect(reject(s, 'cs', { type: 'simulatedCover', index: 1 })).toBe('badInput'); // 자기 팀 카드는 안 된다
    expect(reject(s, 'co', { type: 'simulatedCover', index: 9 })).toBe('forbidden');
    s = act(s, 'cs', { type: 'simulatedCover', index: 9 });
    expect(s.phase).toBe('awaitingClue');
    expect(s.turnTeam).toBe('blue');
  });

  it('승리하면 점수 = 상대 더미에 남은 요원 수', () => {
    let s = coop();
    s = act(s, 'cs', { type: 'giveClue', word: 'a', number: 'unlimited' });
    for (let i = 0; i < 4; i++) s = act(s, 'co', { type: 'guess', index: i });
    s = act(s, 'co', { type: 'endTurn' });
    s = act(s, 'cs', { type: 'simulatedCover', index: 9 });
    s = act(s, 'cs', { type: 'giveClue', word: 'b', number: 'unlimited' });
    for (let i = 4; i < 9; i++) s = act(s, 'co', { type: 'guess', index: i });
    expect(s.phase).toBe('finished');
    expect(s.winner).toBe('blue');
    expect(s.coopScore).toBe(7);
  });

  it('상대 요원이 모두 덮이면 패배, 암살자도 패배', () => {
    let s = coop();
    for (let k = 0; k < 8; k++) {
      s = act(s, 'cs', { type: 'giveClue', word: `c${k}`, number: 1 });
      s = act(s, 'co', { type: 'guess', index: k < 7 ? 17 + k : 0 }); // 시민 7번, 마지막엔 자기 요원
      if (s.phase === 'finished') break;
      if (s.phase === 'guessing') s = act(s, 'co', { type: 'endTurn' });
      s = act(s, 'cs', { type: 'simulatedCover', index: 9 + k });
      if (s.phase === 'finished') break;
    }
    expect(s.phase).toBe('finished');
    expect(s.endReason).toBe('coopEnemyComplete');
    expect(s.coopScore).toBeNull();

    let t = coop();
    t = act(t, 'cs', { type: 'giveClue', word: 'x', number: 1 });
    t = act(t, 'co', { type: 'guess', index: ASSASSIN });
    expect(t.endReason).toBe('assassin');
    expect(t.winner).toBe('red');
  });

  it('신고 기능은 쓰지 않는다 (상대 스파이마스터 없음)', () => {
    const s = act(coop(), 'cs', { type: 'giveClue', word: 'a', number: 1 });
    expect(reject(s, 'co', { type: 'reportInvalidClue' })).toBe('notSupported');
  });
});

describe('p.8 3인 공용 추측자', () => {
  const roster: RosterEntry[] = [
    { memberId: 'rs', team: 'red', role: 'spymaster' },
    { memberId: 'bs', team: 'blue', role: 'spymaster' },
    { memberId: 'so', team: null, role: 'sharedOperative' },
  ];
  it('공용 추측자가 양쪽 팀을 위해 추측한다', () => {
    let s = redStarts('cge2015-shared-operative', roster);
    s = act(s, 'rs', { type: 'giveClue', word: 'a', number: 1 });
    s = act(s, 'so', { type: 'guess', index: 0 });
    s = act(s, 'so', { type: 'endTurn' });
    s = act(s, 'bs', { type: 'giveClue', word: 'b', number: 1 });
    s = act(s, 'so', { type: 'guess', index: 9 });
    expect(s.revealed[9]?.team).toBe('blue');
  });
});

describe('사전 문의·스파이마스터 교체', () => {
  it('사전 문의는 공개 revision 을 올리지 않는다', () => {
    const g = redStarts();
    const r = applyAction(g, 'rs', { type: 'spyQuery', draft: '나무꾼' }, 1);
    expect(r.ok && r.changed).toBe('spymasters');
    const s = r.ok ? r.state : g;
    expect(s.revision).toBe(g.revision);
    expect(reject(s, 'ro', { type: 'spyQueryAnswer', queryId: 1, answer: 'allow' })).toBe('forbidden');
    expect(reject(s, 'rs', { type: 'spyQueryAnswer', queryId: 1, answer: 'allow' })).toBe('forbidden');
    const t = act(s, 'bs', { type: 'spyQueryAnswer', queryId: 1, answer: 'allow' });
    expect(t.spyQueries[0]?.answer).toBe('allow');
  });

  it('정답을 본 사람은 다시 추측자가 될 수 없고, 전임 스파이마스터는 roster 에서 빠진다', () => {
    const g = redStarts();
    const s = act(g, 'rs', { type: 'replaceSpymaster', team: 'red', newMemberId: 'ro' });
    expect(s.roster.find((r) => r.memberId === 'ro')?.role).toBe('spymaster');
    expect(s.roster.find((r) => r.memberId === 'rs')).toBeUndefined();
    expect(s.sawKey).toContain('rs');
    expect(s.sawKey).toContain('ro');
    // 남은 추측자가 없으면 거절
    expect(reject(s, 'x', { type: 'replaceSpymaster', team: 'red', newMemberId: 'ro2' })).toBe('badInput');
  });
});
