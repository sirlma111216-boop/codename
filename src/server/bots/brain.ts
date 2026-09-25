// 봇의 판단. 입력은 그 봇의 자리로 projection 된 화면(GameView) 하나뿐이다.
// 추측자 봇의 화면에는 미공개 정체(key)가 없으므로, 사람 추측자처럼 힌트와 공개된 카드만 보고 고른다.
// 스파이마스터 봇만 key 를 본다 (사람 스파이마스터와 같은 정보).
// 모든 무작위는 seed 로 정해진다: 같은 상황이면 같은 판단을 해서 테스트·재시도에 안전하다.

import { createRng, type Rng } from '../../game/rng.ts';
import type { BotLevel } from '../../shared/bots.ts';
import type { CardView, ClueView, GameView, Team } from '../../shared/view.ts';
import { LEXICON, norm, type Lexicon } from './lexicon.ts';

export interface LevelParams {
  /** 한 힌트로 노릴 최대 단어 수 */
  maxTargets: number;
  /** 노리는 단어의 최소 연결 강도 */
  minScore: number;
  /** 노리는 단어와 상대·시민 단어 사이에 둘 여유 */
  margin: number;
  /** 암살자와 둘 여유 */
  assassinMargin: number;
  /** 같은 점수일 때 고르는 폭 */
  jitter: number;
  /** 한 개짜리 힌트만 줄 확률 */
  oneProb: number;
  /** 추측자의 해석 흔들림 */
  noise: number;
  /** 첫 추측 뒤, 이 점수보다 낮으면 멈춘다 */
  stopBelow: number;
  /** 지난 힌트의 남은 단어로 +1 추측을 할 최소 점수 (null = 안 함) */
  bonusMin: number | null;
  /** 상대 힌트와 가까운 단어를 피하는 정도 */
  avoidOpp: number;
}

export const LEVELS: Record<BotLevel, LevelParams> = {
  easy: { maxTargets: 2, minScore: 0.72, margin: 0.25, assassinMargin: 0.35, jitter: 0.3, oneProb: 0.5, noise: 0.22, stopBelow: 0.68, bonusMin: null, avoidOpp: 0 },
  normal: { maxTargets: 3, minScore: 0.66, margin: 0.15, assassinMargin: 0.28, jitter: 0.2, oneProb: 0, noise: 0.1, stopBelow: 0.55, bonusMin: 0.85, avoidOpp: 0.3 },
  hard: { maxTargets: 4, minScore: 0.45, margin: 0.1, assassinMargin: 0.2, jitter: 0.12, oneProb: 0, noise: 0.04, stopBelow: 0.45, bonusMin: 0.7, avoidOpp: 0.4 },
};

const other = (t: Team): Team => (t === 'red' ? 'blue' : 'red');
const HANGUL = /^[가-힣]{1,8}$/;
/** 사람에게 헷갈리는 힌트 (팀 색·게임 용어). 규칙 위반은 아니지만 봇은 쓰지 않는다. */
const BANNED = new Set(['빨강', '파랑', '빨간색', '파란색', '시민', '암살자', '요원', '스파이마스터', '추측자', '정답', '힌트', '카드']);
const LAST_RESORT = ['수수께끼', '이것저것', '물건', '생각'];

const open = (v: GameView): CardView[] => v.cards.filter((c) => !c.revealed);
const maxOf = (xs: number[]): number => (xs.length ? Math.max(...xs) : 0);
const gauss = (rng: Rng): number => rng.next() + rng.next() + rng.next() - 1.5;

/** 힌트가 판에 보이는 단어와 같거나 글자로 겹치는가. 사람의 판정 기준(p.6)보다 엄격하게 본다. */
export function clashesWithBoard(view: GameView, word: string): boolean {
  const c = norm(word);
  return open(view).some((card) => {
    const w = norm(card.word);
    return w === c || w.includes(c) || c.includes(w);
  });
}

/** 봇이 이 말을 힌트로 쓸 수 있는가 */
export function botCanUseClue(view: GameView, word: string, lex: Lexicon = LEXICON): boolean {
  const n = norm(word);
  return HANGUL.test(n) && !BANNED.has(n) && lex.clueWorthy(n) && !clashesWithBoard(view, n) && !view.clues.some((c) => norm(c.word) === n);
}

// ------------------------------------------------------------------ 스파이마스터

export interface ClueChoice {
  word: string;
  number: number;
  /** 노린 카드 위치 (게임이 끝나면 ‘봇의 의도’로 공개한다) */
  targets: number[];
}

export function chooseClue(view: GameView, level: BotLevel, seed: string, lex: Lexicon = LEXICON): ClueChoice {
  const P = LEVELS[level];
  const rng = createRng(`clue:${seed}`);
  const team = view.turnTeam;
  const cards = open(view);
  const own = cards.filter((c) => c.key === team);
  const opp = cards.filter((c) => c.key === other(team));
  const neu = cards.filter((c) => c.key === 'bystander');
  const ass = cards.filter((c) => c.key === 'assassin');
  const cap = rng.next() < P.oneProb ? 1 : P.maxTargets;

  type Best = { word: string; k: number; targets: number[]; util: number };
  const evaluate = (terms: Iterable<string>, limit: number, strict: boolean): Best | null => {
    let best: Best | null = null;
    for (const t of terms) {
      if (!botCanUseClue(view, t, lex)) continue;
      const so = own.map((c) => ({ i: c.index, s: lex.score(t, c.word) })).sort((a, b) => b.s - a.s);
      const dOpp = maxOf(opp.map((c) => lex.score(t, c.word)));
      const dNeu = maxOf(neu.map((c) => lex.score(t, c.word)));
      const dAss = maxOf(ass.map((c) => lex.score(t, c.word)));
      for (let k = 1; k <= Math.min(limit, so.length); k++) {
        const tk = (so[k - 1] as { s: number }).s;
        if (strict) {
          if (tk < P.minScore) break;
          if (tk - dOpp < P.margin || tk - dNeu < P.margin * 0.7 || tk - dAss < P.assassinMargin || dAss >= 0.6) break;
        } else if (tk < 0.5 || tk <= Math.max(dOpp, dNeu, dAss) + 0.02) {
          break;
        }
        const util = k + 0.6 * (tk - Math.max(dOpp, dNeu * 0.8)) + rng.next() * P.jitter;
        if (!best || util > best.util) best = { word: t, k, targets: so.slice(0, k).map((x) => x.i), util };
      }
    }
    return best;
  };

  const cands = new Set<string>();
  for (const c of own) for (const t of lex.clueCandidates(c.word)) cands.add(t);
  const best = evaluate(cands, cap, true) ?? evaluate(cands, 1, false) ?? evaluate(lex.allTerms(), 1, false);
  if (best) return { word: best.word, number: best.k, targets: best.targets };
  // 사전의 어떤 말도 쓸 수 없는 드문 경우: 판과 겹치지 않는 말로 1장만 (노린 단어 없음)
  const word = LAST_RESORT.find((w) => botCanUseClue(view, w)) ?? '수수께끼';
  return { word, number: 1, targets: [] };
}

// ------------------------------------------------------------------ 추측자

export interface Reading {
  clue: ClueView;
  /** 봇이 이 힌트를 아는 말로 읽었는가 */
  known: boolean;
  ranked: { index: number; word: string; score: number; raw: number }[];
}

export function readClue(view: GameView, level: BotLevel, seed: string, lex: Lexicon = LEXICON): Reading | null {
  const clue = view.currentClue;
  if (!clue) return null;
  const P = LEVELS[level];
  // 같은 힌트 동안은 같은 흔들림: 추측할 때마다 생각이 뒤집히지 않는다
  const rng = createRng(`read:${seed}:${clue.id}`);
  const oppClues = view.clues.filter((k) => k.team !== clue.team);
  const ranked = open(view)
    .map((card) => {
      const raw = lex.score(clue.word, card.word);
      const avoid = P.avoidOpp ? P.avoidOpp * maxOf(oppClues.map((o) => lex.score(o.word, card.word))) : 0;
      return { index: card.index, word: card.word, raw, score: raw + gauss(rng) * 2 * P.noise - avoid };
    })
    .sort((a, b) => b.score - a.score);
  return { clue, known: ranked.some((r) => r.raw >= 0.2), ranked };
}

/** 지난 힌트 중 아직 다 못 찾은 것과 가까운 카드 (+1 추측 후보) */
export function leftovers(view: GameView, team: Team, lex: Lexicon = LEXICON): { index: number; word: string; score: number }[] {
  const found = new Map<number, number>();
  let cur: number | null = null;
  for (const e of view.log) {
    if (e.kind === 'clue') cur = e.team === team ? e.clueId : null;
    else if (e.kind === 'turnEnd') cur = null;
    else if (e.kind === 'reveal' && e.by === 'guess' && cur !== null && e.team === team && e.identity === team) found.set(cur, (found.get(cur) ?? 0) + 1);
  }
  const best = new Map<number, { index: number; word: string; score: number }>();
  for (const k of view.clues) {
    if (k.team !== team || k.id === view.currentClue?.id || typeof k.number !== 'number' || k.number <= 0) continue;
    if (k.number - (found.get(k.id) ?? 0) <= 0) continue;
    for (const card of open(view)) {
      const s = lex.score(k.word, card.word);
      const prev = best.get(card.index);
      if (!prev || s > prev.score) best.set(card.index, { index: card.index, word: card.word, score: s });
    }
  }
  return [...best.values()].sort((a, b) => b.score - a.score);
}

export type GuessChoice = { kind: 'guess'; index: number } | { kind: 'stop' };

export function chooseGuess(view: GameView, level: BotLevel, seed: string, lex: Lexicon = LEXICON): GuessChoice {
  const P = LEVELS[level];
  const r = readClue(view, level, seed, lex);
  if (!r || !r.ranked.length) return { kind: 'stop' };
  const clue = r.clue;
  const top = r.ranked[0] as Reading['ranked'][number];
  const left = leftovers(view, clue.team, lex);
  const g = view.guessesMade;

  if (g === 0) {
    // 최소 한 번은 추측해야 한다 (p.4)
    if (!r.known || clue.number === 0) {
      const lb = left[0];
      if (lb && lb.score >= 0.6) return { kind: 'guess', index: lb.index };
      if (clue.number === 0) {
        // ‘0’ = 이 말과 관련된 우리 단어는 없다: 가장 먼 쪽에서 고른다
        return { kind: 'guess', index: (r.ranked.at(-1) as Reading['ranked'][number]).index };
      }
    }
    return { kind: 'guess', index: top.index };
  }
  if (!r.known || clue.number === 0) return { kind: 'stop' };
  const n = clue.number === 'unlimited' ? Infinity : clue.number;
  if (g < n) return top.score >= P.stopBelow ? { kind: 'guess', index: top.index } : { kind: 'stop' };
  // 숫자만큼 맞혔다: 지난 힌트의 남은 단어로 +1 (p.5)
  if (P.bonusMin !== null) {
    const lb = left.find((x) => x.score >= (P.bonusMin as number));
    if (lb) return { kind: 'guess', index: lb.index };
  }
  return { kind: 'stop' };
}

/** 추측자 봇이 팀 토론 채팅에 남기는 해석 */
export function adviceText(view: GameView, level: BotLevel, seed: string, lex: Lexicon = LEXICON): string | null {
  const r = readClue(view, level, seed, lex);
  if (!r) return null;
  const clue = r.clue;
  const num = clue.number === 'unlimited' ? '무제한' : String(clue.number);
  if (!r.known) return `‘${clue.word}’… 제가 아는 말이 아니에요. 짐작으로 골라야 해요.`;
  if (clue.number === 0) return `‘${clue.word}’ 0 → 이 말과 관련 없는 단어가 우리 편이에요. 지난 힌트를 다시 볼게요.`;
  const k = clue.number === 'unlimited' ? 3 : Math.min(3, Math.max(1, clue.number));
  const picks = r.ranked.filter((x) => x.score >= 0.3).slice(0, k).map((x) => x.word);
  if (!picks.length) return `‘${clue.word}’ ${num}… 딱 떠오르는 단어가 없어요.`;
  return `‘${clue.word}’ ${num} → ${picks.join(', ')} 쪽이 떠올라요.`;
}

// ------------------------------------------------------------------ 그 밖의 스파이마스터 일

/** 두 보드 단어의 가까움 (서로 헷갈리는 정도) */
const pairSim = (lex: Lexicon, a: string, b: string) => Math.max(lex.score(a, b), lex.score(b, a));

/** 협력 변형: 가상 상대의 요원 1장을 덮는다 (p.8). 우리 단어와 헷갈리는 상대 단어부터 치운다. */
export function chooseSimulatedCover(view: GameView, level: BotLevel, seed: string, lex: Lexicon = LEXICON): number | null {
  const coop = view.coopTeam;
  if (!coop) return null;
  const enemy = open(view).filter((c) => c.key === other(coop));
  if (!enemy.length) return null;
  const rng = createRng(`sim:${seed}`);
  if (level === 'easy') return (enemy[rng.int(enemy.length)] as CardView).index;
  const own = open(view).filter((c) => c.key === coop);
  let best = enemy[0] as CardView;
  let bestS = -1;
  for (const e of enemy) {
    const s = maxOf(own.map((o) => pairSim(lex, e.word, o.word))) + rng.next() * 0.05;
    if (s > bestS) {
      bestS = s;
      best = e;
    }
  }
  return best.index;
}

/** 잘못된 힌트 벌칙: 우리 요원 1장을 덮을 수 있다 (p.5). 다른 우리 단어와 잘 안 묶이는 단어부터. */
export function choosePenaltyCover(view: GameView, level: BotLevel, seed: string, lex: Lexicon = LEXICON): number | null {
  const team = view.penalty?.team;
  if (!team) return null;
  const own = open(view).filter((c) => c.key === team);
  if (!own.length) return null;
  const rng = createRng(`pen:${seed}`);
  if (level === 'easy') return (own[rng.int(own.length)] as CardView).index;
  let best = own[0] as CardView;
  let bestS = Infinity;
  for (const c of own) {
    const s = maxOf(own.filter((o) => o.index !== c.index).map((o) => pairSim(lex, c.word, o.word)));
    if (s < bestS) {
      bestS = s;
      best = c;
    }
  }
  return best.index;
}

/** 힌트 신고 판정: 판에 보이는 단어와 같거나 글자로 겹치면 ‘잘못됨’. 봇은 자기 팀 힌트도 같은 기준으로 판정한다. */
export function disputeVerdict(view: GameView): 'invalid' | 'valid' {
  const clue = view.clues.find((c) => c.id === view.dispute?.clueId);
  return clue && clashesWithBoard(view, clue.word) ? 'invalid' : 'valid';
}

/** 사전 문의 답: 같은 기준 */
export function queryAnswer(view: GameView, draft: string): 'allow' | 'disallow' {
  return clashesWithBoard(view, draft) ? 'disallow' : 'allow';
}
