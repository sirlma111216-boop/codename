// 학급(클래스) 모드의 표시용 타입. 클래스 화면에는 방의 공개 요약만 있고,
// 단어판·정답·힌트 초안·방 안 토론은 없다 (그것은 각 게임방 연결로만 간다).

import type { EndReason, Team } from './view.ts';
import type { BotLevel } from './bots.ts';

export const CLASS_PROTOCOL_VERSION = 1;

/** 클래스가 본 방 상태. playing/finished 동안 명단이 잠긴다. */
export type ClassRoomStatus = 'waiting' | 'playing' | 'finished' | 'closed';

/** 방이 클래스에 알리는 공개 진행 요약 (정답·단어·힌트 없음) */
export interface RoomSummary {
  phase: 'lobby' | 'playing' | 'finished';
  gameId: string | null;
  turnTeam: Team | null;
  remaining: Record<Team, number> | null;
  clueCount: number;
  winner: Team | null;
  endReason: EndReason | null;
}

export interface ClassRoomView {
  id: string;
  name: string;
  capacity: number;
  seatCount: number;
  hostMemberId: string | null;
  hostNickname: string | null;
  status: ClassRoomStatus;
  /** 이 방에 앉은 봇 수 (시뮬레이션용 가짜 참가자) */
  botCount: number;
  /** 아래는 교사, 그 방의 방장·참가자에게만 채워진다 */
  seats?: { memberId: string; nickname: string; online: boolean; bot?: boolean }[];
  requests?: { memberId: string; nickname: string; at: number }[];
  rosterVersion?: number;
  synced?: boolean;
  readyCount?: number;
  onlineCount?: number;
  summary?: RoomSummary | null;
}

export interface ClassMemberView {
  id: string;
  nickname: string;
  online: boolean;
  designated: boolean;
  assignment: string | null;
  request: string | null;
  detached: boolean;
  joinedAt: number;
}

export type ClassNoticeKind = 'rejected' | 'roomFull' | 'removed' | 'roomClosed' | 'moved' | 'roomStarted' | 'hostRevoked' | 'hostAssigned';

export interface ClassView {
  classId: string;
  name: string;
  revision: number;
  serverNow: number;
  ended: boolean;
  locked: boolean;
  you: {
    role: 'teacher' | 'student';
    memberId: string | null;
    nickname: string;
    designated: boolean;
    assignment: { roomId: string; synced: boolean } | null;
    request: { roomId: string } | null;
    ownsRoomId: string | null;
    notice: { kind: ClassNoticeKind; roomName: string; at: number } | null;
    helpPending: boolean;
  };
  settings: { capacity: number; maxCapacity: number; roomCapMin: number; roomCapMax: number; roomCapDefault: number; maxRooms: number };
  counts: { total: number; online: number; unassigned: number; rooms: number };
  rooms: ClassRoomView[];
  announcements: { id: number; text: string; at: number }[];
  /** 교사에게만 */
  members?: ClassMemberView[];
  inviteToken?: string;
  helpRequests?: { memberId: string; nickname: string; roomId: string | null; roomName: string | null; at: number }[];
  ttlHours: number;
}

/** 클래스 → 게임방 명단 반영 (내부 RPC). 매번 전체 명단을 보내고 버전으로 멱등 처리한다. */
export interface ClassRoomSync {
  classId: string;
  className: string;
  roomId: string;
  syncVersion: number;
  name: string;
  capacity: number;
  hostMemberId: string | null;
  members: { memberId: string; nickname: string; sessionHash: string | null; bot?: { level: BotLevel } | null }[];
  teacherHashes: string[];
  closed: boolean;
  closeReason: 'teacher' | 'host' | 'classEnded' | null;
}
