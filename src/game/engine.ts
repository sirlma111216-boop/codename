// 규칙 엔진: 순수 함수. UI·Cloudflare API 와 독립적이다.
// 모든 판정(정답 여부, 남은 추측 횟수, 턴 종료, 승패)은 여기서만 한다.
// 각 분기 옆의 p.N 은 CGE 2015 영문 룰북 페이지다 (docs/rule-audit.md 참조).

import { normalizeWord } from './content.ts';
import { CLASSIC } from './rulesets.ts';
import { RULESETS } from './rulesets.ts';
import {
  otherTeam,
  type ClueNumber,
  type EndReason,
  type GameState,
  type LogEntry,
  type RevealInfo,
  type RosterEntry,
  type Team,
} from './types.ts';

export type GameAction =
  | { type: 'giveClue'; word: string; number: ClueNumber }
  | { type: 'guess'; index: number }
  | { type: 'endTurn' }
  | { type: 'reportInvalidClue' }
  | { type: 'voteDispute'; verdict: 'invalid' | 'valid' }
  | { type: 'withdrawDispute' }
  | { type: 'penaltyCover'; index: number | null }
  | { type: 'simulatedCover'; index: number }
  | { type: 'spyQuery'; draft: string }
  | { type: 'spyQueryAnswer'; queryId: number; answer: 'allow' | 'disallow' }
  | { type: 'replaceSpymaster'; team: Team; newMemberId: string }
  | { type: 'abort'; reason?: 'host' | 'classEnded' };

export type EngineErrorCode =
  | 'notYourTurn'
  | 'wrongPhase'
  | 'forbidden'
  | 'badInput'
  | 'alreadyRevealed'
  | 'clueIsVisibleWord'
  | 'mustGuessOnce'
  | 'notSupported'
  | 'gameOver';

export interface EngineError {
  code: EngineErrorCode;
  message: string;
}

export type EngineResult = { ok: true; state: GameState; changed: 'public' | 'spymasters' } | { ok: false; error: EngineError };

/** 비공개 채널(스파이마스터끼리 사전 문의)은 공개 revision 을 올리지 않는다. 추측자에게 존재조차 새지 않게 하기 위해서다. */
const PRIVATE_ACTIONS = new Set<GameAction['type']>(['spyQuery', 'spyQueryAnswer']);

export const CLUE_MAX_LENGTH = 30;
const SPY_QUERY_KEEP = 20;

const fail = (code: EngineErrorCode, message: string): EngineResult => ({ ok: false, error: { code, message } });

export function rosterEntry(state: GameState, memberId: string): RosterEntry | undefined {
  return state.roster.find((r) => r.memberId === memberId);
}

export function isSpymasterOf(state: GameState, memberId: string, team: Team): boolean {
  const r = rosterEntry(state, memberId);
  return !!r && r.role === 'spymaster' && r.team === team;
}

/** 이번 차례에 추측할 수 있는 사람인가 (공용 추측자는 양쪽 팀을 위해 추측한다, p.8) */
export function isGuesserNow(state: GameState, memberId: string): boolean {
  const r = rosterEntry(state, memberId);
  if (!r) return false;
  if (r.role === 'sharedOperative') return true;
  return r.role === 'operative' && r.team === state.turnTeam;
}

export function remainingAgents(state: GameState, team: Team): number {
  let n = 0;
  state.identities.forEach((id, i) => {
    if (id === team && !state.revealed[i]) n++;
  });
  return n;
}

/** 이번 힌트로 할 수 있는 최대 추측 수. null = 상한 없음 (0 또는 무제한, p.7) */
export function guessLimit(number: ClueNumber): number | null {
  if (number === 'unlimited' || number === 0) return null;
  return number + 1; // 숫자 + 1 (p.4~5)
}

type LogInput = LogEntry extends infer E ? (E extends unknown ? Omit<E, 'seq' | 'at'> : never) : never;

function pushLog(s: GameState, entry: LogInput, now: number) {
  s.log.push({ ...entry, seq: s.nextLogSeq++, at: now } as LogEntry);
}

function finish(s: GameState, winner: Team | null, reason: EndReason, now: number) {
  s.phase = 'finished';
  s.winner = winner;
  s.endReason = reason;
  s.dispute = null;
  s.penalty = null;
  if (s.coopTeam && reason === 'allAgentsFound' && winner === s.coopTeam) {
    // 점수 = 상대 더미에 남은 요원 카드 수 (p.8)
    s.coopScore = remainingAgents(s, otherTeam(s.coopTeam));
  }
  pushLog(s, { kind: 'finish', winner, reason }, now);
}

/** 카드 한 장을 공개하고 즉시 종료 여부를 판정한다. 게임이 끝났으면 true. */
function reveal(s: GameState, index: number, by: RevealInfo['by'], team: Team | null, now: number): boolean {
  const identity = s.identities[index];
  if (!identity) throw new Error('bad index');
  const sameBefore = s.revealed.filter((r) => r?.identity === identity).length;
  const cover =
    (identity === 'red' || identity === 'blue') && sameBefore === CLASSIC.secondTeamAgents
      ? `${identity}:double` // 선공 팀의 아홉 번째 덮개 = 이중 요원 (p.3)
      : `${identity}:${sameBefore}`;
  s.revealed[index] = { identity, cover, by, team, order: s.revealCount++ };
  pushLog(s, { kind: 'reveal', team, index, word: s.words[index] as string, identity, by }, now);

  if (identity === 'assassin') {
    // 암살자를 접촉한 팀이 진다 (p.4~5). 협력 변형에서는 패배 (p.8).
    const guessing = team ?? s.turnTeam;
    finish(s, s.coopTeam ? otherTeam(s.coopTeam) : otherTeam(guessing), 'assassin', now);
    return true;
  }
  if (identity === 'red' || identity === 'blue') {
    if (remainingAgents(s, identity) === 0) {
      if (s.coopTeam && identity !== s.coopTeam) {
        // 협력 변형: 상대 요원이 모두 덮이면 패배 (p.8)
        finish(s, identity, 'coopEnemyComplete', now);
      } else {
        // 그 팀의 마지막 단어가 덮이면 누구 차례였든 그 팀이 이긴다 (p.5)
        finish(s, identity, 'allAgentsFound', now);
      }
      return true;
    }
  }
  return false;
}

type TurnEndReason = Extract<LogEntry, { kind: 'turnEnd' }>['reason'];

function endTurn(s: GameState, reason: TurnEndReason, now: number) {
  pushLog(s, { kind: 'turnEnd', team: s.turnTeam, reason }, now);
  s.currentClue = null;
  s.guessesMade = 0;
  s.turnNumber++;
  if (s.coopTeam) {
    // 사람 팀의 차례가 끝나면 가상 상대의 차례 (p.8)
    s.turnTeam = otherTeam(s.coopTeam);
    s.phase = 'simulatedOpponentTurn';
    return;
  }
  s.turnTeam = otherTeam(s.turnTeam);
  s.phase = s.penalty ? 'penaltyResolution' : 'awaitingClue';
}

function checkIndex(s: GameState, index: number): EngineResult | null {
  if (!Number.isInteger(index) || index < 0 || index >= s.words.length) return fail('badInput', '잘못된 카드 위치입니다.');
  if (s.revealed[index]) return fail('alreadyRevealed', '이미 공개된 카드입니다.');
  return null;
}

export function sameWord(a: string, b: string): boolean {
  return normalizeWord(a).toLocaleLowerCase('ko') === normalizeWord(b).toLocaleLowerCase('ko');
}

export function applyAction(prev: GameState, actorId: string, action: GameAction, now: number): EngineResult {
  if (prev.phase === 'finished') return fail('gameOver', '게임이 끝났습니다.');
  const s: GameState = structuredClone(prev);
  const me = rosterEntry(s, actorId);
  const info = RULESETS[s.rulesetId];

  switch (action.type) {
    // ------------------------------------------------------------ 힌트 (p.4, p.6~7)
    case 'giveClue': {
      if (s.phase !== 'awaitingClue') return fail('wrongPhase', '지금은 힌트를 줄 차례가 아닙니다.');
      if (!isSpymasterOf(s, actorId, s.turnTeam)) return fail('notYourTurn', '이번 차례 팀의 스파이마스터만 힌트를 줄 수 있습니다.');
      const word = normalizeWord(action.word);
      if (!word || word.length > CLUE_MAX_LENGTH) return fail('badInput', `힌트는 1~${CLUE_MAX_LENGTH}자로 입력하세요.`);
      const n = action.number;
      if (n !== 'unlimited' && (!Number.isInteger(n) || n < 0 || n > CLASSIC.maxClueNumber)) return fail('badInput', '숫자는 0~9 또는 무제한만 쓸 수 있습니다.');
      // 보드에 보이는 단어 그대로는 힌트가 될 수 없다 (p.4). 형태 변화·합성어 부분은 사람이 판정한다.
      const clash = s.words.findIndex((w, i) => !s.revealed[i] && sameWord(w, word));
      if (clash >= 0) return fail('clueIsVisibleWord', '보드에 보이는 단어는 힌트로 쓸 수 없습니다.');
      const clue = { id: s.nextClueId++, team: s.turnTeam, word, number: n, givenBy: actorId, turn: s.turnNumber, at: now };
      s.currentClue = clue;
      s.clues.push(clue);
      s.guessesMade = 0;
      s.phase = 'guessing';
      pushLog(s, { kind: 'clue', team: clue.team, word, number: n, clueId: clue.id }, now);
      break;
    }

    // ------------------------------------------------------------ 접촉 (p.4~5)
    case 'guess': {
      if (s.phase !== 'guessing') return fail('wrongPhase', '지금은 추측할 수 없습니다.');
      if (!isGuesserNow(s, actorId)) return fail('notYourTurn', '이번 차례 팀의 추측자만 카드를 고를 수 있습니다.');
      const bad = checkIndex(s, action.index);
      if (bad) return bad;
      const team = s.turnTeam;
      const identity = s.identities[action.index];
      s.guessesMade++;
      if (reveal(s, action.index, 'guess', team, now)) break;
      if (identity === team) {
        const limit = s.currentClue ? guessLimit(s.currentClue.number) : null;
        if (limit !== null && s.guessesMade >= limit) endTurn(s, 'maxGuesses', now);
      } else {
        endTurn(s, 'wrongGuess', now); // 시민·상대 요원은 턴 종료
      }
      break;
    }

    case 'endTurn': {
      if (s.phase !== 'guessing') return fail('wrongPhase', '지금은 턴을 끝낼 수 없습니다.');
      if (!isGuesserNow(s, actorId)) return fail('notYourTurn', '이번 차례 팀의 추측자만 턴을 끝낼 수 있습니다.');
      if (s.guessesMade < 1) return fail('mustGuessOnce', '최소 한 번은 추측해야 합니다 (룰북 p.4).');
      endTurn(s, 'stopped', now);
      break;
    }

    // ------------------------------------------------------------ 잘못된 힌트 (p.5, p.6)
    case 'reportInvalidClue': {
      if (!info.supportsDispute) return fail('notSupported', '이 규칙 프로필에서는 힌트 신고를 쓰지 않습니다.');
      if (s.phase !== 'guessing' || !s.currentClue) {
        return fail('wrongPhase', '진행 중인 힌트에 대해서만 신고할 수 있습니다. 이미 끝난 턴은 앱에서 되돌리지 않습니다.');
      }
      if (!me) return fail('forbidden', '참가자만 신고할 수 있습니다.');
      s.dispute = { clueId: s.currentClue.id, reportedBy: actorId, votes: { red: null, blue: null }, at: now };
      if (me.role === 'spymaster' && me.team) s.dispute.votes[me.team] = 'invalid';
      s.phase = 'clueDispute';
      pushLog(s, { kind: 'dispute', clueId: s.currentClue.id, outcome: 'opened' }, now);
      resolveDisputeIfReady(s, now);
      break;
    }

    case 'voteDispute': {
      if (s.phase !== 'clueDispute' || !s.dispute) return fail('wrongPhase', '판정 중인 신고가 없습니다.');
      if (!me || me.role !== 'spymaster' || !me.team) return fail('forbidden', '두 스파이마스터만 판정할 수 있습니다.');
      s.dispute.votes[me.team] = action.verdict;
      resolveDisputeIfReady(s, now);
      break;
    }

    case 'withdrawDispute': {
      if (s.phase !== 'clueDispute' || !s.dispute) return fail('wrongPhase', '판정 중인 신고가 없습니다.');
      if (s.dispute.reportedBy !== actorId) return fail('forbidden', '신고한 사람만 철회할 수 있습니다.');
      pushLog(s, { kind: 'dispute', clueId: s.dispute.clueId, outcome: 'withdrawn' }, now);
      s.dispute = null;
      s.phase = 'guessing';
      break;
    }

    case 'penaltyCover': {
      if (s.phase !== 'penaltyResolution' || !s.penalty) return fail('wrongPhase', '벌칙 처리 중이 아닙니다.');
      const team = s.penalty.team;
      if (!isSpymasterOf(s, actorId, team)) return fail('forbidden', '상대 팀 스파이마스터만 벌칙 카드를 고를 수 있습니다.');
      if (action.index === null) {
        pushLog(s, { kind: 'penaltySkipped', team }, now);
      } else {
        const bad = checkIndex(s, action.index);
        if (bad) return bad;
        if (s.identities[action.index] !== team) return fail('badInput', '자기 팀 요원 카드만 덮을 수 있습니다.');
        if (reveal(s, action.index, 'penalty', team, now)) break; // 벌칙 공개로도 즉시 승리할 수 있다
      }
      s.penalty = null;
      s.phase = 'awaitingClue';
      break;
    }

    // ------------------------------------------------------------ 협력 변형의 가상 상대 차례 (p.8)
    case 'simulatedCover': {
      if (!s.coopTeam || s.phase !== 'simulatedOpponentTurn') return fail('wrongPhase', '가상 상대의 차례가 아닙니다.');
      if (!isSpymasterOf(s, actorId, s.coopTeam)) return fail('forbidden', '스파이마스터가 가상 상대의 요원을 고릅니다.');
      const enemy = otherTeam(s.coopTeam);
      const bad = checkIndex(s, action.index);
      if (bad) return bad;
      if (s.identities[action.index] !== enemy) return fail('badInput', '상대 팀 요원 카드를 골라야 합니다.');
      if (reveal(s, action.index, 'simulated', enemy, now)) break;
      s.turnTeam = s.coopTeam;
      s.turnNumber++;
      s.phase = 'awaitingClue';
      break;
    }

    // ------------------------------------------------------------ 스파이마스터끼리 조용한 사전 문의 (p.6)
    case 'spyQuery': {
      if (!info.supportsDispute) return fail('notSupported', '상대 스파이마스터가 없는 규칙입니다.');
      if (!me || me.role !== 'spymaster' || !me.team) return fail('forbidden', '스파이마스터만 문의할 수 있습니다.');
      const draft = normalizeWord(action.draft);
      if (!draft || draft.length > CLUE_MAX_LENGTH) return fail('badInput', `1~${CLUE_MAX_LENGTH}자로 입력하세요.`);
      s.spyQueries.push({ id: s.nextQueryId++, from: me.team, draft, answer: null, at: now });
      s.spyQueries = s.spyQueries.slice(-SPY_QUERY_KEEP);
      break;
    }

    case 'spyQueryAnswer': {
      const q = s.spyQueries.find((x) => x.id === action.queryId);
      if (!q) return fail('badInput', '문의를 찾을 수 없습니다.');
      if (!isSpymasterOf(s, actorId, otherTeam(q.from))) return fail('forbidden', '상대 스파이마스터만 답할 수 있습니다.');
      if (q.answer) return fail('badInput', '이미 답한 문의입니다.');
      q.answer = action.answer;
      break;
    }

    // ------------------------------------------------------------ 운영: 스파이마스터 교체 승인 (방장 전용, 서버가 권한 확인)
    case 'replaceSpymaster': {
      const cand = rosterEntry(s, action.newMemberId);
      if (!cand || cand.role !== 'operative' || cand.team !== action.team) return fail('badInput', '같은 팀 추측자만 스파이마스터로 승격할 수 있습니다.');
      if (s.sawKey.includes(cand.memberId)) return fail('forbidden', '이미 정답을 본 참가자입니다.');
      const remainingOps = s.roster.filter((r) => r.role === 'operative' && r.team === action.team && r.memberId !== cand.memberId);
      if (!remainingOps.length) return fail('badInput', '승격 뒤에도 그 팀에 추측자가 1명 이상 남아야 합니다.');
      // 전임 스파이마스터는 관전 상태로 남는다 (sawKey 에는 그대로 남는다).
      s.roster = s.roster.filter((r) => !(r.role === 'spymaster' && r.team === action.team));
      cand.role = 'spymaster';
      s.sawKey.push(cand.memberId);
      pushLog(s, { kind: 'spymasterReplaced', team: action.team }, now);
      break;
    }

    case 'abort': {
      finish(s, null, action.reason === 'classEnded' ? 'classEnded' : 'aborted', now);
      break;
    }

    default:
      return fail('badInput', '알 수 없는 행동입니다.');
  }

  const isPrivate = PRIVATE_ACTIONS.has(action.type);
  if (!isPrivate) s.revision = prev.revision + 1;
  return { ok: true, state: s, changed: isPrivate ? 'spymasters' : 'public' };
}

/**
 * 신고 판정. 불법 힌트 신고만으로 벌칙을 확정하지 않는다.
 *  - 상대 스파이마스터가 '유효'라고 하면 유효 (p.6 "If the opposing spymaster allows it, the clue is valid.")
 *  - 두 스파이마스터가 모두 '잘못됨'이면 턴 종료 + 상대의 선택적 자기 요원 1장 공개 (p.5)
 *  - 의견이 다르면 앱은 벌칙을 적용하지 않고 원래 상태로 되돌린다.
 */
function resolveDisputeIfReady(s: GameState, now: number) {
  const d = s.dispute;
  const clue = s.currentClue;
  if (!d || !clue) return;
  const giver = clue.team;
  const opp = otherTeam(giver);
  const restore = (outcome: 'rejected' | 'disagreement') => {
    pushLog(s, { kind: 'dispute', clueId: d.clueId, outcome }, now);
    s.dispute = null;
    s.phase = 'guessing';
  };
  if (d.votes[opp] === 'valid') return restore('rejected');
  if (d.votes[opp] === 'invalid' && d.votes[giver] === 'valid') return restore('disagreement');
  if (d.votes[opp] === 'invalid' && d.votes[giver] === 'invalid') {
    pushLog(s, { kind: 'dispute', clueId: d.clueId, outcome: 'upheld' }, now);
    s.dispute = null;
    s.penalty = { team: opp, clueId: d.clueId };
    endTurn(s, 'invalidClue', now);
  }
}
