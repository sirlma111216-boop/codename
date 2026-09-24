// 서버용 콘텐츠 팩 목록. 이 파일은 Worker(서버)와 검증 스크립트만 import 한다.
// 키 카드 원본이 들어 있으므로 src/client 에서 import 하면 안 된다 (eslint no-restricted-imports).

import type { ContentManifest, ContentPack, KeyCard, WordCard } from '../src/game/content.ts';

import officialManifest from './packs/ko-official-classic/manifest.json' with { type: 'json' };
import officialCards from './packs/ko-official-classic/cards.json' with { type: 'json' };
import officialKeys from './packs/ko-official-classic/keys.json' with { type: 'json' };
import originalManifest from './packs/ko-original-v1/manifest.json' with { type: 'json' };
import originalCards from './packs/ko-original-v1/cards.json' with { type: 'json' };
import originalKeys from './packs/ko-original-v1/keys.json' with { type: 'json' };

const pack = (manifest: unknown, cards: unknown, keys: unknown): ContentPack => ({
  manifest: manifest as ContentManifest,
  cards: cards as WordCard[],
  keys: keys as KeyCard[],
});

/** 설치된 팩. 순서가 대기실 표시 순서다. */
export const INSTALLED_PACKS: readonly ContentPack[] = [
  pack(officialManifest, officialCards, officialKeys),
  pack(originalManifest, originalCards, originalKeys),
];

export const PACK_DIRS: Record<string, string> = {
  'ko-official-classic': 'content/packs/ko-official-classic',
  'ko-original-v1': 'content/packs/ko-original-v1',
};
