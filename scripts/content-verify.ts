// npm run content:verify [-- --write]
// 모든 콘텐츠 팩을 검사하고 정식 플레이 준비 상태를 보고한다. --write 면 docs/content-verify-report.md 를 갱신한다.
// 구조 오류가 있으면 종료 코드 1. 정식판 자료가 없는 것은 오류가 아니라 '미완료'로 보고한다.

import { writeFileSync } from 'node:fs';
import { isBoardPlayable, isOfficialPlayable, validatePack } from '../src/game/content.ts';
import { loadPackDir, packChecksum, packDirs, structuralIssues } from './content-lib.ts';

const write = process.argv.includes('--write');
const lines: string[] = [];
const say = (s = '') => {
  lines.push(s);
  console.log(s);
};

let hardErrors = 0;
let officialReady = false;

say('# 콘텐츠 검증 보고서');
say();
say(`생성: \`npm run content:verify -- --write\` (${new Date().toISOString().slice(0, 10)})`);
say();

for (const dir of packDirs()) {
  const pack = loadPackDir(dir);
  const m = pack.manifest;
  say(`## ${m?.packId ?? dir} — ${m?.title ?? '(manifest 없음)'}`);
  say();
  const struct = structuralIssues(pack);
  if (struct.length) {
    hardErrors += struct.length;
    for (const s of struct) say(`- ❌ 구조: ${s}`);
    say();
    continue;
  }
  const faces = pack.cards.reduce((n, c) => n + 1 + (c.faceB !== null ? 1 : 0), 0);
  const checksum = pack.cards.length || pack.keys.length ? packChecksum(pack) : null;
  say(`| 항목 | 값 | 기대값 |`);
  say(`|---|---|---|`);
  say(`| 종류 / 검증 상태 | ${m.kind} / ${m.validationStatus} | |`);
  say(`| 판본(editionId) | ${m.editionId} | |`);
  say(`| 단어 카드 | ${pack.cards.length} | ${m.expectedCounts.cards} |`);
  say(`| 단어 면 | ${faces} | ${m.expectedCounts.faces} |`);
  say(`| 키 카드 | ${pack.keys.length} | ${m.expectedCounts.keys} |`);
  say(`| 체크섬 | ${checksum ? checksum.slice(0, 16) + '…' : '(데이터 없음)'} | ${m.checksum ? m.checksum.slice(0, 16) + '…' : '(기록 없음)'} |`);
  say();
  if (m.checksum && checksum && m.checksum !== checksum) {
    hardErrors++;
    say('- ❌ manifest 의 체크섬과 데이터가 다릅니다. 데이터가 바뀌었다면 다시 대조한 뒤 `content:import` 로 갱신하세요.');
  }
  const issues = validatePack(pack);
  const errors = issues.filter((i) => i.level === 'error');
  const warnings = issues.filter((i) => i.level === 'warning');
  if (m.kind === 'official') {
    officialReady = isOfficialPlayable(pack);
    if (m.validationStatus === 'missing') {
      say('- ⏳ **정식 플레이 미완료**: 한국어 정식판 단어 카드와 원본 키 카드 자료가 아직 없습니다. 정식 모드는 시작할 수 없습니다.');
    } else {
      for (const e of errors) say(`- ❌ ${e.message}`);
      if (m.validationStatus !== 'verified') say('- ⏳ 사람이 실물과 대조한 뒤 validationStatus 를 verified 로 바꿔야 정식 모드가 열립니다.');
    }
  } else {
    for (const e of errors) say(`- ❌ ${e.message}`);
    hardErrors += errors.length;
  }
  for (const w of warnings) say(`- ⚠️ ${w.message}`);
  say(`- 게임 준비 가능: ${isBoardPlayable(pack) ? '예' : '아니오'}${m.kind !== 'official' ? ' (비공식 — 정체 배치는 원본 키가 아닌 무작위 배치)' : ''}`);
  say();
}

say('## 요약');
say();
say(`- 정식 모드(한국어 정식판 + 원본 키 카드): ${officialReady ? '사용 가능' : '**사용 불가 — 원본 콘텐츠 검증 미완료**'}`);
say(`- 구조 오류: ${hardErrors}건`);

if (write) writeFileSync('docs/content-verify-report.md', lines.join('\n') + '\n', 'utf8');
process.exit(hardErrors ? 1 : 0);
