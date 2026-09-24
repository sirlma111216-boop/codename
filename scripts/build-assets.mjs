// 제공된 원본 일러스트(PNG) → 서비스용 WebP + public/assets/manifest.json
// 사용법: npm run assets:build -- "<원본 폴더>"
// 원본은 저장소에 넣지 않는다(약 90MB). 파일명은 01-illustration-prompts.md 의 이름을 따른다.
// 원본 파일명 끝의 ".png.png" 같은 중복 확장자도 받아들인다.

import sharp from 'sharp';
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const src = process.argv[2];
if (!src || !existsSync(src)) {
  console.error('원본 폴더를 지정하세요: npm run assets:build -- "<폴더>"');
  process.exit(1);
}
const out = 'public/assets';
mkdirSync(out, { recursive: true });

const files = readdirSync(src);
const find = (name) => files.find((f) => f.toLowerCase().replace(/(\.png)+$/, '') === name);

// 쓰임별 규격. 배경은 원본(1672px)보다 키우지 않는다. 카드 덮개는 두 크기(srcset).
const SPECS = [
  // [이름, 쓰임, 폭 목록, 품질, 대체색, 투명 여부]
  ['title-desktop', '시작 화면 배경 (가로 16:9)', [1672], 78, '#111827'],
  ['title-mobile', '시작 화면 배경 (세로 9:16)', [941], 78, '#111827'],
  ['lobby', '대기실 배경 (가로)', [1672], 76, '#111827'],
  ['board-desktop', '게임판 배경 (가로)', [1672], 72, '#0f172a'],
  ['board-mobile', '게임판 배경 (세로)', [941], 72, '#0f172a'],
  ['word-card-front', '공통 단어 카드 바탕 (모든 카드 동일)', [480], 80, '#F2E5CC'],
  ['word-card-back', '공통 카드 뒷면 (셔플 연출)', [480], 80, '#111827'],
  ...Array.from({ length: 8 }, (_, i) => [`agent-red-0${i + 1}`, '빨강 요원 덮개', [384, 768], 80, '#B83A42']),
  ...Array.from({ length: 8 }, (_, i) => [`agent-blue-0${i + 1}`, '파랑 요원 덮개', [384, 768], 80, '#3269AA']),
  ['double-agent-red', '이중 요원 (빨강 면) — 선공 팀의 아홉 번째 덮개', [384, 768], 80, '#B83A42'],
  ['double-agent-blue', '이중 요원 (파랑 면) — 선공 팀의 아홉 번째 덮개', [384, 768], 80, '#3269AA'],
  ...Array.from({ length: 7 }, (_, i) => [`bystander-0${i + 1}`, '시민 덮개', [384, 768], 80, '#D9C7A3']),
  ['assassin', '암살자 덮개', [384, 768], 80, '#1f2937'],
  ['victory-red', '빨강 팀 승리 배경', [1672], 76, '#3b0d12'],
  ['victory-blue', '파랑 팀 승리 배경', [1672], 76, '#0d1f3b'],
  ['mission-ended', '암살자 접촉 종료 배경', [1672], 76, '#111111'],
  ['briefing-guide', '규칙 도움말 그림', [960], 78, '#111827'],
  ['reconnecting', '재접속 안내 (투명 배경)', [256], 85, '#111827', true],
  ['app-emblem', '앱 심벌 (투명 배경)', [256], 90, '#111827', true],
];

const manifest = { version: 1, theme: 'vintage-spy-v1', note: '파일을 같은 이름으로 교체하면 코드 수정 없이 반영된다. 그림은 장식이며 규칙·카드 수의 근거가 아니다.', images: {}, covers: {}, missing: [] };
let totalIn = 0;
let totalOut = 0;

for (const [name, usage, widths, quality, fallback, alpha] of SPECS) {
  const f = find(name);
  if (!f) {
    manifest.missing.push(name);
    manifest.images[name] = { file: null, usage, fallback };
    console.warn('없음:', name, '→ 단색 대체');
    continue;
  }
  const path = join(src, f);
  totalIn += statSync(path).size;
  const meta = await sharp(path).metadata();
  const variants = [];
  for (const w of widths) {
    const width = Math.min(w, meta.width);
    const file = widths.length > 1 ? `${name}-${width}.webp` : `${name}.webp`;
    // 앱 심벌은 투명 여백이 커서 화면용 파일만 여백을 잘라 낸다 (아이콘 PNG 는 여백 유지)
    const base = name === 'app-emblem' ? sharp(await sharp(path).trim().toBuffer()) : sharp(path);
    const img = base.resize({ width, withoutEnlargement: true });
    await img.webp({ quality, effort: 6, alphaQuality: alpha ? 90 : 100 }).toFile(join(out, file));
    const size = statSync(join(out, file)).size;
    totalOut += size;
    variants.push({ file, width });
  }
  const largest = variants[variants.length - 1];
  manifest.images[name] = {
    file: largest.file,
    srcset: variants.length > 1 ? variants : undefined,
    width: meta.width,
    height: meta.height,
    aspect: `${meta.width}:${meta.height}`,
    fallback,
    usage,
  };
}

// 앱 아이콘(PNG, 투명)
const emblem = find('app-emblem');
if (emblem) {
  for (const [file, size] of [['icon-192.png', 192], ['icon-512.png', 512], ['favicon-64.png', 64]]) {
    await sharp(join(src, emblem)).resize(size, size).png({ compressionLevel: 9, palette: true }).toFile(join(out, file));
    totalOut += statSync(join(out, file)).size;
  }
}

// 덮개 슬롯 → 그림. 엔진은 "red:3" 같은 슬롯만 정하고 그림 선택은 여기(ThemePack)가 한다.
manifest.covers = {
  red: Array.from({ length: 8 }, (_, i) => `agent-red-0${i + 1}`),
  blue: Array.from({ length: 8 }, (_, i) => `agent-blue-0${i + 1}`),
  redDouble: 'double-agent-red',
  blueDouble: 'double-agent-blue',
  bystander: Array.from({ length: 7 }, (_, i) => `bystander-0${i + 1}`),
  assassin: 'assassin',
};

writeFileSync(join(out, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(`원본 ${(totalIn / 1048576).toFixed(1)}MB → 서비스용 ${(totalOut / 1048576).toFixed(1)}MB`);
if (manifest.missing.length) console.log('누락(단색 대체):', manifest.missing.join(', '));
