// ThemePack: 그림·색·효과음. 규칙과 무관하다.
// 그림 목록은 /assets/manifest.json 에서 읽으므로 그림을 교체해도 코드를 고칠 필요가 없다.
// 덮개 그림은 정체가 공개된 뒤에만 카드와 연결한다. 공개 전에는 모든 사람이 모든 덮개를 똑같이 미리 받는다.

import { useEffect, useState } from 'react';

export interface ImageEntry {
  file: string | null;
  srcset?: { file: string; width: number }[];
  width?: number;
  height?: number;
  fallback: string;
  usage: string;
}

export interface AssetManifest {
  version: number;
  images: Record<string, ImageEntry>;
  covers: {
    red: string[];
    blue: string[];
    redDouble: string;
    blueDouble: string;
    bystander: string[];
    assassin: string;
  };
  missing: string[];
}

let cache: Promise<AssetManifest | null> | null = null;

export function loadManifest(): Promise<AssetManifest | null> {
  cache ??= fetch('/assets/manifest.json', { cache: 'no-cache' })
    .then((r) => (r.ok ? (r.json() as Promise<AssetManifest>) : null))
    .catch(() => null);
  return cache;
}

export function useManifest(): AssetManifest | null {
  const [m, setM] = useState<AssetManifest | null>(null);
  useEffect(() => {
    let alive = true;
    void loadManifest().then((x) => alive && setM(x));
    return () => {
      alive = false;
    };
  }, []);
  return m;
}

export function imageUrl(m: AssetManifest | null, name: string): string | null {
  const e = m?.images[name];
  return e?.file ? `/assets/${e.file}` : null;
}

export function imageSrcSet(m: AssetManifest | null, name: string): string | undefined {
  const e = m?.images[name];
  if (!e?.srcset) return undefined;
  return e.srcset.map((v) => `/assets/${v.file} ${v.width}w`).join(', ');
}

export function fallbackColor(m: AssetManifest | null, name: string, dflt = '#111827'): string {
  return m?.images[name]?.fallback ?? dflt;
}

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** gameId 로 정해지는 순열 — 모든 참가자가 같은 덮개 그림을 본다 */
function permute<T>(list: T[], seed: string): T[] {
  const out = list.slice();
  let x = hash(seed) || 1;
  for (let i = out.length - 1; i > 0; i--) {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    const j = x % (i + 1);
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
}

/** 엔진의 덮개 슬롯("red:3", "blue:double", "bystander:0", "assassin:0") → 그림 이름 */
export function coverImageName(m: AssetManifest | null, cover: string, gameId: string): string | null {
  if (!m) return null;
  const [identity, slot] = cover.split(':');
  if (identity === 'assassin') return m.covers.assassin;
  if (identity === 'red' || identity === 'blue') {
    if (slot === 'double') return identity === 'red' ? m.covers.redDouble : m.covers.blueDouble;
    const list = permute(m.covers[identity], `${gameId}:${identity}`);
    return list[Number(slot) % list.length] ?? null;
  }
  if (identity === 'bystander') {
    const list = permute(m.covers.bystander, `${gameId}:bystander`);
    return list[Number(slot) % list.length] ?? null;
  }
  return null;
}

export const COVER_SIZES = '(max-width: 640px) 20vw, (max-width: 1100px) 16vw, 190px';

/** 모든 덮개 그림을 모든 역할에서 똑같이 미리 받는다(늦게 뜨는 그림이 단서가 되지 않게). */
export function preloadCovers(m: AssetManifest | null) {
  if (!m) return;
  const names = [...m.covers.red, ...m.covers.blue, m.covers.redDouble, m.covers.blueDouble, ...m.covers.bystander, m.covers.assassin];
  for (const n of names) {
    const img = new Image();
    img.decoding = 'async';
    img.sizes = COVER_SIZES;
    const ss = imageSrcSet(m, n);
    if (ss) img.srcset = ss;
    const url = imageUrl(m, n);
    if (url) img.src = url;
  }
}
