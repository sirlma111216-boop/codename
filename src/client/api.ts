// HTTP API. 세션은 서버가 HttpOnly 쿠키로 관리하므로 여기서는 값에 손대지 않는다.

export class ApiError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      credentials: 'same-origin',
      cache: 'no-store',
      ...init,
      headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
    });
  } catch {
    throw new ApiError(0, 'network', '서버에 연결하지 못했습니다. 인터넷 연결을 확인하세요.');
  }
  let body: Record<string, unknown> = {};
  try {
    body = (await res.json()) as Record<string, unknown>;
  } catch {
    /* 비어 있음 */
  }
  if (!res.ok || body.ok === false) {
    throw new ApiError(res.status, String(body.code ?? 'error'), String(body.message ?? '요청을 처리하지 못했습니다.'));
  }
  return body as T;
}

export const api = {
  session: () => call<{ needsPassword: boolean; admitted: boolean }>('/api/session', { method: 'POST', body: '{}' }),
  entry: (password: string) => call<{ ok: true }>('/api/entry', { method: 'POST', body: JSON.stringify({ password }) }),
  createRoom: (nickname: string) => call<{ roomId: string; invite: string }>('/api/rooms', { method: 'POST', body: JSON.stringify({ nickname }) }),
  join: (roomId: string, inviteToken: string, nickname: string) =>
    call<{ ok: true }>(`/api/rooms/${encodeURIComponent(roomId)}/join`, { method: 'POST', body: JSON.stringify({ inviteToken, nickname }) }),
  status: (roomId: string) => call<{ status: 'member' | 'notMember' | 'gone' | 'banned' }>(`/api/rooms/${encodeURIComponent(roomId)}/status`),
  // 학급 모드
  createClass: (name: string, capacity: number) =>
    call<{ classId: string; invite: string; recoveryKey: string }>('/api/classes', { method: 'POST', body: JSON.stringify({ name, capacity }) }),
  joinClass: (classId: string, inviteToken: string, nickname: string) =>
    call<{ ok: true }>(`/api/classes/${encodeURIComponent(classId)}/join`, { method: 'POST', body: JSON.stringify({ inviteToken, nickname }) }),
  classStatus: (classId: string) =>
    call<{ status: 'teacher' | 'member' | 'notMember' | 'gone' | 'banned' | 'ended' }>(`/api/classes/${encodeURIComponent(classId)}/status`),
  recoverTeacher: (classId: string, key: string) =>
    call<{ ok: true }>(`/api/classes/${encodeURIComponent(classId)}/recover`, { method: 'POST', body: JSON.stringify({ key }) }),
};

export function classInviteLink(classId: string, token: string): string {
  return `${location.origin}/c/join#${classId}.${token}`;
}

/** 초대 문자열 "roomId.token" 을 나눈다. 링크 전체를 붙여 넣어도 된다. */
export function parseInvite(input: string): { roomId: string; token: string } | null {
  const s = input.trim();
  const hash = s.includes('#') ? s.slice(s.indexOf('#') + 1) : s;
  const m = hash.match(/^([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{20,64})$/);
  return m ? { roomId: m[1] as string, token: m[2] as string } : null;
}

export function inviteLink(roomId: string, token: string): string {
  // 토큰은 URL fragment(#)에 둔다: 서버 로그·Referer 로 전송되지 않는다.
  return `${location.origin}/join#${roomId}.${token}`;
}
