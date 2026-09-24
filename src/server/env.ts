import type { RoomDurableObject } from './room.ts';

export interface Env {
  ROOMS: DurableObjectNamespace<RoomDurableObject>;
  ASSETS: Fetcher;
  /** 무활동 방 정리 시간(시간). 운영 설정이며 카드 규칙이 아니다. */
  ROOM_TTL_HOURS: string;
  /** 방장 연결이 끊긴 뒤 관리 권한을 넘기기까지 기다리는 시간(초) */
  HOST_GRACE_SECONDS: string;
  /** 쉼표로 구분한 추가 허용 Origin (개발용). 비워 두면 같은 Origin 만 허용한다. */
  ALLOWED_ORIGINS: string;
  /** 선택: 공용 입장 암호 (`wrangler secret put ENTRY_PASSWORD`). 참가자 계정이 아니다. */
  ENTRY_PASSWORD?: string;
}
