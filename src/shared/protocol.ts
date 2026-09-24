// WebSocket 메시지 스키마. 서버는 모든 입력을 이 스키마로 검사한다.
// 클라이언트는 '의도'만 보낸다. 정답 여부·잔여 추측·승패는 서버가 정한다.

import { z } from 'zod';
import { CUSTOM_WORDS_MAX_COUNT, TIMER_CHOICES } from './constants.ts';
import type { RoomView } from './view.ts';

export { CHAT_MAX, CLOSE, CUSTOM_WORD_MAX, CUSTOM_WORDS_MAX_COUNT, MAX_MESSAGE_BYTES, NICKNAME_MAX, TIMER_CHOICES } from './constants.ts';

const team = z.enum(['red', 'blue']);
const clueNumber = z.union([z.number().int().min(0).max(9), z.literal('unlimited')]);
const rulesetId = z.enum(['cge2015-standard', 'cge2015-coop', 'cge2015-shared-operative']);

export const gameActionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('giveClue'), word: z.string().min(1).max(60), number: clueNumber }),
  z.object({ type: z.literal('guess'), index: z.number().int().min(0).max(24) }),
  z.object({ type: z.literal('endTurn') }),
  z.object({ type: z.literal('reportInvalidClue') }),
  z.object({ type: z.literal('voteDispute'), verdict: z.enum(['invalid', 'valid']) }),
  z.object({ type: z.literal('withdrawDispute') }),
  z.object({ type: z.literal('penaltyCover'), index: z.number().int().min(0).max(24).nullable() }),
  z.object({ type: z.literal('simulatedCover'), index: z.number().int().min(0).max(24) }),
  z.object({ type: z.literal('spyQuery'), draft: z.string().min(1).max(60) }),
  z.object({ type: z.literal('spyQueryAnswer'), queryId: z.number().int().min(1), answer: z.enum(['allow', 'disallow']) }),
  z.object({ type: z.literal('replaceSpymaster'), team, newMemberId: z.string().min(1).max(64) }),
  z.object({ type: z.literal('abort') }),
]);

const memberId = z.string().min(1).max(64);

export const commandSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('setSeat'), team: team.nullable(), role: z.enum(['spymaster', 'operative', 'spectator']) }),
  z.object({ type: z.literal('setNickname'), nickname: z.string().min(1).max(40) }),
  z.object({
    type: z.literal('setSettings'),
    rulesetId: rulesetId.optional(),
    packId: z.string().min(1).max(64).optional(),
    timerSeconds: z.number().int().refine((n) => (TIMER_CHOICES as readonly number[]).includes(n)).optional(),
    replayMode: z.enum(['fresh', 'flip']).optional(),
  }),
  z.object({ type: z.literal('setCustomWords'), words: z.array(z.string().max(40)).max(CUSTOM_WORDS_MAX_COUNT) }),
  z.object({ type: z.literal('startGame') }),
  z.object({ type: z.literal('backToLobby') }),
  z.object({ type: z.literal('chat'), text: z.string().min(1).max(400) }),
  z.object({ type: z.literal('timerStart') }),
  z.object({ type: z.literal('timerCancel') }),
  z.object({ type: z.literal('lock'), locked: z.boolean() }),
  z.object({ type: z.literal('rotateInvite') }),
  z.object({ type: z.literal('kick'), memberId }),
  z.object({ type: z.literal('closeRoom') }),
  z.object({ type: z.literal('transferHost'), memberId }),
  z.object({ type: z.literal('reassignSeat'), fromMemberId: memberId, toMemberId: memberId }),
  z.object({ type: z.literal('game'), action: gameActionSchema }),
]);

export const clientMessageSchema = z.discriminatedUnion('t', [
  z.object({ t: z.literal('hello'), protocol: z.number().int() }),
  z.object({
    t: z.literal('cmd'),
    commandId: z.string().min(8).max(64).regex(/^[A-Za-z0-9_-]+$/),
    gameId: z.string().max(64).nullable().optional(),
    expectedRevision: z.number().int().nonnegative().optional(),
    cmd: commandSchema,
  }),
]);

export type GameActionInput = z.infer<typeof gameActionSchema>;
export type Command = z.infer<typeof commandSchema>;
export type ClientMessage = z.infer<typeof clientMessageSchema>;

export type ErrorCode =
  | 'badMessage'
  | 'rateLimited'
  | 'forbidden'
  | 'staleRevision'
  | 'staleGame'
  | 'storageFailed'
  | 'notMember'
  | 'protocolMismatch'
  | string;

export type ServerMessage =
  | { t: 'hello'; protocol: number; memberId: string; serverNow: number }
  | { t: 'state'; room: RoomView }
  | { t: 'ack'; commandId: string; ok: true }
  | { t: 'ack'; commandId: string; ok: false; code: ErrorCode; message: string }
  | { t: 'error'; code: ErrorCode; message: string }
  | { t: 'bye'; reason: 'kicked' | 'closed' | 'expired' | 'protocol' | 'replaced' };
