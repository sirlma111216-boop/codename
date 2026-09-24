// 준비(p.2~3, p.5)와 역할별 정보 분리 검증
import { describe, expect, it } from 'vitest';
import { validatePack, isOfficialPlayable } from '../../src/game/content.ts';
import { applyAction } from '../../src/game/engine.ts';
import { projectGame } from '../../src/game/projection.ts';
import { createGame, rotateGrid } from '../../src/game/setup.ts';
import type { GameState, RosterEntry } from '../../src/game/types.ts';
import { INSTALLED_PACKS } from '../../content/registry.ts';
import { syntheticOfficialPack, syntheticUnofficialPack } from '../fixtures/test-pack.ts';

const ROSTER: RosterEntry[] = [
  { memberId: 'rs', team: 'red', role: 'spymaster' },
  { memberId: 'ro', team: 'red', role: 'operative' },
  { memberId: 'bs', team: 'blue', role: 'spymaster' },
  { memberId: 'bo', team: 'blue', role: 'operative' },
];

function make(seed: string, pack = syntheticOfficialPack(), coopTeam: 'red' | 'blue' | null = null, flipFrom: GameState['setup']['cards'] | null = null) {
  const r = createGame({ gameId: 'g', rulesetId: coopTeam ? 'cge2015-coop' : 'cge2015-standard', pack, seed, roster: ROSTER, coopTeam, now: 1, flipFrom });
  if (!r.ok) throw new Error(r.message);
  return r.state;
}

describe('준비 (p.2~3)', () => {
  it('서로 다른 카드 25장, 카드마다 한 면만, 양면이 같은 보드에 동시에 나오지 않는다', () => {
    for (let i = 0; i < 30; i++) {
      const s = make(`s${i}`);
      const ids = s.setup.cards.map((c) => c.cardId);
      expect(new Set(ids).size).toBe(25);
      expect(new Set(s.words).size).toBe(25);
    }
  });

  it('정체 수: 선공 9, 후공 8, 시민 7, 암살자 1', () => {
    for (const pack of [syntheticOfficialPack(), syntheticUnofficialPack()]) {
      for (let i = 0; i < 20; i++) {
        const s = make(`c${i}`, pack);
        const count = (x: string) => s.identities.filter((v) => v === x).length;
        const other = s.startingTeam === 'red' ? 'blue' : 'red';
        expect(count(s.startingTeam)).toBe(9);
        expect(count(other)).toBe(8);
        expect(count('bystander')).toBe(7);
        expect(count('assassin')).toBe(1);
        expect(s.turnTeam).toBe(s.startingTeam);
      }
    }
  });

  it('정식 모드: 검증된 키를 0/90/180/270 회전만 적용해 쓴다 (거울 반전 없음)', () => {
    const pack = syntheticOfficialPack();
    const rotations = new Set<number>();
    for (let i = 0; i < 40; i++) {
      const s = make(`k${i}`, pack);
      expect(s.setup.keySource).toBe('officialKey');
      const key = pack.keys.find((k) => k.id === s.setup.keyId);
      expect(key).toBeDefined();
      rotations.add(s.setup.keyRotation as number);
      expect(s.identities).toEqual(rotateGrid(key!.grid, s.setup.keyRotation as 0 | 90 | 180 | 270));
      expect(s.startingTeam).toBe(key!.startingTeam);
    }
    expect([...rotations].sort()).toEqual([0, 180, 270, 90].sort());
  });

  it('회전: 시계 방향 90° 는 왼쪽 위 → 오른쪽 위, 네 번이면 원래대로', () => {
    const g = Array.from({ length: 25 }, (_, i) => i);
    const r90 = rotateGrid(g, 90);
    expect(r90[4]).toBe(0); // 원래 (0,0) 이 (0,4) 로
    expect(r90[0]).toBe(20); // 원래 (4,0) 이 (0,0) 으로
    expect(rotateGrid(rotateGrid(g, 90), 270)).toEqual(g);
    expect(rotateGrid(g, 180)).toEqual(g.slice().reverse());
  });

  it('협력 변형: 사람 팀이 선공인 키만 고른다 (p.8)', () => {
    for (let i = 0; i < 20; i++) {
      expect(make(`co${i}`, syntheticOfficialPack(), 'blue').startingTeam).toBe('blue');
      expect(make(`co${i}`, syntheticUnofficialPack(), 'red').startingTeam).toBe('red');
    }
  });

  it('다음 판: 같은 25장을 뒤집어 반대 면을 쓴다 (p.5)', () => {
    const pack = syntheticOfficialPack();
    const first = make('first', pack);
    const next = make('next', pack, null, first.setup.cards);
    first.setup.cards.forEach((c, i) => {
      expect(next.setup.cards[i]?.cardId).toBe(c.cardId);
      expect(next.setup.cards[i]?.face).not.toBe(c.face);
    });
    expect(next.words.some((w, i) => w === first.words[i])).toBe(false);
  });

  it('검증되지 않은 정식 팩으로는 시작할 수 없다', () => {
    const pack = syntheticOfficialPack();
    pack.manifest.validationStatus = 'unverified';
    expect(isOfficialPlayable(pack)).toBe(false);
    const r = createGame({ gameId: 'g', rulesetId: 'cge2015-standard', pack, seed: 'x', roster: ROSTER, coopTeam: null, now: 1 });
    expect(r.ok).toBe(false);
  });
});

describe('설치된 콘텐츠 팩', () => {
  it('한국어 정식판은 자료 미확보 상태로 정식 모드가 막혀 있다', () => {
    const official = INSTALLED_PACKS.find((p) => p.manifest.kind === 'official');
    expect(official?.manifest.validationStatus).toBe('missing');
    expect(official && isOfficialPlayable(official)).toBe(false);
  });

  it('자체 제작 비공식 팩은 200장/400단어이며 오류가 없고, 원본 키가 없다', () => {
    const p = INSTALLED_PACKS.find((x) => x.manifest.packId === 'ko-original-v1');
    expect(p?.cards.length).toBe(200);
    expect(p?.keys.length).toBe(0);
    expect(p?.manifest.validationStatus).toBe('unofficial');
    expect(validatePack(p!).filter((i) => i.level === 'error')).toEqual([]);
  });
});

describe('역할별 정보 분리 (ViewProjection)', () => {
  const s = make('proj');
  const secrets = [s.setup.seed, s.setup.keyId as string, ...s.setup.cards.map((c) => c.cardId)];

  it('추측자·관전자에게는 미공개 정체·키 id·회전·seed·카드 id 를 보내지 않는다', () => {
    for (const viewer of ['ro', 'bo', 'spectator-x']) {
      const v = projectGame(s, viewer, 't');
      expect(v.cards.every((c) => c.key === undefined)).toBe(true);
      expect(v.spyQueries).toBeUndefined();
      const json = JSON.stringify(v);
      for (const secret of secrets) expect(json).not.toContain(secret);
      expect(json).not.toContain('keyRotation');
      expect(json).not.toContain('"identities"');
      expect(json).not.toContain('bystander'); // 아직 공개된 시민이 없다
      expect(json).not.toContain('assassin');
    }
  });

  it('두 스파이마스터는 전체 키를 본다', () => {
    const v = projectGame(s, 'rs', 't');
    expect(v.cards.map((c) => c.key)).toEqual(s.identities);
    expect(v.spyQueries).toEqual([]);
    const json = JSON.stringify(v);
    expect(json).not.toContain(s.setup.seed);
    expect(json).not.toContain(s.setup.keyId as string);
  });

  it('공개된 카드만 정체가 보이고, 종료 후에는 전체가 공개된다', () => {
    let g = applyAction(s, s.startingTeam === 'red' ? 'rs' : 'bs', { type: 'giveClue', word: '힌트', number: 1 }, 2);
    if (!g.ok) throw new Error();
    const guesser = s.startingTeam === 'red' ? 'ro' : 'bo';
    const idx = s.identities.findIndex((x) => x === 'assassin');
    g = applyAction(g.state, guesser, { type: 'guess', index: idx }, 3);
    if (!g.ok) throw new Error();
    const v = projectGame(g.state, 'spectator', 't');
    expect(v.phase).toBe('finished');
    expect(v.cards.map((c) => c.key)).toEqual(s.identities);
  });
});
