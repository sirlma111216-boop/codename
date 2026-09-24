// ContentPack 경계: 단어 카드·키 카드·출처·검증 상태.
// 이 모듈은 서버와 검증 스크립트가 함께 쓴다. 키 카드 원본은 절대 클라이언트 번들로 가지 않는다
// (src/client 는 이 파일을 import 하지 않는다 — eslint 규칙으로 막는다).

import type { ContentKind, Identity, Team } from './types.ts';

export const CONTENT_SCHEMA_VERSION = 1;

export interface WordCard {
  /** 안정적인 id. 게임 기록·재경기(반대 면)에서 이 값으로 카드를 찾는다. */
  id: string;
  faceA: string;
  /** 단면 카드(사용자 입력 단어)는 null */
  faceB: string | null;
  locale: string;
  editionId: string;
  sourceReference: string;
}

export interface KeyCard {
  id: string;
  /** 행 우선 25칸. 회전 전 기준 방향. */
  grid: Identity[];
  startingTeam: Team;
  editionId: string;
  sourceReference: string;
}

export type ValidationStatus = 'verified' | 'unverified' | 'missing' | 'unofficial' | 'testOnly';

export interface ContentManifest {
  schemaVersion: number;
  packId: string;
  editionId: string;
  language: string;
  title: string;
  kind: ContentKind;
  expectedCounts: { cards: number; faces: number; keys: number };
  sourceReferences: string[];
  validationStatus: ValidationStatus;
  /** cards/keys 데이터의 SHA-256 (content:verify 가 계산해 기록) */
  checksum: string | null;
  notes?: string;
}

export interface ContentPack {
  manifest: ContentManifest;
  cards: WordCard[];
  keys: KeyCard[];
}

/** 기본판 키 카드 한 장이 가져야 할 정체 수 (룰북 p.2~3) */
export function expectedKeyCounts(startingTeam: Team): Record<Identity, number> {
  return {
    red: startingTeam === 'red' ? 9 : 8,
    blue: startingTeam === 'blue' ? 9 : 8,
    bystander: 7,
    assassin: 1,
  };
}

export const KEY_LETTER: Record<string, Identity> = { R: 'red', B: 'blue', N: 'bystander', A: 'assassin' };

export function parseKeyGrid(s: string): Identity[] | null {
  const clean = s.replace(/\s+/g, '').toUpperCase();
  if (clean.length !== 25) return null;
  const out: Identity[] = [];
  for (const ch of clean) {
    const id = KEY_LETTER[ch];
    if (!id) return null;
    out.push(id);
  }
  return out;
}

export interface PackIssue {
  level: 'error' | 'warning';
  message: string;
}

export function normalizeWord(w: string): string {
  return w.normalize('NFC').trim().replace(/\s+/g, ' ');
}

/**
 * 콘텐츠 팩 검증. 원본에서 실제 중복이 확인되더라도 임의로 삭제하지 않고 경고로 보고한다.
 */
export function validatePack(pack: ContentPack): PackIssue[] {
  const issues: PackIssue[] = [];
  const m = pack.manifest;
  const err = (message: string) => issues.push({ level: 'error', message });
  const warn = (message: string) => issues.push({ level: 'warning', message });

  if (m.schemaVersion !== CONTENT_SCHEMA_VERSION) err(`schemaVersion ${m.schemaVersion} 은 지원하지 않습니다 (기대값 ${CONTENT_SCHEMA_VERSION}).`);

  const ids = new Set<string>();
  const faceCount = new Map<string, string[]>();
  let faces = 0;
  for (const c of pack.cards) {
    if (!c.id) err('id 가 비어 있는 카드가 있습니다.');
    if (ids.has(c.id)) err(`카드 id 중복: ${c.id}`);
    ids.add(c.id);
    if (c.editionId !== m.editionId) err(`카드 ${c.id} 의 editionId(${c.editionId})가 manifest(${m.editionId})와 다릅니다.`);
    for (const f of [c.faceA, c.faceB]) {
      if (f === null) continue;
      faces++;
      if (f !== f.normalize('NFC')) err(`카드 ${c.id}: NFC 정규화되지 않은 문자열 "${f}"`);
      if (!f.trim()) err(`카드 ${c.id}: 빈 면이 있습니다.`);
      if ([...f].some((ch) => { const n = ch.codePointAt(0) ?? 0; return n < 0x20 || n === 0x7f || n === 0xfffd; })) err(`카드 ${c.id}: 제어 문자 또는 깨진 문자(U+FFFD)가 있습니다.`);
      const key = normalizeWord(f).toLowerCase();
      const list = faceCount.get(key) ?? [];
      list.push(c.id);
      faceCount.set(key, list);
    }
    if (c.faceB !== null && normalizeWord(c.faceA) === normalizeWord(c.faceB)) warn(`카드 ${c.id}: 앞뒤 면이 같은 단어입니다.`);
  }
  for (const [word, where] of faceCount) {
    if (where.length > 1) warn(`중복 의심 단어 "${word}": 카드 ${where.join(', ')} (삭제하지 말고 출처와 사유를 확인하세요)`);
  }

  const keyIds = new Set<string>();
  for (const k of pack.keys) {
    if (keyIds.has(k.id)) err(`키 id 중복: ${k.id}`);
    keyIds.add(k.id);
    if (k.grid.length !== 25) {
      err(`키 ${k.id}: 25칸이 아닙니다 (${k.grid.length}).`);
      continue;
    }
    const want = expectedKeyCounts(k.startingTeam);
    const got: Record<Identity, number> = { red: 0, blue: 0, bystander: 0, assassin: 0 };
    for (const id of k.grid) got[id]++;
    for (const idt of Object.keys(want) as Identity[]) {
      if (got[idt] !== want[idt]) err(`키 ${k.id}: ${idt} ${got[idt]}칸 (기대값 ${want[idt]}, 선공 ${k.startingTeam})`);
    }
  }

  const e = m.expectedCounts;
  if (pack.cards.length !== e.cards) (m.kind === 'official' ? err : warn)(`카드 ${pack.cards.length}장 (기대값 ${e.cards})`);
  if (faces !== e.faces) (m.kind === 'official' ? err : warn)(`단어 면 ${faces}개 (기대값 ${e.faces})`);
  if (pack.keys.length !== e.keys) (m.kind === 'official' ? err : warn)(`키 카드 ${pack.keys.length}장 (기대값 ${e.keys})`);
  if (m.sourceReferences.length === 0 && m.kind !== 'custom') err('sourceReferences 가 비어 있습니다.');
  return issues;
}

/** 정식 모드로 게임을 시작할 수 있는가: 검증 완료 표시 + 오류 없음 + 원본 키 존재 */
export function isOfficialPlayable(pack: ContentPack): boolean {
  return (
    pack.manifest.kind === 'official' &&
    pack.manifest.validationStatus === 'verified' &&
    pack.keys.length > 0 &&
    validatePack(pack).every((i) => i.level !== 'error')
  );
}

/** 이 팩으로 한 판을 준비할 수 있는가 (25장 이상, 오류 없음) */
export function isBoardPlayable(pack: ContentPack): boolean {
  if (pack.manifest.kind === 'official') return isOfficialPlayable(pack);
  if (pack.manifest.validationStatus === 'missing') return false;
  return pack.cards.length >= 25 && validatePack(pack).every((i) => i.level !== 'error');
}
