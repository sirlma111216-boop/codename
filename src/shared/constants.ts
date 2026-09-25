// 서버·클라이언트가 함께 쓰는 상수. 클라이언트가 스키마 라이브러리(zod)를 번들하지 않도록 protocol.ts 와 분리한다.

export const MAX_MESSAGE_BYTES = 8 * 1024;
export const NICKNAME_MAX = 16;
export const CHAT_MAX = 200;
export const CUSTOM_WORD_MAX = 20;
export const CUSTOM_WORDS_MAX_COUNT = 400;
export const TIMER_CHOICES = [30, 60, 90, 120, 180] as const;

/** WebSocket close codes (앱 전용 4000번대) */
export const CLOSE = {
  kicked: 4403,
  gone: 4404,
  expired: 4410,
  protocol: 4426,
  replaced: 4409,
  notMember: 4401,
  /** 학급 방: 클래스 명단에서 빠졌다 */
  removed: 4408,
} as const;

// ---- 학급 모드 운영 설정 (원작 인원 규정이 아니다. 원작 표기는 4–8+ 이며 8명이 상한이라는 뜻이 아니다)
export const CLASS_DEFAULT_CAPACITY = 40;
/** 서버 설정 CLASS_MAX_STUDENTS 가 없을 때의 상한 */
export const CLASS_MAX_CAPACITY_DEFAULT = 60;
export const CLASS_MAX_ROOMS_DEFAULT = 15;
export const ROOM_CAP_LIMIT_MIN = 4;
export const ROOM_CAP_LIMIT_MAX = 8;
export const ROOM_CAP_DEFAULT = 6;
export const CLASS_NAME_MAX = 30;
export const ROOM_NAME_MAX = 20;
export const ANNOUNCE_MAX = 200;
