// 테스트 전용 합성 픽스처. 실제 단어·실제 키 배치가 아니다.
// 로컬/CI 단위 테스트에서만 쓰며 Worker 번들에는 들어가지 않는다 (content/registry.ts 에 없다).

import type { ContentPack, KeyCard, WordCard } from '../../src/game/content.ts';
import { createRng, shuffle } from '../../src/game/rng.ts';
import type { Identity, Team } from '../../src/game/types.ts';

export function syntheticCards(n: number, editionId = 'test-fixture'): WordCard[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `T${String(i + 1).padStart(3, '0')}`,
    faceA: `테스트앞${i + 1}`,
    faceB: `테스트뒤${i + 1}`,
    locale: 'ko-KR',
    editionId,
    sourceReference: 'synthetic test fixture',
  }));
}

export function syntheticKeys(n: number, editionId = 'test-fixture'): KeyCard[] {
  const rng = createRng('synthetic-keys');
  return Array.from({ length: n }, (_, i) => {
    const startingTeam: Team = i % 2 === 0 ? 'red' : 'blue';
    const other: Team = startingTeam === 'red' ? 'blue' : 'red';
    const grid: Identity[] = [
      ...Array<Identity>(9).fill(startingTeam),
      ...Array<Identity>(8).fill(other),
      ...Array<Identity>(7).fill('bystander'),
      'assassin',
    ];
    return { id: `K${String(i + 1).padStart(2, '0')}`, grid: shuffle(grid, rng), startingTeam, editionId, sourceReference: 'synthetic test fixture' };
  });
}

/** 정식 팩과 같은 모양의 합성 팩 (검증 완료로 표시되지만 테스트 전용) */
export function syntheticOfficialPack(): ContentPack {
  return {
    manifest: {
      schemaVersion: 1,
      packId: 'test-official-shape',
      editionId: 'test-fixture',
      language: 'ko-KR',
      title: '합성 테스트 데이터',
      kind: 'official',
      expectedCounts: { cards: 200, faces: 400, keys: 40 },
      sourceReferences: ['synthetic test fixture — not real game data'],
      validationStatus: 'verified',
      checksum: null,
    },
    cards: syntheticCards(200),
    keys: syntheticKeys(40),
  };
}

export function syntheticUnofficialPack(): ContentPack {
  return {
    manifest: {
      schemaVersion: 1,
      packId: 'test-unofficial',
      editionId: 'test-fixture',
      language: 'ko-KR',
      title: '합성 테스트 데이터',
      kind: 'testFixture',
      expectedCounts: { cards: 30, faces: 60, keys: 0 },
      sourceReferences: ['synthetic test fixture'],
      validationStatus: 'testOnly',
      checksum: null,
    },
    cards: syntheticCards(30),
    keys: [],
  };
}
