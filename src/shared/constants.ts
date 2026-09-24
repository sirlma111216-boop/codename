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
} as const;
