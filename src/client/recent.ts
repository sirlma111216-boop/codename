// 이 기기에서 최근 들어간 방 (편의 기능). 저장이 안 되는 환경에서도 앱은 그대로 동작한다.

export interface RecentRoom {
  roomId: string;
  nickname: string;
  at: number;
}

const KEY = 'codename.recent';

export function recentRooms(): RecentRoom[] {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? '[]') as RecentRoom[];
    return Array.isArray(v) ? v.filter((r) => /^[A-Za-z0-9_-]{22}$/.test(r.roomId)).slice(0, 5) : [];
  } catch {
    return [];
  }
}

export function rememberRoom(roomId: string, nickname: string) {
  try {
    const list = recentRooms().filter((r) => r.roomId !== roomId);
    list.unshift({ roomId, nickname, at: Date.now() });
    localStorage.setItem(KEY, JSON.stringify(list.slice(0, 5)));
  } catch {
    /* 무시 */
  }
}

export function forgetRoom(roomId: string) {
  try {
    localStorage.setItem(KEY, JSON.stringify(recentRooms().filter((r) => r.roomId !== roomId)));
  } catch {
    /* 무시 */
  }
}

const NICK_KEY = 'codename.nickname';
export function savedNickname(): string {
  try {
    return localStorage.getItem(NICK_KEY) ?? '';
  } catch {
    return '';
  }
}
export function saveNickname(n: string) {
  try {
    localStorage.setItem(NICK_KEY, n);
  } catch {
    /* 무시 */
  }
}
