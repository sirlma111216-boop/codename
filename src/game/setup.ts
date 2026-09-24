// 한 판 준비: 25장 선택·면 선택·키 선택/회전·선공 결정.
// 룰북 p.2~3 (Setup, The Key, Starting Team), p.5 (Setup for the Next Game), p.8 (협력 변형은 사람 팀이 선공).

import { isOfficialPlayable, type ContentPack, type KeyCard } from './content.ts';
import { createRng, shuffle, type Rng } from './rng.ts';
import { CLASSIC, CLASSIC_CELLS } from './rulesets.ts';
import {
  RULESET_VERSION,
  otherTeam,
  type GameState,
  type Identity,
  type RosterEntry,
  type RulesetId,
  type SetupRecord,
  type Team,
} from './types.ts';

export interface SetupOptions {
  gameId: string;
  rulesetId: RulesetId;
  pack: ContentPack;
  seed: string;
  roster: RosterEntry[];
  coopTeam: Team | null;
  now: number;
  /** 같은 25장을 뒤집어 다음 판을 한다 (p.5). 양면 카드 팩에서만 쓴다. */
  flipFrom?: SetupRecord['cards'] | null;
}

export type SetupResult = { ok: true; state: GameState } | { ok: false; message: string };

type Rotation = 0 | 90 | 180 | 270;

/** 5×5 격자를 시계 방향으로 회전한다. 거울 반전은 하지 않는다. */
export function rotateGrid<T>(grid: readonly T[], rotation: Rotation, size = CLASSIC.cols): T[] {
  let cur = grid.slice();
  const steps = rotation / 90;
  for (let s = 0; s < steps; s++) {
    const next: T[] = new Array(cur.length);
    for (let r = 0; r < size; r++) {
      for (let c = 0; c < size; c++) {
        // 시계 방향 90°: new[r][c] = old[size-1-c][r]
        next[r * size + c] = cur[(size - 1 - c) * size + r] as T;
      }
    }
    cur = next;
  }
  return cur;
}

function pickKey(keys: KeyCard[], rng: Rng, coopTeam: Team | null): { key: KeyCard; rotation: Rotation } | null {
  const candidates = coopTeam ? keys.filter((k) => k.startingTeam === coopTeam) : keys;
  if (!candidates.length) return null;
  const key = candidates[rng.int(candidates.length)] as KeyCard;
  const rotation = ([0, 90, 180, 270] as const)[rng.int(4)] as Rotation;
  return { key, rotation };
}

function randomLayout(startingTeam: Team, rng: Rng): Identity[] {
  const list: Identity[] = [];
  for (let i = 0; i < CLASSIC.startingTeamAgents; i++) list.push(startingTeam);
  for (let i = 0; i < CLASSIC.secondTeamAgents; i++) list.push(otherTeam(startingTeam));
  for (let i = 0; i < CLASSIC.bystanders; i++) list.push('bystander');
  for (let i = 0; i < CLASSIC.assassins; i++) list.push('assassin');
  return shuffle(list, rng);
}

export function createGame(o: SetupOptions): SetupResult {
  const rng = createRng(o.seed);
  const { pack } = o;
  const byId = new Map(pack.cards.map((c) => [c.id, c]));

  // ---- 25장과 면 선택
  let chosen: SetupRecord['cards'];
  const canFlip =
    o.flipFrom &&
    o.flipFrom.length === CLASSIC_CELLS &&
    o.flipFrom.every((c) => byId.get(c.cardId)?.faceB != null);
  if (canFlip && o.flipFrom) {
    chosen = o.flipFrom.map((c) => ({ cardId: c.cardId, face: c.face === 'A' ? 'B' : 'A' }));
  } else {
    if (pack.cards.length < CLASSIC_CELLS) return { ok: false, message: `단어 카드가 ${CLASSIC_CELLS}장 이상 필요합니다.` };
    // 서로 다른 카드 25장을 고르므로 한 카드의 양면이 같은 보드에 동시에 나오지 않는다.
    chosen = shuffle(pack.cards, rng)
      .slice(0, CLASSIC_CELLS)
      .map((c) => ({ cardId: c.id, face: c.faceB != null && rng.int(2) === 1 ? 'B' : 'A' }));
  }
  const words = chosen.map((c) => {
    const card = byId.get(c.cardId);
    if (!card) throw new Error('card missing');
    return (c.face === 'B' ? card.faceB : card.faceA) as string;
  });

  // ---- 키 (정식: 검증된 원본 키 + 0/90/180/270 회전, 그 밖: 무작위 배치)
  let identities: Identity[];
  let startingTeam: Team;
  let keySource: SetupRecord['keySource'];
  let keyId: string | null = null;
  let keyRotation: Rotation | null = null;
  if (pack.manifest.kind === 'official') {
    if (!isOfficialPlayable(pack)) return { ok: false, message: '정식 콘텐츠가 검증되지 않아 정식 모드를 시작할 수 없습니다.' };
    const picked = pickKey(pack.keys, rng, o.coopTeam);
    if (!picked) return { ok: false, message: '조건에 맞는 키 카드가 없습니다.' };
    identities = rotateGrid(picked.key.grid, picked.rotation);
    startingTeam = picked.key.startingTeam;
    keySource = 'officialKey';
    keyId = picked.key.id;
    keyRotation = picked.rotation;
  } else {
    startingTeam = o.coopTeam ?? (rng.int(2) === 0 ? 'red' : 'blue');
    identities = randomLayout(startingTeam, rng);
    keySource = 'randomLayout';
  }

  const state: GameState = {
    schemaVersion: 1,
    gameId: o.gameId,
    rulesetId: o.rulesetId,
    rulesetVersion: RULESET_VERSION,
    revision: 1,
    createdAt: o.now,
    setup: {
      packId: pack.manifest.packId,
      editionId: pack.manifest.editionId,
      contentKind: pack.manifest.kind,
      cards: chosen,
      keySource,
      keyId,
      keyRotation,
      seed: o.seed,
    },
    words,
    identities,
    revealed: new Array(CLASSIC_CELLS).fill(null),
    startingTeam,
    coopTeam: o.coopTeam,
    turnTeam: startingTeam,
    turnNumber: 1,
    phase: 'awaitingClue',
    currentClue: null,
    guessesMade: 0,
    clues: [],
    nextClueId: 1,
    dispute: null,
    penalty: null,
    spyQueries: [],
    nextQueryId: 1,
    roster: o.roster.map((r) => ({ ...r })),
    sawKey: o.roster.filter((r) => r.role === 'spymaster').map((r) => r.memberId),
    revealCount: 0,
    winner: null,
    endReason: null,
    coopScore: null,
    log: [{ seq: 1, at: o.now, kind: 'start', startingTeam }],
    nextLogSeq: 2,
  };
  return { ok: true, state };
}
