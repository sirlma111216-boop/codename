// ViewProjection 경계: 역할별로 공개 가능한 정보만 만든다.
// 전체 객체를 보낸 뒤 CSS 로 가리는 방식은 쓰지 않는다. 추측자·관전자·방장에게는
// 미공개 정체, keyId, keyRotation, seed, 카드 id/면, 비공개 사전 문의를 아예 보내지 않는다.

import type { CardView, GameView } from '../shared/view.ts';
import { guessLimit, remainingAgents, rosterEntry } from './engine.ts';
import type { GameState } from './types.ts';

/**
 * opts.watchKey: 참가자가 모두 봇인 게임을 관전하는 사람에게 정답을 보여 준다.
 * 사람 참가자가 한 명이라도 있으면 호출하는 쪽(room-logic)이 켜지 않는다.
 */
export function projectGame(s: GameState, viewerId: string, packTitle: string, opts: { watchKey?: boolean } = {}): GameView {
  const me = rosterEntry(s, viewerId);
  const isSpymaster = me?.role === 'spymaster';
  const finished = s.phase === 'finished';
  const showKey = isSpymaster || finished || (!me && !!opts.watchKey);

  const cards: CardView[] = s.words.map((word, index) => {
    const r = s.revealed[index];
    const card: CardView = {
      index,
      word,
      revealed: r ? { identity: r.identity, cover: r.cover, by: r.by, order: r.order } : null,
    };
    if (showKey) card.key = s.identities[index];
    return card;
  });

  const view: GameView = {
    gameId: s.gameId,
    revision: s.revision,
    rulesetId: s.rulesetId,
    rulesetVersion: s.rulesetVersion,
    phase: s.phase,
    startingTeam: s.startingTeam,
    coopTeam: s.coopTeam,
    turnTeam: s.turnTeam,
    turnNumber: s.turnNumber,
    cards,
    currentClue: s.currentClue
      ? { id: s.currentClue.id, team: s.currentClue.team, word: s.currentClue.word, number: s.currentClue.number, turn: s.currentClue.turn }
      : null,
    guessesMade: s.guessesMade,
    guessLimit: s.currentClue ? guessLimit(s.currentClue.number) : null,
    remaining: { red: remainingAgents(s, 'red'), blue: remainingAgents(s, 'blue') },
    clues: s.clues.map((c) => ({ id: c.id, team: c.team, word: c.word, number: c.number, turn: c.turn })),
    log: s.log.slice(),
    dispute: s.dispute ? { clueId: s.dispute.clueId, reportedBy: s.dispute.reportedBy, votes: { ...s.dispute.votes } } : null,
    penalty: s.penalty ? { team: s.penalty.team } : null,
    winner: s.winner,
    endReason: s.endReason,
    coopScore: s.coopScore,
    roster: s.roster.map((r) => ({ memberId: r.memberId, team: r.team, role: r.role })),
    sawKey: s.sawKey.slice(),
    content: { packTitle, kind: s.setup.contentKind, keySource: s.setup.keySource },
    me: { role: me?.role ?? 'spectator', team: me?.team ?? null, canSeeKey: showKey },
  };
  if (isSpymaster) view.spyQueries = s.spyQueries.map((q) => ({ ...q }));
  return view;
}
