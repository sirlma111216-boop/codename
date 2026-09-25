// 클래스 WebSocket 메시지 스키마. 모든 명령에 opId(작업 id)를 붙이고, 배정을 바꾸는 명령에는
// 기대 명단 버전(expectedRosterVersion)을 붙인다. 서버는 소속·권한·버전을 다시 검사한다.

import { z } from 'zod';
import type { ClassView } from './classroom.ts';

const id = z.string().min(1).max(64);
const roomCap = z.number().int().min(4).max(8);

export const classCommandSchema = z.discriminatedUnion('type', [
  // 학생
  z.object({ type: z.literal('requestJoin'), roomId: id }),
  z.object({ type: z.literal('cancelRequest') }),
  z.object({ type: z.literal('leaveRoom') }),
  z.object({ type: z.literal('help') }),
  z.object({ type: z.literal('dismissNotice') }),
  // 방장
  z.object({ type: z.literal('createRoom'), name: z.string().min(1).max(40), capacity: roomCap }),
  z.object({ type: z.literal('approve'), roomId: id, memberId: id, expectedRosterVersion: z.number().int().nonnegative() }),
  z.object({ type: z.literal('reject'), roomId: id, memberId: id }),
  z.object({ type: z.literal('removeFromRoom'), roomId: id, memberId: id, expectedRosterVersion: z.number().int().nonnegative() }),
  z.object({ type: z.literal('setRoomCapacity'), roomId: id, capacity: roomCap, expectedRosterVersion: z.number().int().nonnegative() }),
  z.object({ type: z.literal('closeRoom'), roomId: id }),
  // 교사
  z.object({ type: z.literal('designateHost'), memberId: id }),
  z.object({ type: z.literal('revokeHost'), memberId: id }),
  z.object({ type: z.literal('moveStudent'), memberId: id, toRoomId: id.nullable() }),
  z.object({ type: z.literal('setRoomHost'), roomId: id, memberId: id }),
  z.object({ type: z.literal('lockJoin'), locked: z.boolean() }),
  z.object({ type: z.literal('rotateInvite') }),
  z.object({ type: z.literal('announce'), text: z.string().min(1).max(400) }),
  z.object({ type: z.literal('dismissHelp'), memberId: id }),
  z.object({
    type: z.literal('setSettings'),
    capacity: z.number().int().min(1).max(500).optional(),
    roomCapMin: roomCap.optional(),
    roomCapMax: roomCap.optional(),
    roomCapDefault: roomCap.optional(),
  }),
  z.object({ type: z.literal('kickMember'), memberId: id }),
  z.object({ type: z.literal('reassignMember'), fromMemberId: id, toMemberId: id }),
  z.object({ type: z.literal('endClass') }),
]);

export const classClientMessageSchema = z.discriminatedUnion('t', [
  z.object({ t: z.literal('hello'), protocol: z.number().int() }),
  z.object({ t: z.literal('cmd'), opId: z.string().min(8).max(64).regex(/^[A-Za-z0-9_-]+$/), cmd: classCommandSchema }),
]);

export type ClassCommand = z.infer<typeof classCommandSchema>;
export type ClassClientMessage = z.infer<typeof classClientMessageSchema>;

export type ClassServerMessage =
  | { t: 'hello'; protocol: number; serverNow: number }
  | { t: 'class'; view: ClassView }
  | { t: 'ack'; opId: string; ok: true; result?: { roomId?: string } }
  | { t: 'ack'; opId: string; ok: false; code: string; message: string }
  | { t: 'error'; code: string; message: string }
  | { t: 'bye'; reason: 'kicked' | 'classEnded' | 'protocol' | 'replaced' };
