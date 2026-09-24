// 세션·토큰·Origin 검사. 로그에 세션 id·초대 토큰·미공개 키를 남기지 않는다.

export const SESSION_COOKIE = 'cn_sid';
export const ENTRY_COOKIE = 'cn_pass';
const SESSION_MAX_AGE = 60 * 60 * 24 * 30; // 30일

export function randomToken(bytes: number): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return base64url(buf);
}

export function base64url(buf: Uint8Array): string {
  let s = '';
  for (const b of buf) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function sha256Hex(text: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function hmac(key: string, msg: string): Promise<string> {
  const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(msg));
  return base64url(new Uint8Array(sig));
}

/** 길이가 같을 때 상수 시간 비교 */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function parseCookies(header: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k) out[k] = v;
  }
  return out;
}

export function cookie(name: string, value: string, maxAge = SESSION_MAX_AGE): string {
  return `${name}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;
}

export function isValidSid(v: string | undefined): v is string {
  return !!v && /^[A-Za-z0-9_-]{43}$/.test(v);
}

export const ROOM_ID_RE = /^[A-Za-z0-9_-]{22}$/;

/** 상태를 바꾸는 요청과 WebSocket 은 같은 Origin(또는 허용 목록)에서만 받는다. */
export function originAllowed(request: Request, allowedCsv: string): boolean {
  const origin = request.headers.get('Origin');
  if (!origin) return false;
  const self = new URL(request.url).origin;
  if (origin === self) return true;
  const allowed = allowedCsv
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return allowed.includes(origin);
}

export const ENTRY_TAG = 'codename-entry-v1';
