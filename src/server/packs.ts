// 대기실에 보여 줄 단어 팩 선택지와, 게임 시작 때 쓸 ContentPack 을 만든다.
// GameModeRegistry 역할: 설치·검증된 것만 선택 가능하게 표시한다.

import { INSTALLED_PACKS } from '../../content/registry.ts';
import { isBoardPlayable, isOfficialPlayable, type ContentPack } from '../game/content.ts';
import type { PackOption } from '../shared/view.ts';

export const CUSTOM_PACK_ID = 'custom';
export const DEFAULT_PACK_ID = 'ko-original-v1';

function statusLabel(p: ContentPack): string {
  switch (p.manifest.validationStatus) {
    case 'verified':
      return '검증 완료';
    case 'missing':
      return '자료 미확보';
    case 'unverified':
      return '검증 전';
    case 'unofficial':
      return '비공식';
    case 'testOnly':
      return '테스트 데이터';
  }
}

export function customPack(words: string[]): ContentPack {
  return {
    manifest: {
      schemaVersion: 1,
      packId: CUSTOM_PACK_ID,
      editionId: 'custom',
      language: 'ko-KR',
      title: '직접 입력한 단어 (비공식)',
      kind: 'custom',
      expectedCounts: { cards: words.length, faces: words.length, keys: 0 },
      sourceReferences: ['방장이 이 방에서 입력한 단어'],
      validationStatus: 'unofficial',
      checksum: null,
    },
    cards: words.map((w, i) => ({
      id: `custom-${i + 1}`,
      faceA: w,
      faceB: null,
      locale: 'ko-KR',
      editionId: 'custom',
      sourceReference: 'room host input',
    })),
    keys: [],
  };
}

export function resolvePack(packId: string, customWords: string[]): ContentPack | null {
  if (packId === CUSTOM_PACK_ID) return customPack(customWords);
  return INSTALLED_PACKS.find((p) => p.manifest.packId === packId) ?? null;
}

export function packTitle(packId: string): string {
  if (packId === CUSTOM_PACK_ID) return '직접 입력한 단어 (비공식)';
  return INSTALLED_PACKS.find((p) => p.manifest.packId === packId)?.manifest.title ?? packId;
}

export function packOptions(customWords: string[]): PackOption[] {
  const list: PackOption[] = INSTALLED_PACKS.map((p) => {
    const official = p.manifest.kind === 'official';
    const playable = isBoardPlayable(p);
    let reason: string | null = null;
    if (!playable) {
      reason = official
        ? '한국어 정식판 단어(200장·400단어)와 원본 키 카드 40장이 아직 확보·검증되지 않아 정식 모드를 시작할 수 없습니다.'
        : '이 팩은 검증을 통과하지 못했습니다.';
    }
    return {
      packId: p.manifest.packId,
      title: p.manifest.title,
      kind: p.manifest.kind,
      status: statusLabel(p),
      playable,
      reason,
      cardCount: p.cards.length,
      keyLabel: official && isOfficialPlayable(p) ? '원본 키 카드 (0/90/180/270° 회전)' : official ? '원본 키 카드 40장 (미확보)' : '무작위 배치 (원본 키 카드 아님)',
    };
  });
  const n = customWords.length;
  list.push({
    packId: CUSTOM_PACK_ID,
    title: '직접 입력한 단어 (비공식)',
    kind: 'custom',
    status: `${n}개 입력됨`,
    playable: n >= 25,
    reason: n >= 25 ? null : '서로 다른 단어를 25개 이상 입력해야 합니다.',
    cardCount: n,
    keyLabel: '무작위 배치 (원본 키 카드 아님)',
  });
  return list;
}
