// 봇의 연상 사전. content/bots/ko-associations.json 을 읽어 단어 사이의 가까움을 0~1 점수로 준다.
//  - 직접 연결: 단어의 연상 목록에 있다(앞쪽일수록 강하다), 같은 분류(동물·과일·나라…)에 든다,
//    또는 거꾸로 힌트 단어의 목록에 그 단어가 있다
//  - 겹치는 이웃: 두 단어가 드문 연상을 함께 가진다 (약한 연결. 흔한 말은 적게 친다)
//  - 글자 포함: 한쪽이 다른 쪽을 품고 있다 (예: '크리스마스이브' ↔ '크리스마스')
// 서버 전용이다. 판정(정답 여부)은 엔진이 하고, 이 점수는 봇의 ‘생각’에만 쓴다.

import raw from '../../../content/bots/ko-associations.json' with { type: 'json' };

export interface LexiconData {
  aliases: Record<string, string>;
  entries: Record<string, string[]>;
  categories?: Record<string, string[]>;
  /** 알아듣기만 하고 봇이 힌트로 쓰지 않는 말 (어색한 분류 이름) */
  noClue?: string[];
}

export const norm = (s: string): string => s.normalize('NFC').trim().toLocaleLowerCase('ko').replace(/\s+/g, '');

const SUFFIXES = ['색깔', '스러운', '같은', '적인', '색', '들', '적', '한'];

/** 순위(0부터) → 연결 강도. 첫째 1.0, 열째 약 0.66 */
export const linkWeight = (rank: number): number => Math.max(0.62, 1 - 0.038 * rank);
/** 같은 분류에 든 단어의 연결 강도 */
export const CATEGORY_WEIGHT = 0.84;

export class Lexicon {
  /** 단어 → (연상 → 강도) */
  private fwd = new Map<string, Map<string, number>>();
  /** 연상 → (단어 → 강도) */
  private rev = new Map<string, Map<string, number>>();
  private nbr = new Map<string, Set<string>>();
  private aliases = new Map<string, string>();
  private noClue = new Set<string>();

  constructor(data: LexiconData) {
    for (const [a, b] of Object.entries(data.aliases)) this.aliases.set(norm(a), norm(b));
    for (const t of data.noClue ?? []) this.noClue.add(norm(t));
    const link = (word: string, term: string, weight: number) => {
      if (!term || term === word) return;
      let m = this.fwd.get(word);
      if (!m) this.fwd.set(word, (m = new Map()));
      if ((m.get(term) ?? 0) >= weight) return;
      m.set(term, weight);
      let r = this.rev.get(term);
      if (!r) this.rev.set(term, (r = new Map()));
      r.set(word, weight);
    };
    for (const [word, list] of Object.entries(data.entries)) {
      const w = norm(word);
      if (!this.fwd.has(w)) this.fwd.set(w, new Map());
      list.forEach((t, i) => link(w, norm(t), linkWeight(i)));
    }
    for (const [cat, members] of Object.entries(data.categories ?? {})) {
      for (const m of members) link(norm(m), norm(cat), CATEGORY_WEIGHT);
    }
    const addNbr = (a: string, b: string) => {
      let s = this.nbr.get(a);
      if (!s) this.nbr.set(a, (s = new Set()));
      s.add(b);
    };
    for (const [w, m] of this.fwd) {
      for (const t of m.keys()) {
        addNbr(w, t);
        addNbr(t, w);
      }
    }
  }

  /** 사전에 목록이 있는 단어 (봇 스파이마스터가 힌트를 만들 수 있다) */
  hasEntry(word: string): boolean {
    return (this.fwd.get(norm(word))?.size ?? 0) > 0;
  }

  /** 봇이 힌트로 써도 자연스러운 말인가 */
  clueWorthy(term: string): boolean {
    return !this.noClue.has(norm(term));
  }

  /** 사전 어디에든 나오는 말 */
  known(term: string): boolean {
    const n = norm(term);
    return this.fwd.has(n) || this.rev.has(n);
  }

  /** 입력된 힌트를 사전의 표기로 맞춘다: 별칭 → 그대로 → 흔한 접미사를 뗀 형태 */
  canonical(term: string): string {
    const n = norm(term);
    const a = this.aliases.get(n) ?? n;
    if (this.known(a)) return a;
    for (const suf of SUFFIXES) {
      if (a.length > suf.length + 1 && a.endsWith(suf)) {
        const base = a.slice(0, -suf.length);
        const b = this.aliases.get(base) ?? base;
        if (this.known(b)) return b;
      }
    }
    return a;
  }

  /** 이 단어를 가리킬 수 있는 힌트 후보: 연상 목록·분류 + 이 단어를 목록에 둔 다른 단어 */
  clueCandidates(word: string): string[] {
    const w = norm(word);
    return [...(this.fwd.get(w)?.keys() ?? []), ...(this.rev.get(w)?.keys() ?? [])];
  }

  /** 사전 전체의 말 (힌트를 도저히 못 찾을 때의 마지막 후보) */
  allTerms(): string[] {
    return [...new Set([...this.fwd.keys(), ...this.rev.keys()])];
  }

  /** 힌트(또는 단어) c 와 보드 단어 w 의 가까움 0~1 */
  score(clue: string, word: string): number {
    const c = this.canonical(clue);
    const w = norm(word);
    if (!c || !w) return 0;
    if (c === w) return 1;
    let s = Math.max(this.fwd.get(w)?.get(c) ?? 0, this.fwd.get(c)?.get(w) ?? 0);
    if (c.length >= 2 && w.length >= 2 && (c.includes(w) || w.includes(c))) s = Math.max(s, 0.8);
    const nc = this.nbr.get(c);
    const nw = this.nbr.get(w);
    if (nc && nw) {
      // 드문 연상을 함께 가질수록 가깝다 (흔한 말은 약하게)
      let k = 0;
      for (const x of nc) if (nw.has(x)) k += 1 / Math.log2(1 + (this.nbr.get(x)?.size ?? 1));
      if (k) s = s >= 0.62 ? Math.min(1, s + Math.min(0.05, 0.02 * k)) : Math.max(s, Math.min(0.45, 0.2 * k));
    }
    // 사전에 없는 힌트: 연상 목록의 말과 글자가 겹치면 약하게 잇는다
    if (s === 0 && !this.known(c) && c.length >= 2) {
      for (const t of this.fwd.get(w)?.keys() ?? []) {
        if (t.length >= 2 && (c.includes(t) || t.includes(c))) {
          s = 0.5;
          break;
        }
      }
    }
    return s;
  }
}

export const LEXICON = new Lexicon(raw as LexiconData);

/** 봇 스파이마스터가 이 단어 목록을 모두 아는가 */
export function lexiconCovers(words: readonly string[], lex: Lexicon = LEXICON): boolean {
  return words.every((w) => lex.hasEntry(w));
}
