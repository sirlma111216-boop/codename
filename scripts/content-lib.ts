// 콘텐츠 스크립트 공용 함수 (Node 전용)
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ContentManifest, ContentPack, KeyCard, WordCard } from '../src/game/content.ts';

export const PACKS_DIR = 'content/packs';

export function readJson<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback;
  const text = readFileSync(path, 'utf8');
  if (text.charCodeAt(0) === 0xfeff) throw new Error(`${path}: UTF-8 BOM 이 있습니다. BOM 없는 UTF-8 로 저장하세요.`);
  return JSON.parse(text) as T;
}

export function loadPackDir(dir: string): ContentPack {
  return {
    manifest: readJson<ContentManifest>(join(dir, 'manifest.json'), null as unknown as ContentManifest),
    cards: readJson<WordCard[]>(join(dir, 'cards.json'), []),
    keys: readJson<KeyCard[]>(join(dir, 'keys.json'), []),
  };
}

export function packDirs(): string[] {
  return readdirSync(PACKS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => join(PACKS_DIR, d.name))
    .sort();
}

/** 카드·키 데이터의 체크섬 (id 순 정렬 후 SHA-256) */
export function packChecksum(p: ContentPack): string {
  const cards = [...p.cards].sort((a, b) => a.id.localeCompare(b.id));
  const keys = [...p.keys].sort((a, b) => a.id.localeCompare(b.id));
  return createHash('sha256').update(JSON.stringify({ cards, keys })).digest('hex');
}

/** JSON Schema(content/schema)와 같은 구조 규칙을 직접 검사한다 (의존성 없이) */
export function structuralIssues(p: ContentPack): string[] {
  const out: string[] = [];
  const m = p.manifest as unknown as Record<string, unknown> | null;
  if (!m) return ['manifest.json 이 없습니다.'];
  for (const k of ['schemaVersion', 'packId', 'editionId', 'language', 'title', 'kind', 'expectedCounts', 'sourceReferences', 'validationStatus']) {
    if (!(k in m)) out.push(`manifest.${k} 가 없습니다.`);
  }
  if (typeof m.packId === 'string' && !/^[a-z0-9-]{3,64}$/.test(m.packId)) out.push('manifest.packId 형식이 틀립니다.');
  if (!['official', 'unofficialOriginal', 'custom', 'testFixture'].includes(String(m.kind))) out.push('manifest.kind 값이 틀립니다.');
  if (!['verified', 'unverified', 'missing', 'unofficial', 'testOnly'].includes(String(m.validationStatus))) out.push('manifest.validationStatus 값이 틀립니다.');
  if (!Array.isArray(p.cards)) out.push('cards.json 은 배열이어야 합니다.');
  else
    p.cards.forEach((c, i) => {
      if (typeof c.id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(c.id)) out.push(`cards[${i}].id 형식이 틀립니다.`);
      if (typeof c.faceA !== 'string' || !c.faceA || c.faceA.length > 40) out.push(`cards[${i}].faceA 가 비었거나 너무 깁니다.`);
      if (c.faceB !== null && (typeof c.faceB !== 'string' || !c.faceB || c.faceB.length > 40)) out.push(`cards[${i}].faceB 가 틀립니다.`);
      if (!c.sourceReference) out.push(`cards[${i}].sourceReference 가 없습니다.`);
    });
  if (!Array.isArray(p.keys)) out.push('keys.json 은 배열이어야 합니다.');
  else
    p.keys.forEach((k, i) => {
      if (!Array.isArray(k.grid) || k.grid.length !== 25) out.push(`keys[${i}].grid 는 25칸이어야 합니다.`);
      else if (k.grid.some((g) => !['red', 'blue', 'bystander', 'assassin'].includes(g))) out.push(`keys[${i}].grid 에 알 수 없는 정체가 있습니다.`);
      if (k.startingTeam !== 'red' && k.startingTeam !== 'blue') out.push(`keys[${i}].startingTeam 이 틀립니다.`);
      if (!k.sourceReference) out.push(`keys[${i}].sourceReference 가 없습니다.`);
    });
  return out;
}

/** 아주 작은 CSV 파서 (RFC 4180: 따옴표·쉼표·줄바꿈 처리) */
export function parseCsv(text: string): string[][] {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] as string;
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell);
      if (row.some((c) => c.trim())) rows.push(row);
      row = [];
      cell = '';
    } else cell += ch;
  }
  row.push(cell);
  if (row.some((c) => c.trim())) rows.push(row);
  return rows;
}
