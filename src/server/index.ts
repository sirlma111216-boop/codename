// Worker 진입점: 브라우저 ↔ Worker API/WebSocket ↔ 방별 Durable Object
// 정적 화면·이미지는 Workers Static Assets 가 내보낸다. /api/* 만 이 코드가 처리한다.

import type { Env } from './env.ts';
import {
  ENTRY_COOKIE,
  ENTRY_TAG,
  ROOM_ID_RE,
  SESSION_COOKIE,
  cookie,
  hmac,
  isValidSid,
  originAllowed,
  parseCookies,
  randomToken,
  safeEqual,
  sha256Hex,
} from './security.ts';
import { cleanNickname } from './room-logic.ts';
import { soloConfigSchema } from '../shared/protocol.ts';

export { GameRoomDurableObject } from './room.ts';
export { ClassroomDurableObject } from './classroom.ts';

const API_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
};

const json = (data: unknown, status = 200, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(data), { status, headers: { ...API_HEADERS, ...extra } });

const fail = (status: number, code: string, message: string) => json({ ok: false, code, message }, status);

async function readJson(request: Request, maxBytes = 4096): Promise<Record<string, unknown> | null> {
  const text = await request.text();
  if (text.length > maxBytes) return null;
  try {
    const v = JSON.parse(text);
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

interface Ctx {
  sid: string | null;
  sessionHash: string | null;
  admitted: boolean;
}

async function context(request: Request, env: Env): Promise<Ctx> {
  const cookies = parseCookies(request.headers.get('Cookie'));
  const sid = isValidSid(cookies[SESSION_COOKIE]) ? (cookies[SESSION_COOKIE] as string) : null;
  let admitted = true;
  if (env.ENTRY_PASSWORD) {
    const want = await hmac(env.ENTRY_PASSWORD, ENTRY_TAG);
    admitted = !!cookies[ENTRY_COOKIE] && safeEqual(cookies[ENTRY_COOKIE] as string, want);
  }
  return { sid, sessionHash: sid ? await sha256Hex(sid) : null, admitted };
}

const roomStub = (env: Env, roomId: string) => env.ROOMS.get(env.ROOMS.idFromName(roomId));
const classStub = (env: Env, classId: string) => env.CLASSES.get(env.CLASSES.idFromName(classId));

const CLASS_JOIN_ERRORS: Record<string, [number, string]> = {
  gone: [404, '클래스가 없거나 정리되었습니다.'],
  ended: [410, '수업이 끝났습니다.'],
  banned: [403, '이 클래스에서 내보내졌습니다.'],
  badInvite: [403, '클래스 초대 링크가 올바르지 않거나 새로 바뀌었습니다. 선생님께 새 링크를 받으세요.'],
  locked: [403, '선생님이 새 입장을 잠갔습니다.'],
  full: [403, '클래스 정원이 찼습니다.'],
  badNickname: [400, '닉네임을 입력하세요.'],
  teacher: [409, '이 브라우저는 이 클래스의 선생님으로 들어와 있습니다.'],
};

async function handleApi(request: Request, env: Env, url: URL): Promise<Response> {
  const path = url.pathname;
  const method = request.method;
  const isWs = request.headers.get('Upgrade')?.toLowerCase() === 'websocket';

  if (path === '/api/health' && method === 'GET') return json({ ok: true });

  // 상태를 바꾸는 요청·WebSocket 은 Origin 을 확인한다 (쿠키 기반이므로 CSRF 방지).
  if ((method !== 'GET' || isWs) && !originAllowed(request, env.ALLOWED_ORIGINS)) {
    return fail(403, 'badOrigin', '허용되지 않은 출처입니다.');
  }

  const ctx = await context(request, env);

  // 첫 방문: 난수 기반 익명 세션 발급 (Secure/HttpOnly/SameSite 쿠키)
  if (path === '/api/session' && method === 'POST') {
    const headers: Record<string, string> = {};
    if (!ctx.sid) headers['set-cookie'] = cookie(SESSION_COOKIE, randomToken(32));
    return json({ ok: true, needsPassword: !!env.ENTRY_PASSWORD, admitted: ctx.admitted }, 200, headers);
  }

  // 선택적 공용 입장 암호 (참가자 계정이 아니다)
  if (path === '/api/entry' && method === 'POST') {
    if (!env.ENTRY_PASSWORD) return json({ ok: true });
    const body = await readJson(request);
    const given = typeof body?.password === 'string' ? body.password : '';
    const want = await hmac(env.ENTRY_PASSWORD, ENTRY_TAG);
    const got = await hmac(given, ENTRY_TAG);
    if (!safeEqual(got, want)) return fail(403, 'badPassword', '입장 암호가 맞지 않습니다.');
    return json({ ok: true }, 200, { 'set-cookie': cookie(ENTRY_COOKIE, want) });
  }

  if (!ctx.sid || !ctx.sessionHash) return fail(401, 'noSession', '세션이 없습니다. 페이지를 새로고침하세요.');
  if (!ctx.admitted) return fail(403, 'needPassword', '입장 암호가 필요합니다.');

  // ---------------------------------------------------------------- 학급(클래스)
  // 새 클래스: 만든 사람의 익명 세션에 교사 권한. 교사 복구 키는 이번 응답에서 한 번만 보여 주고 서버에는 해시만 둔다.
  if (path === '/api/classes' && method === 'POST') {
    const body = await readJson(request);
    const name = typeof body?.name === 'string' ? body.name : '';
    const capacity = typeof body?.capacity === 'number' ? body.capacity : 40;
    const recoveryKey = randomToken(18);
    const recoveryKeyHash = await sha256Hex(recoveryKey);
    for (let attempt = 0; attempt < 3; attempt++) {
      const classId = randomToken(16);
      const res = await classStub(env, classId).createClass({ classId, sessionHash: ctx.sessionHash, recoveryKeyHash, name, capacity });
      if (res.ok) return json({ ok: true, classId, invite: `${classId}.${res.inviteToken}`, recoveryKey });
    }
    return fail(500, 'createFailed', '클래스를 만들지 못했습니다.');
  }

  const cm = path.match(/^\/api\/classes\/([^/]+)\/(join|status|ws|recover)$/);
  if (cm) {
    const classId = cm[1] as string;
    const action = cm[2];
    if (!ROOM_ID_RE.test(classId)) return fail(404, 'gone', '클래스를 찾을 수 없습니다.');
    const stub = classStub(env, classId);
    if (action === 'join' && method === 'POST') {
      const body = await readJson(request);
      const inviteToken = typeof body?.inviteToken === 'string' ? body.inviteToken.slice(0, 64) : '';
      const nickname = typeof body?.nickname === 'string' ? body.nickname : '';
      const res = await stub.join({ sessionHash: ctx.sessionHash, inviteToken, nickname });
      if (res.ok) return json({ ok: true });
      const [status, message] = CLASS_JOIN_ERRORS[res.code] ?? [400, '입장하지 못했습니다.'];
      return fail(status, res.code, message);
    }
    if (action === 'status' && method === 'GET') return json({ ok: true, status: await stub.status(ctx.sessionHash) });
    if (action === 'recover' && method === 'POST') {
      const body = await readJson(request);
      const key = typeof body?.key === 'string' ? body.key.trim().slice(0, 64) : '';
      if (!key) return fail(400, 'badKey', '복구 키를 입력하세요.');
      const res = await stub.recoverTeacher({ sessionHash: ctx.sessionHash, keyHash: await sha256Hex(key) });
      return res.ok ? json({ ok: true }) : fail(403, 'badKey', '복구 키가 맞지 않거나 수업이 끝났습니다.');
    }
    if (action === 'ws' && method === 'GET') {
      if (!isWs) return fail(426, 'upgradeRequired', 'WebSocket 연결이 필요합니다.');
      const headers = new Headers(request.headers);
      headers.set('X-Session-Hash', ctx.sessionHash);
      return stub.fetch(new Request(request.url, { method: 'GET', headers }));
    }
  }

  // ---------------------------------------------------------------- 독립 게임방
  // 새 방
  if (path === '/api/rooms' && method === 'POST') {
    if (env.ALLOW_STANDALONE_ROOMS === 'false') return fail(403, 'standaloneDisabled', '이 서버에서는 학급 모드로만 게임방을 만들 수 있습니다.');
    const body = await readJson(request);
    const nickname = cleanNickname(typeof body?.nickname === 'string' ? body.nickname : '');
    if (!nickname) return fail(400, 'badNickname', '닉네임을 입력하세요.');
    for (let attempt = 0; attempt < 3; attempt++) {
      const roomId = randomToken(16);
      const res = await roomStub(env, roomId).create({ roomId, sessionHash: ctx.sessionHash, nickname });
      if (res.ok) return json({ ok: true, roomId, invite: `${roomId}.${res.inviteToken}` });
    }
    return fail(500, 'createFailed', '방을 만들지 못했습니다.');
  }

  // 혼자 하기: 나 + 봇. 초대·다른 참가자 없이 바로 게임을 시작한다.
  if (path === '/api/solo' && method === 'POST') {
    if (env.ALLOW_SOLO === 'false') return fail(403, 'soloDisabled', '이 서버에서는 혼자 하기를 쓰지 않습니다.');
    const body = await readJson(request);
    const nickname = cleanNickname(typeof body?.nickname === 'string' ? body.nickname : '');
    if (!nickname) return fail(400, 'badNickname', '닉네임을 입력하세요.');
    const parsed = soloConfigSchema.safeParse(body?.config);
    if (!parsed.success) return fail(400, 'badConfig', '혼자 하기 설정이 올바르지 않습니다.');
    for (let attempt = 0; attempt < 3; attempt++) {
      const roomId = randomToken(16);
      const res = await roomStub(env, roomId).createSolo({ roomId, sessionHash: ctx.sessionHash, nickname, config: parsed.data });
      if (res.ok) return json({ ok: true, roomId });
      if (res.code !== 'exists') return fail(400, res.code, res.message);
    }
    return fail(500, 'createFailed', '방을 만들지 못했습니다.');
  }

  const m = path.match(/^\/api\/rooms\/([^/]+)\/(join|status|ws)$/);
  if (m) {
    const roomId = m[1] as string;
    const action = m[2];
    if (!ROOM_ID_RE.test(roomId)) return fail(404, 'gone', '방을 찾을 수 없습니다.');
    const stub = roomStub(env, roomId);

    if (action === 'join' && method === 'POST') {
      const body = await readJson(request);
      const inviteToken = typeof body?.inviteToken === 'string' ? body.inviteToken.slice(0, 64) : '';
      const nickname = typeof body?.nickname === 'string' ? body.nickname : '';
      const res = await stub.join({ sessionHash: ctx.sessionHash, inviteToken, nickname });
      if (res.ok) return json({ ok: true });
      const messages: Record<string, [number, string]> = {
        gone: [404, '방이 없거나 정리되었습니다.'],
        banned: [403, '이 방에서 강퇴되었습니다.'],
        badInvite: [403, '초대 링크가 올바르지 않거나 새로 바뀌었습니다. 방장에게 새 링크를 받으세요.'],
        locked: [403, '방이 잠겨 있어 새로 들어갈 수 없습니다.'],
        full: [403, '방 인원이 가득 찼습니다.'],
        badNickname: [400, '닉네임을 입력하세요.'],
        classManaged: [403, '학급 방은 클래스 화면에서 참가 신청으로 들어갑니다.'],
        solo: [403, '혼자 하기 방에는 다른 사람이 들어갈 수 없습니다.'],
      };
      const [status, message] = messages[res.code] ?? [400, '입장하지 못했습니다.'];
      return fail(status, res.code, message);
    }

    if (action === 'status' && method === 'GET') {
      return json({ ok: true, status: await stub.status(ctx.sessionHash) });
    }

    if (action === 'ws' && method === 'GET') {
      if (!isWs) return fail(426, 'upgradeRequired', 'WebSocket 연결이 필요합니다.');
      // 클라이언트가 보낸 X-Session-Hash 는 버리고 Worker 가 쿠키로 계산한 값만 넘긴다.
      const headers = new Headers(request.headers);
      headers.set('X-Session-Hash', ctx.sessionHash);
      return stub.fetch(new Request(request.url, { method: 'GET', headers }));
    }
  }

  return fail(404, 'notFound', '알 수 없는 API 입니다.');
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) {
      try {
        return await handleApi(request, env, url);
      } catch {
        console.error('api error', url.pathname.replace(/\/api\/rooms\/[^/]+/, '/api/rooms/:id'));
        return fail(500, 'serverError', '서버 오류가 발생했습니다.');
      }
    }
    // 정적 파일 (run_worker_first 가 /api/* 만 잡으므로 보통 여기까지 오지 않는다)
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
