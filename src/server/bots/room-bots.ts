// 게임방 안의 봇 차례 관리 (순수 함수). room.ts 가 alarm 으로 불러 실행한다.
//  1. nextBotTask: 지금 봇이 해야 할 일이 있는가 (없으면 사람을 기다린다)
//  2. decideBotCommand: 그 봇의 자리로 projection 한 화면만 보고, 사람이 보내는 것과 같은 명령(Command)을 만든다
//  3. 명령은 room.ts 가 applyCommand 로 적용한다 — 사람과 같은 권한·차례·revision 검사를 거친다.

import { rosterEntry } from '../../game/engine.ts';
import { projectGame } from '../../game/projection.ts';
import { createRng } from '../../game/rng.ts';
import type { GameState, Team } from '../../game/types.ts';
import type { BotLevel, BotSpeed, BotTaskKind } from '../../shared/bots.ts';
import type { Command } from '../../shared/protocol.ts';
import type { RoomState } from '../room-logic.ts';
import { adviceText, chooseClue, chooseGuess, choosePenaltyCover, chooseSimulatedCover, disputeVerdict, queryAnswer } from './brain.ts';

export interface BotTask {
  kind: BotTaskKind;
  memberId: string;
  /** 같은 상황이면 같은 key. 상황이 바뀌면 예약을 새로 한다. */
  key: string;
}

const isBot = (room: RoomState, id: string | undefined) => !!id && !!room.members[id]?.bot;
const spymasterOf = (g: GameState, t: Team) => g.roster.find((r) => r.role === 'spymaster' && r.team === t)?.memberId;

/** 지금 봇이 할 일. 사람 추측자가 있는 팀에서는 봇이 카드를 고르지 않고 해석만 채팅으로 남긴다. */
export function nextBotTask(room: RoomState): BotTask | null {
  const g = room.game;
  if (!g || g.phase === 'finished') return null;
  const memo = room.botMemo?.gameId === g.gameId ? room.botMemo : null;
  const failed = new Set(memo?.failed ?? []);
  const task = (kind: BotTaskKind, memberId: string, key: string): BotTask | null => (failed.has(key) ? null : { kind, memberId, key });

  // 봇 스파이마스터에게 온 조용한 사전 문의 (공개 revision 과 별개)
  for (const q of g.spyQueries) {
    if (q.answer) continue;
    const who = spymasterOf(g, q.from === 'red' ? 'blue' : 'red');
    if (isBot(room, who)) {
      const t = task('answer', who as string, `${g.gameId}:q${q.id}`);
      if (t) return t;
    }
  }

  const k = (kind: string, id: string) => `${g.gameId}:${g.revision}:${kind}:${id}`;
  switch (g.phase) {
    case 'awaitingClue': {
      const sm = spymasterOf(g, g.turnTeam);
      return isBot(room, sm) ? task('clue', sm as string, k('clue', sm as string)) : null;
    }
    case 'guessing': {
      const guessers = g.roster.filter((r) => r.role === 'sharedOperative' || (r.role === 'operative' && r.team === g.turnTeam)).map((r) => r.memberId);
      const bots = guessers.filter((id) => isBot(room, id));
      const first = bots[0];
      if (!first) return null;
      const clueId = g.currentClue?.id ?? -1;
      if (!memo?.advised.includes(clueId)) {
        const t = task('advise', first, `${g.gameId}:advise:${clueId}`);
        if (t) return t;
      }
      // 사람 추측자가 있으면 결정은 사람이 한다
      if (guessers.some((id) => !isBot(room, id))) return null;
      return task('guess', first, k('guess', first));
    }
    case 'clueDispute': {
      for (const t of ['red', 'blue'] as Team[]) {
        if (g.dispute?.votes[t] !== null) continue;
        const sm = spymasterOf(g, t);
        if (isBot(room, sm)) {
          const x = task('vote', sm as string, k('vote', sm as string));
          if (x) return x;
        }
      }
      return null;
    }
    case 'penaltyResolution': {
      const sm = g.penalty ? spymasterOf(g, g.penalty.team) : undefined;
      return isBot(room, sm) ? task('penalty', sm as string, k('penalty', sm as string)) : null;
    }
    case 'simulatedOpponentTurn': {
      const sm = g.coopTeam ? spymasterOf(g, g.coopTeam) : undefined;
      return isBot(room, sm) ? task('simulate', sm as string, k('simulate', sm as string)) : null;
    }
    default:
      return null;
  }
}

/** 생각하는 시간 (ms). 사람이 따라올 수 있게 흩어 둔다. */
const DELAYS: Record<BotSpeed, Record<'clue' | 'first' | 'next' | 'advise' | 'other', [number, number]>> = {
  slow: { clue: [9000, 15000], first: [6000, 10000], next: [3500, 6000], advise: [2500, 4000], other: [3000, 5000] },
  normal: { clue: [4500, 8000], first: [3000, 5500], next: [1800, 3200], advise: [1500, 3000], other: [2000, 3500] },
  fast: { clue: [1200, 2000], first: [900, 1400], next: [700, 1100], advise: [600, 1000], other: [700, 1100] },
};

export function botDelayMs(room: RoomState, task: BotTask): number {
  const d = DELAYS[room.settings.botSpeed ?? 'normal'];
  const slot = task.kind === 'clue' ? d.clue : task.kind === 'guess' ? ((room.game?.guessesMade ?? 0) === 0 ? d.first : d.next) : task.kind === 'advise' ? d.advise : d.other;
  const r = createRng(`delay:${task.key}`).next();
  return Math.round(slot[0] + (slot[1] - slot[0]) * r);
}

export interface BotDecision {
  cmd: Command;
  /** 힌트를 줄 때 노린 카드 */
  intent?: number[];
  /** 해석을 남긴 힌트 */
  advisedClueId?: number;
}

/** 봇의 자리에서 본 화면으로만 결정한다. 봇의 추측자는 key 를 받지 못한다. */
export function decideBotCommand(room: RoomState, task: BotTask): BotDecision | null {
  const g = room.game;
  const bot = room.members[task.memberId];
  if (!g || !bot?.bot || !rosterEntry(g, bot.id)) return null;
  const level: BotLevel = bot.bot.level;
  const view = projectGame(g, bot.id, '');
  const seed = `${g.gameId}:${bot.id}`;
  const game = (action: Extract<Command, { type: 'game' }>['action']): Command => ({ type: 'game', action });

  switch (task.kind) {
    case 'clue': {
      const c = chooseClue(view, level, `${seed}:${g.turnNumber}`);
      return { cmd: game({ type: 'giveClue', word: c.word, number: c.number }), intent: c.targets };
    }
    case 'advise': {
      const text = adviceText(view, level, seed);
      const clueId = g.currentClue?.id ?? -1;
      return text ? { cmd: { type: 'chat', text }, advisedClueId: clueId } : null;
    }
    case 'guess': {
      const c = chooseGuess(view, level, seed);
      return { cmd: game(c.kind === 'guess' ? { type: 'guess', index: c.index } : { type: 'endTurn' }) };
    }
    case 'vote':
      return { cmd: game({ type: 'voteDispute', verdict: disputeVerdict(view) }) };
    case 'penalty':
      return { cmd: game({ type: 'penaltyCover', index: choosePenaltyCover(view, level, `${seed}:${g.revision}`) }) };
    case 'simulate': {
      const i = chooseSimulatedCover(view, level, `${seed}:${g.revision}`);
      return i === null ? null : { cmd: game({ type: 'simulatedCover', index: i }) };
    }
    case 'answer': {
      const team = view.me.team;
      const q = (view.spyQueries ?? []).find((x) => !x.answer && x.from !== team);
      return q ? { cmd: game({ type: 'spyQueryAnswer', queryId: q.id, answer: queryAnswer(view, q.draft) }) } : null;
    }
  }
}

/** 결정한 명령이 거절됐을 때의 안전한 대안 (게임이 멈추지 않게) */
export function fallbackBotCommand(room: RoomState, task: BotTask): Command | null {
  const g = room.game;
  if (!g) return null;
  const firstOpen = g.revealed.findIndex((r) => !r);
  if (task.kind === 'guess') {
    if (g.guessesMade >= 1) return { type: 'game', action: { type: 'endTurn' } };
    return firstOpen >= 0 ? { type: 'game', action: { type: 'guess', index: firstOpen } } : null;
  }
  if (task.kind === 'penalty') return { type: 'game', action: { type: 'penaltyCover', index: null } };
  if (task.kind === 'vote') return { type: 'game', action: { type: 'voteDispute', verdict: 'valid' } };
  return null;
}

/** 결정의 부수 기록(노린 카드·해석한 힌트)을 방 상태에 남긴다 */
export function recordBotDecision(room: RoomState, d: BotDecision, clueIdBefore: number | null) {
  const g = room.game;
  if (!g) return;
  if (!room.botMemo || room.botMemo.gameId !== g.gameId) room.botMemo = { gameId: g.gameId, advised: [], intents: [], failed: [] };
  if (d.advisedClueId !== undefined && !room.botMemo.advised.includes(d.advisedClueId)) room.botMemo.advised.push(d.advisedClueId);
  if (d.intent && clueIdBefore !== null) room.botMemo.intents.push({ clueId: clueIdBefore, targets: d.intent });
}

export function markBotFailed(room: RoomState, key: string) {
  const g = room.game;
  if (!g) return;
  if (!room.botMemo || room.botMemo.gameId !== g.gameId) room.botMemo = { gameId: g.gameId, advised: [], intents: [], failed: [] };
  if (!room.botMemo.failed.includes(key)) room.botMemo.failed = [...room.botMemo.failed, key].slice(-50);
}
