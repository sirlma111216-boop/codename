import type { ClassroomDurableObject } from './classroom.ts';
import type { GameRoomDurableObject } from './room.ts';

export interface Env {
  /** 게임방 (독립 방·학급 방) */
  ROOMS: DurableObjectNamespace<GameRoomDurableObject>;
  /** 클래스 (학급 모드) */
  CLASSES: DurableObjectNamespace<ClassroomDurableObject>;
  ASSETS: Fetcher;
  /** 무활동 방·클래스 정리 시간(시간). 운영 설정이며 카드 규칙이 아니다. */
  ROOM_TTL_HOURS: string;
  /** 방장 연결이 끊긴 뒤 관리 권한을 넘기기까지 기다리는 시간(초) — 독립 방 */
  HOST_GRACE_SECONDS: string;
  /** 쉼표로 구분한 추가 허용 Origin (개발용). 비워 두면 같은 Origin 만 허용한다. */
  ALLOWED_ORIGINS: string;
  /** 학급 모드: 클래스 학생 정원 상한 (운영 설정, 원작 인원 규정 아님) */
  CLASS_MAX_STUDENTS: string;
  /** 학급 모드: 클래스당 게임방 한도 */
  CLASS_MAX_ROOMS: string;
  /** "false" 면 독립 게임방 만들기를 막는다 (학교 전용 배포용) */
  ALLOW_STANDALONE_ROOMS: string;
  /** "false" 면 혼자 하기(봇과 게임)를 막는다 */
  ALLOW_SOLO?: string;
  /** 선택: 공용 입장 암호 (`wrangler secret put ENTRY_PASSWORD`). 참가자 계정이 아니다. */
  ENTRY_PASSWORD?: string;
}
