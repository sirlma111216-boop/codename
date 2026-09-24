// npm run content:import -- --pack ko-official-classic --cards 카드.csv [--keys 키.csv] [--source "대조 기록"]
//
// 카드 CSV: id,faceA,faceB,sourceReference   (faceB 를 비우면 한 면 카드)
// 키 CSV:   id,startingTeam,grid,sourceReference
//           grid 는 행 우선 25글자: R(빨강) B(파랑) N(시민) A(암살자). 예: content/examples/keys.example.csv
//
// 가져오기는 데이터를 JSON 으로 옮기고 검사할 뿐, '검증 완료'로 표시하지 않는다.
// 실물과 사람이 대조한 뒤 manifest.json 의 validationStatus 를 직접 verified 로 바꾸세요.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseKeyGrid, validatePack, type KeyCard, type WordCard } from '../src/game/content.ts';
import { loadPackDir, packChecksum, parseCsv, structuralIssues } from './content-lib.ts';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const packId = arg('pack');
const cardsPath = arg('cards');
const keysPath = arg('keys');
const source = arg('source');
if (!packId || (!cardsPath && !keysPath)) {
  console.error('사용법: npm run content:import -- --pack <packId> --cards <cards.csv> [--keys <keys.csv>] [--source "대조 기록"]');
  process.exit(2);
}
const dir = join('content/packs', packId);
const pack = loadPackDir(dir);
if (!pack.manifest) {
  console.error(`${dir}/manifest.json 이 없습니다. 먼저 manifest 를 만드세요 (content/schema/manifest.schema.json).`);
  process.exit(2);
}
const nfc = (s: string) => s.normalize('NFC').trim();

if (cardsPath) {
  const rows = parseCsv(readFileSync(cardsPath, 'utf8'));
  const header = rows.shift()?.map((h) => h.trim());
  if (header?.join(',') !== 'id,faceA,faceB,sourceReference') throw new Error('카드 CSV 머리글은 id,faceA,faceB,sourceReference 이어야 합니다.');
  pack.cards = rows.map((r): WordCard => ({
    id: nfc(r[0] ?? ''),
    faceA: nfc(r[1] ?? ''),
    faceB: r[2]?.trim() ? nfc(r[2]) : null,
    locale: pack.manifest.language,
    editionId: pack.manifest.editionId,
    sourceReference: nfc(r[3] ?? ''),
  }));
}

if (keysPath) {
  const rows = parseCsv(readFileSync(keysPath, 'utf8'));
  const header = rows.shift()?.map((h) => h.trim());
  if (header?.join(',') !== 'id,startingTeam,grid,sourceReference') throw new Error('키 CSV 머리글은 id,startingTeam,grid,sourceReference 이어야 합니다.');
  pack.keys = rows.map((r, i): KeyCard => {
    const grid = parseKeyGrid(r[2] ?? '');
    if (!grid) throw new Error(`키 ${i + 1}행: grid 는 R/B/N/A 25글자여야 합니다.`);
    const team = (r[1] ?? '').trim();
    if (team !== 'red' && team !== 'blue') throw new Error(`키 ${i + 1}행: startingTeam 은 red 또는 blue`);
    return { id: nfc(r[0] ?? ''), grid, startingTeam: team, editionId: pack.manifest.editionId, sourceReference: nfc(r[3] ?? '') };
  });
}

const struct = structuralIssues(pack);
const issues = validatePack(pack);
for (const s of struct) console.log('❌ 구조:', s);
for (const i of issues) console.log(i.level === 'error' ? '❌' : '⚠️', i.message);
if (struct.length) process.exit(1);

pack.manifest.checksum = packChecksum(pack);
if (source) pack.manifest.sourceReferences = [...pack.manifest.sourceReferences, source];
// 가져오기만으로는 검증 완료가 아니다.
if (pack.manifest.validationStatus === 'missing' || pack.manifest.validationStatus === 'verified') pack.manifest.validationStatus = 'unverified';

writeFileSync(join(dir, 'cards.json'), JSON.stringify(pack.cards, null, 2) + '\n', 'utf8');
writeFileSync(join(dir, 'keys.json'), JSON.stringify(pack.keys, null, 2) + '\n', 'utf8');
writeFileSync(join(dir, 'manifest.json'), JSON.stringify(pack.manifest, null, 2) + '\n', 'utf8');
console.log(`저장: 카드 ${pack.cards.length}장, 키 ${pack.keys.length}장, 상태 ${pack.manifest.validationStatus}. 대조 후 validationStatus 를 verified 로 바꾸고 npm run content:verify 를 실행하세요.`);
