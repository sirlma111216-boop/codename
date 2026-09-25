// 학급(클래스) 상태와 명령. 좌석 배정의 최종 판단은 여기(클래스 객체) 한 곳에서만 한다.
// 게임방은 이 결과를 버전 붙은 전체 명단으로 받아 반영할 뿐, 스스로 좌석을 더하지 않는다.
// 입출력이 없는 순수 함수라 단위 테스트로 경쟁·권한·일관성을 검사한다.

import { ANNOUNCE_MAX, CLASS_NAME_MAX, ROOM_CAP_LIMIT_MAX, ROOM_CAP_LIMIT_MIN, ROOM_NAME_MAX } from '../shared/constants.ts';
import type { ClassCommand } from '../shared/class-protocol.ts';
import type { ClassMemberView, ClassNoticeKind, ClassRoomStatus, ClassRoomSync, ClassRoomView, ClassView, RoomSummary } from '../shared/classroom.ts';
import { botNickname, cleanNickname, cleanText } from './room-logic.ts';
import type { BotLevel } from '../shared/bots.ts';

export const CLASS_SCHEMA_VERSION = 1;
const OPS_KEEP = 400;
const ANNOUNCE_KEEP = 10;
/** 시작 잠금 뒤 방의 확인이 이만큼 없으면 방 상태를 직접 물어 복구한다 */
export const LOCK_CONFIRM_TIMEOUT_MS = 20_000;

export interface ClassMember {
  id: string;
  nickname: string;
  /** SHA-256(세션 쿠키). null = 강퇴·재지정으로 연결만 끊긴 자리 */
  sessionHash: string | null;
  joinedAt: number;
  designated: boolean;
  assignment: string | null;
  request: { roomId: string; at: number } | null;
  notice: { kind: ClassNoticeKind; roomName: string; at: number } | null;
}

/** 시뮬레이션용 봇 좌석. 학생이 아니므로 클래스 정원·미배정 수에 들어가지 않는다. */
export interface ClassBot {
  id: string;
  nickname: string;
  level: BotLevel;
  roomId: string;
  createdAt: number;
}

export interface ClassRoom {
  id: string;
  name: string;
  capacity: number;
  hostMemberId: string | null;
  seats: string[];
  status: ClassRoomStatus;
  /** 이 방에 반영할 명단 버전. 좌석·방장·정원·이름·세션이 바뀔 때마다 오른다 */
  syncVersion: number;
  /** 방이 반영을 확인한 버전 */
  syncedVersion: number;
  syncAttempts: number;
  nextSyncAt: number;
  createdAt: number;
  lock: { version: number; opId: string; at: number; gameId: string | null } | null;
  report: { readyCount: number; onlineCount: number; summary: RoomSummary | null; at: number } | null;
  closeReason: 'teacher' | 'host' | 'classEnded' | null;
}

export interface ClassState {
  schemaVersion: number;
  classId: string;
  name: string;
  createdAt: number;
  lastActivity: number;
  revision: number;
  inviteToken: string;
  locked: boolean;
  ended: boolean;
  teacher: { sessionHashes: string[]; recoveryKeyHash: string };
  settings: { capacity: number; roomCapMin: number; roomCapMax: number; roomCapDefault: number };
  members: Record<string, ClassMember>;
  banned: string[];
  rooms: Record<string, ClassRoom>;
  announcements: { id: number; text: string; at: number }[];
  nextAnnouncementId: number;
  helpRequests: { memberId: string; at: number }[];
  ops: { id: string; actor: string; ok: boolean; code?: string; message?: string; roomId?: string }[];
  /** 수업 종료·만료 뒤 지워야 할 게임방 (재시도 목록) */
  cleanup: string[];
  bots: Record<string, ClassBot>;
}

export interface ClassEnv {
  now: number;
  newId: (bytes: number) => string;
  maxCapacity: number;
  maxRooms: number;
  ttlHours: number;
}

export type Actor = { kind: 'teacher'; sessionHash: string } | { kind: 'student'; memberId: string };

export function actorKey(a: Actor): string {
  return a.kind === 'teacher' ? `t:${a.sessionHash.slice(0, 16)}` : `s:${a.memberId}`;
}

export function createClass(classId: string, teacherHash: string, recoveryKeyHash: string, nameRaw: string, capacity: number, env: ClassEnv): ClassState {
  return {
    schemaVersion: CLASS_SCHEMA_VERSION,
    classId,
    name: cleanText(nameRaw, CLASS_NAME_MAX) || '우리 반',
    createdAt: env.now,
    lastActivity: env.now,
    revision: 1,
    inviteToken: env.newId(24),
    locked: false,
    ended: false,
    teacher: { sessionHashes: [teacherHash], recoveryKeyHash },
    settings: { capacity: clampCapacity(capacity, env), roomCapMin: ROOM_CAP_LIMIT_MIN, roomCapMax: ROOM_CAP_LIMIT_MAX, roomCapDefault: 6 },
    members: {},
    banned: [],
    rooms: {},
    announcements: [],
    nextAnnouncementId: 1,
    helpRequests: [],
    ops: [],
    cleanup: [],
    bots: {},
  };
}

function clampCapacity(n: number, env: ClassEnv): number {
  if (!Number.isFinite(n)) return Math.min(40, env.maxCapacity);
  return Math.max(1, Math.min(env.maxCapacity, Math.floor(n)));
}

/** 저장된 상태를 현재 형태로 맞춘다 (기존 클래스를 초기화하지 않는다) */
export function migrateClass(raw: unknown): ClassState | null {
  if (!raw || typeof raw !== 'object') return null;
  const c = raw as Partial<ClassState>;
  if (typeof c.schemaVersion === 'number' && c.schemaVersion > CLASS_SCHEMA_VERSION) return c as ClassState;
  return {
    schemaVersion: CLASS_SCHEMA_VERSION,
    classId: c.classId ?? '',
    name: c.name ?? '',
    createdAt: c.createdAt ?? Date.now(),
    lastActivity: c.lastActivity ?? Date.now(),
    revision: c.revision ?? 1,
    inviteToken: c.inviteToken ?? '',
    locked: c.locked ?? false,
    ended: c.ended ?? false,
    teacher: c.teacher ?? { sessionHashes: [], recoveryKeyHash: '' },
    settings: { capacity: 40, roomCapMin: 4, roomCapMax: 8, roomCapDefault: 6, ...(c.settings ?? {}) },
    members: c.members ?? {},
    banned: c.banned ?? [],
    rooms: c.rooms ?? {},
    announcements: c.announcements ?? [],
    nextAnnouncementId: c.nextAnnouncementId ?? 1,
    helpRequests: c.helpRequests ?? [],
    ops: c.ops ?? [],
    cleanup: c.cleanup ?? [],
    bots: c.bots ?? {},
  };
}

export const isTeacher = (c: ClassState, sessionHash: string) => c.teacher.sessionHashes.includes(sessionHash);
export const memberBySession = (c: ClassState, sessionHash: string) => Object.values(c.members).find((m) => m.sessionHash === sessionHash);
export const activeRooms = (c: ClassState) => Object.values(c.rooms).filter((r) => r.status !== 'closed');
const studentCount = (c: ClassState) => Object.keys(c.members).length;

export type ClassStatus = 'teacher' | 'member' | 'notMember' | 'banned' | 'ended' | 'gone';

export function classStatus(c: ClassState | null, sessionHash: string): ClassStatus {
  if (!c) return 'gone';
  if (isTeacher(c, sessionHash)) return 'teacher'; // 수업이 끝나도 교사는 기록을 읽기 전용으로 본다
  if (c.banned.includes(sessionHash)) return 'banned';
  if (!memberBySession(c, sessionHash)) return c.ended ? 'ended' : 'notMember';
  return c.ended ? 'ended' : 'member';
}

export type JoinClassResult = { ok: true; memberId: string; created: boolean } | { ok: false; code: 'banned' | 'badInvite' | 'locked' | 'full' | 'badNickname' | 'ended' | 'teacher' };

export function joinClass(c: ClassState, sessionHash: string, inviteOk: boolean, nicknameRaw: string, env: ClassEnv): JoinClassResult {
  if (c.ended) return { ok: false, code: 'ended' };
  if (isTeacher(c, sessionHash)) return { ok: false, code: 'teacher' };
  if (c.banned.includes(sessionHash)) return { ok: false, code: 'banned' };
  const existing = memberBySession(c, sessionHash);
  if (existing) return { ok: true, memberId: existing.id, created: false };
  if (!inviteOk) return { ok: false, code: 'badInvite' };
  if (c.locked) return { ok: false, code: 'locked' };
  if (studentCount(c) >= c.settings.capacity) return { ok: false, code: 'full' };
  let nick = cleanNickname(nicknameRaw);
  if (!nick) return { ok: false, code: 'badNickname' };
  const taken = new Set(Object.values(c.members).map((m) => m.nickname));
  for (let i = 2; taken.has(nick) && i < 200; i++) nick = `${[...cleanNickname(nicknameRaw)].slice(0, 12).join('')}(${i})`;
  const id = env.newId(9);
  c.members[id] = { id, nickname: nick, sessionHash, joinedAt: env.now, designated: false, assignment: null, request: null, notice: null };
  c.revision++;
  c.lastActivity = env.now;
  return { ok: true, memberId: id, created: true };
}

/** 교사 복구 키로 새 세션에 교사 권한을 준다 (키는 해시로만 저장되어 있다) */
export function addTeacherSession(c: ClassState, sessionHash: string): string[] {
  if (!c.teacher.sessionHashes.includes(sessionHash)) c.teacher.sessionHashes = [...c.teacher.sessionHashes, sessionHash].slice(-5);
  const member = memberBySession(c, sessionHash);
  if (member) member.sessionHash = null; // 학생으로도 들어와 있던 세션이면 학생 자리에서 떼어 낸다
  c.revision++;
  // 교사 세션이 바뀌었으니 방 관전 권한도 다시 반영한다
  return activeRooms(c).map((r) => bump(r));
}

// ------------------------------------------------------------------ 명령

export interface ClassEffects {
  /** 반영(sync)이 필요한 방 */
  syncRooms: string[];
  /** 연결을 끊을 세션 */
  closeSessions: { sessionHash: string; reason: 'kicked' | 'replaced' }[];
  /** 수업 종료 */
  ended: boolean;
  roomId?: string;
}

export type ClassResult = { ok: true; effects: ClassEffects } | { ok: false; code: string; message: string };

const no = (code: string, message: string): ClassResult => ({ ok: false, code, message });

function bump(r: ClassRoom): string {
  r.syncVersion++;
  r.syncAttempts = 0;
  r.nextSyncAt = 0;
  return r.id;
}

function notify(m: ClassMember | undefined, kind: ClassNoticeKind, roomName: string, now: number) {
  if (m) m.notice = { kind, roomName, at: now };
}

function releaseSeat(c: ClassState, r: ClassRoom, memberId: string) {
  r.seats = r.seats.filter((s) => s !== memberId);
  if (c.bots[memberId]) delete c.bots[memberId];
  const m = c.members[memberId];
  if (m && m.assignment === r.id) m.assignment = null;
  if (r.hostMemberId === memberId) r.hostMemberId = null;
}

/** 정원이 차면 그 방의 남은 신청을 정리하고 신청자에게 알린다 */
function clearRequestsIfFull(c: ClassState, r: ClassRoom, now: number) {
  if (r.seats.length < r.capacity) return;
  for (const m of Object.values(c.members)) {
    if (m.request?.roomId === r.id) {
      m.request = null;
      notify(m, 'roomFull', r.name, now);
    }
  }
}

function clearRequestsForRoom(c: ClassState, r: ClassRoom, kind: ClassNoticeKind, now: number) {
  for (const m of Object.values(c.members)) {
    if (m.request?.roomId === r.id) {
      m.request = null;
      notify(m, kind, r.name, now);
    }
  }
}

function closeRoomInState(c: ClassState, r: ClassRoom, reason: 'teacher' | 'host' | 'classEnded', now: number) {
  // 진행 중이던 게임은 승패 없이 ‘수업 종료로 중단’으로 기록한다 (방 객체가 지워진 뒤에도 클래스 기록에 남는다)
  if (r.status === 'playing') {
    const prev = r.report?.summary;
    r.report = {
      readyCount: r.report?.readyCount ?? 0,
      onlineCount: 0,
      at: now,
      summary: { phase: 'finished', gameId: r.lock?.gameId ?? prev?.gameId ?? null, turnTeam: null, remaining: prev?.remaining ?? null, clueCount: prev?.clueCount ?? 0, winner: null, endReason: 'classEnded' },
    };
  }
  for (const s of [...r.seats]) {
    const m = c.members[s];
    if (m && m.assignment === r.id) {
      m.assignment = null;
      if (reason !== 'classEnded') notify(m, 'roomClosed', r.name, now);
    }
  }
  clearRequestsForRoom(c, r, 'roomClosed', now);
  for (const b of Object.values(c.bots)) if (b.roomId === r.id) delete c.bots[b.id];
  r.seats = [];
  r.hostMemberId = null;
  r.status = 'closed';
  r.closeReason = reason;
  r.lock = null;
  bump(r);
  if (!c.cleanup.includes(r.id)) c.cleanup.push(r.id);
}

export function applyClassCommand(c: ClassState, actor: Actor, cmd: ClassCommand, env: ClassEnv): ClassResult {
  if (c.ended) return no('ended', '수업이 끝났습니다.');
  const effects: ClassEffects = { syncRooms: [], closeSessions: [], ended: false };
  const teacher = actor.kind === 'teacher';
  const me = actor.kind === 'student' ? c.members[actor.memberId] : undefined;
  if (actor.kind === 'student' && (!me || !me.sessionHash)) return no('notMember', '클래스 참가자가 아닙니다.');
  const done = (): ClassResult => {
    c.revision++;
    c.lastActivity = env.now;
    effects.syncRooms = [...new Set(effects.syncRooms)];
    return { ok: true, effects };
  };
  const teacherOnly = () => no('forbidden', '선생님만 할 수 있습니다.');
  const room = (roomId: string): ClassRoom | undefined => {
    const r = c.rooms[roomId];
    return r && r.status !== 'closed' ? r : undefined;
  };
  /** 이 방을 관리할 수 있는가: 그 방의 현재 방장(학생) 또는 교사 */
  const canManage = (r: ClassRoom) => teacher || (!!me && r.hostMemberId === me.id);

  switch (cmd.type) {
    // ---------------------------------------------------------------- 학생
    case 'requestJoin': {
      if (!me) return no('forbidden', '학생만 참가 신청을 할 수 있습니다.');
      const r = room(cmd.roomId);
      if (!r) return no('noRoom', '이 클래스에 그런 방이 없습니다.');
      if (me.assignment) return no('alreadyAssigned', '이미 방에 배정되어 있습니다. 먼저 방에서 나와야 다른 방을 신청할 수 있습니다.');
      if (r.status !== 'waiting') return no('roomLocked', '이미 게임이 시작된 방입니다. 다음 게임을 기다리거나 다른 방을 고르세요.');
      if (r.seats.length >= r.capacity) return no('roomFull', '정원이 찬 방입니다. 다른 방을 고르세요.');
      // 미결 신청은 한 방만: 새로 신청하면 이전 신청은 취소된다
      me.request = { roomId: r.id, at: env.now };
      me.notice = null;
      return done();
    }
    case 'cancelRequest': {
      if (!me) return no('forbidden', '학생만 할 수 있습니다.');
      if (!me.request) return no('noRequest', '취소할 신청이 없습니다.');
      me.request = null;
      return done();
    }
    case 'leaveRoom': {
      if (!me || !me.assignment) return no('notAssigned', '배정된 방이 없습니다.');
      const r = room(me.assignment);
      if (!r) {
        me.assignment = null;
        return done();
      }
      if (r.status === 'playing') return no('roomLocked', '게임 중에는 방을 나갈 수 없습니다. 연결이 끊겨도 자리는 유지됩니다.');
      if (r.hostMemberId === me.id) return no('isHost', '방장은 방을 나갈 수 없습니다. 방을 닫거나 선생님께 관리권 이전을 부탁하세요.');
      releaseSeat(c, r, me.id);
      effects.syncRooms.push(bump(r));
      return done();
    }
    case 'help': {
      if (!me) return no('forbidden', '학생만 할 수 있습니다.');
      c.helpRequests = [...c.helpRequests.filter((h) => h.memberId !== me.id), { memberId: me.id, at: env.now }].slice(-100);
      return done();
    }
    case 'dismissNotice': {
      if (!me) return no('forbidden', '학생만 할 수 있습니다.');
      me.notice = null;
      return done();
    }

    // ---------------------------------------------------------------- 방장
    case 'createRoom': {
      if (!teacher) {
        if (!me) return no('forbidden', '선생님이 방장으로 지정한 학생만 방을 만들 수 있습니다.');
        if (!me.designated) return no('notDesignated', '선생님이 방장으로 지정한 학생만 방을 만들 수 있습니다.');
        if (activeRooms(c).some((r) => r.hostMemberId === me.id)) return no('alreadyOwns', '이미 관리 중인 방이 있습니다. 한 번에 한 방만 만들 수 있습니다.');
        if (me.assignment) return no('alreadyAssigned', '다른 방에 배정되어 있습니다. 방에서 나온 뒤 만드세요.');
      }
      if (activeRooms(c).length >= env.maxRooms) return no('tooManyRooms', `이 클래스의 게임방은 최대 ${env.maxRooms}개입니다.`);
      if (cmd.capacity < c.settings.roomCapMin || cmd.capacity > c.settings.roomCapMax) return no('badCapacity', `정원은 ${c.settings.roomCapMin}~${c.settings.roomCapMax}명 사이에서 고르세요.`);
      const seatsTaken = me ? 1 : 0;
      if (cmd.bots && cmd.bots.count > cmd.capacity - seatsTaken) return no('roomFull', `빈자리는 ${cmd.capacity - seatsTaken}개입니다.`);
      const name = cleanText(cmd.name, ROOM_NAME_MAX) || (me ? `${me.nickname}의 방` : '시뮬레이션 방');
      const id = env.newId(16);
      c.rooms[id] = {
        id,
        name,
        capacity: cmd.capacity,
        hostMemberId: me ? me.id : null, // 선생님이 만든 방: 학생 방장 없이 선생님이 관리한다
        seats: me ? [me.id] : [], // 학생 방장도 좌석 하나를 쓴다. 선생님은 좌석을 쓰지 않는다
        status: 'waiting',
        syncVersion: 1,
        syncedVersion: 0,
        syncAttempts: 0,
        nextSyncAt: 0,
        createdAt: env.now,
        lock: null,
        report: null,
        closeReason: null,
      };
      if (me) {
        me.assignment = id;
        me.request = null;
      }
      const created = c.rooms[id] as ClassRoom;
      if (cmd.bots) seatBots(c, created, cmd.bots.count, cmd.bots.level, env);
      clearRequestsIfFull(c, created, env.now);
      effects.syncRooms.push(id);
      effects.roomId = id;
      return done();
    }
    case 'addBots': {
      const r = room(cmd.roomId);
      if (!r) return no('noRoom', '이 클래스에 그런 방이 없습니다.');
      if (!canManage(r)) return no('forbidden', '그 방의 방장이나 선생님만 봇을 넣을 수 있습니다.');
      if (r.status !== 'waiting') return no('roomLocked', '대기 중인 방에만 봇을 넣을 수 있습니다.');
      const free = r.capacity - r.seats.length;
      if (cmd.count > free) return no('roomFull', free > 0 ? `빈자리는 ${free}개입니다.` : '정원이 찼습니다.');
      seatBots(c, r, cmd.count, cmd.level, env);
      clearRequestsIfFull(c, r, env.now);
      effects.syncRooms.push(bump(r));
      return done();
    }
    case 'removeBot': {
      const r = room(cmd.roomId);
      if (!r) return no('noRoom', '이 클래스에 그런 방이 없습니다.');
      if (!canManage(r)) return no('forbidden', '그 방의 방장이나 선생님만 봇을 뺄 수 있습니다.');
      if (r.status !== 'waiting') return no('roomLocked', '대기 중인 방에서만 봇을 뺄 수 있습니다.');
      if (!c.bots[cmd.botId] || !r.seats.includes(cmd.botId)) return no('notSeated', '이 방의 봇이 아닙니다.');
      releaseSeat(c, r, cmd.botId);
      effects.syncRooms.push(bump(r));
      return done();
    }
    case 'approve': {
      const r = room(cmd.roomId);
      if (!r) return no('noRoom', '이 클래스에 그런 방이 없습니다.');
      if (!me || r.hostMemberId !== me.id) return no('forbidden', '그 방의 방장만 승인할 수 있습니다.');
      if (r.status !== 'waiting') return no('roomLocked', '게임이 시작되어 명단이 잠겼습니다.');
      if (cmd.expectedRosterVersion !== r.syncVersion) return no('staleRoster', '명단이 바뀌었습니다. 최신 목록을 보고 다시 승인하세요.');
      const target = c.members[cmd.memberId];
      if (!target || target.request?.roomId !== r.id) return no('noRequest', '이 방에 신청한 학생이 아닙니다(취소했거나 다른 방을 골랐습니다).');
      if (target.assignment) return no('alreadyAssigned', '이미 다른 방에 배정된 학생입니다.');
      if (r.seats.length >= r.capacity) return no('roomFull', '정원이 찼습니다.');
      r.seats.push(target.id);
      target.assignment = r.id;
      target.request = null;
      target.notice = null;
      clearRequestsIfFull(c, r, env.now);
      effects.syncRooms.push(bump(r));
      return done();
    }
    case 'reject': {
      const r = room(cmd.roomId);
      if (!r) return no('noRoom', '이 클래스에 그런 방이 없습니다.');
      if (!me || r.hostMemberId !== me.id) return no('forbidden', '그 방의 방장만 거절할 수 있습니다.');
      const target = c.members[cmd.memberId];
      if (!target || target.request?.roomId !== r.id) return no('noRequest', '이 방에 신청한 학생이 아닙니다.');
      target.request = null;
      notify(target, 'rejected', r.name, env.now);
      return done();
    }
    case 'removeFromRoom': {
      const r = room(cmd.roomId);
      if (!r) return no('noRoom', '이 클래스에 그런 방이 없습니다.');
      if (!canManage(r)) return no('forbidden', '그 방의 방장이나 선생님만 할 수 있습니다.');
      if (r.status !== 'waiting') return no('roomLocked', '대기 중인 방에서만 내보낼 수 있습니다.');
      if (cmd.expectedRosterVersion !== r.syncVersion) return no('staleRoster', '명단이 바뀌었습니다. 다시 확인하세요.');
      if (!r.seats.includes(cmd.memberId)) return no('notSeated', '이 방에 앉은 학생이 아닙니다.');
      if (r.hostMemberId === cmd.memberId) return no('isHost', '방장 자신은 내보낼 수 없습니다.');
      releaseSeat(c, r, cmd.memberId);
      notify(c.members[cmd.memberId], 'removed', r.name, env.now);
      effects.syncRooms.push(bump(r));
      return done();
    }
    case 'setRoomCapacity': {
      const r = room(cmd.roomId);
      if (!r) return no('noRoom', '이 클래스에 그런 방이 없습니다.');
      if (!canManage(r)) return no('forbidden', '그 방의 방장이나 선생님만 할 수 있습니다.');
      if (r.status !== 'waiting') return no('roomLocked', '대기 중에만 정원을 바꿀 수 있습니다.');
      if (cmd.expectedRosterVersion !== r.syncVersion) return no('staleRoster', '명단이 바뀌었습니다. 다시 확인하세요.');
      if (cmd.capacity < c.settings.roomCapMin || cmd.capacity > c.settings.roomCapMax) return no('badCapacity', `정원은 ${c.settings.roomCapMin}~${c.settings.roomCapMax}명입니다.`);
      // 줄어든 정원 때문에 승인된 학생을 자동으로 내보내지 않는다
      if (cmd.capacity < r.seats.length) return no('belowSeats', `지금 ${r.seats.length}명이 앉아 있어 그보다 작게 줄일 수 없습니다.`);
      r.capacity = cmd.capacity;
      clearRequestsIfFull(c, r, env.now);
      effects.syncRooms.push(bump(r)); // 준비 상태 초기화
      return done();
    }
    case 'closeRoom': {
      const r = room(cmd.roomId);
      if (!r) return no('noRoom', '이 클래스에 그런 방이 없습니다.');
      if (!canManage(r)) return no('forbidden', '그 방의 방장이나 선생님만 닫을 수 있습니다.');
      if (!teacher && r.status === 'playing') return no('roomLocked', '게임 중인 방은 선생님만 닫을 수 있습니다.');
      closeRoomInState(c, r, teacher ? 'teacher' : 'host', env.now);
      effects.syncRooms.push(r.id);
      return done();
    }

    // ---------------------------------------------------------------- 교사
    case 'designateHost': {
      if (!teacher) return teacherOnly();
      const m = c.members[cmd.memberId];
      if (!m || !m.sessionHash) return no('noMember', '참가자를 찾을 수 없습니다.');
      m.designated = true;
      notify(m, 'hostAssigned', '', env.now);
      return done();
    }
    case 'revokeHost': {
      if (!teacher) return teacherOnly();
      const m = c.members[cmd.memberId];
      if (!m) return no('noMember', '참가자를 찾을 수 없습니다.');
      m.designated = false;
      notify(m, 'hostRevoked', '', env.now);
      // 만든 방은 지우지 않는다. 관리권만 거둬 두고 교사가 넘기거나 닫는다.
      for (const r of activeRooms(c)) {
        if (r.hostMemberId === m.id) {
          r.hostMemberId = null;
          effects.syncRooms.push(bump(r));
        }
      }
      return done();
    }
    case 'moveStudent': {
      if (!teacher) return teacherOnly();
      const m = c.members[cmd.memberId];
      if (!m) return no('noMember', '참가자를 찾을 수 없습니다.');
      const from = m.assignment ? room(m.assignment) : undefined;
      const to = cmd.toRoomId ? room(cmd.toRoomId) : undefined;
      if (cmd.toRoomId && !to) return no('noRoom', '옮길 방이 없습니다.');
      if (from && from.id === to?.id) return no('sameRoom', '이미 그 방에 있습니다.');
      if (from && from.status !== 'waiting') return no('roomLocked', '게임 중인(또는 끝난 뒤 정리 전인) 방에서는 옮길 수 없습니다.');
      if (from && from.hostMemberId === m.id) return no('isHost', '방장은 옮길 수 없습니다. 먼저 관리권을 넘기세요.');
      if (to && to.status !== 'waiting') return no('roomLocked', '게임이 진행 중인 방에는 넣을 수 없습니다. 다음 게임을 기다리게 하세요.');
      if (to && to.seats.length >= to.capacity) return no('roomFull', '옮길 방의 정원이 찼습니다.');
      // 기존 좌석 해제와 새 좌석 확보를 한 번에(같은 저장) 처리한다
      if (from) {
        releaseSeat(c, from, m.id);
        effects.syncRooms.push(bump(from));
      } else if (m.assignment) {
        m.assignment = null;
      }
      if (to) {
        to.seats.push(m.id);
        m.assignment = to.id;
        clearRequestsIfFull(c, to, env.now);
        effects.syncRooms.push(bump(to));
        notify(m, 'moved', to.name, env.now);
      }
      m.request = null;
      return done();
    }
    case 'setRoomHost': {
      if (!teacher) return teacherOnly();
      const r = room(cmd.roomId);
      if (!r) return no('noRoom', '방이 없습니다.');
      if (!r.seats.includes(cmd.memberId)) return no('notSeated', '그 방에 앉은 학생에게만 관리권을 넘길 수 있습니다.');
      const m = c.members[cmd.memberId];
      if (!m?.sessionHash) return no('noMember', '연결이 있는 학생에게만 넘길 수 있습니다.');
      r.hostMemberId = m.id;
      notify(m, 'hostAssigned', r.name, env.now);
      effects.syncRooms.push(bump(r)); // 오래된 관리 권한은 방에서도 거절된다
      return done();
    }
    case 'lockJoin': {
      if (!teacher) return teacherOnly();
      c.locked = cmd.locked;
      return done();
    }
    case 'rotateInvite': {
      if (!teacher) return teacherOnly();
      c.inviteToken = env.newId(24);
      return done();
    }
    case 'announce': {
      if (!teacher) return teacherOnly();
      const text = cleanText(cmd.text, ANNOUNCE_MAX);
      if (!text) return no('badInput', '공지 내용을 입력하세요.');
      c.announcements = [...c.announcements, { id: c.nextAnnouncementId++, text, at: env.now }].slice(-ANNOUNCE_KEEP);
      return done();
    }
    case 'dismissHelp': {
      if (!teacher) return teacherOnly();
      c.helpRequests = c.helpRequests.filter((h) => h.memberId !== cmd.memberId);
      return done();
    }
    case 'setSettings': {
      if (!teacher) return teacherOnly();
      const s = { ...c.settings };
      if (cmd.capacity !== undefined) {
        if (cmd.capacity > env.maxCapacity) return no('badCapacity', `이 서버의 클래스 정원 상한은 ${env.maxCapacity}명입니다.`);
        if (cmd.capacity < studentCount(c)) return no('belowMembers', `이미 ${studentCount(c)}명이 들어와 있습니다.`);
        s.capacity = cmd.capacity;
      }
      if (cmd.roomCapMin !== undefined) s.roomCapMin = cmd.roomCapMin;
      if (cmd.roomCapMax !== undefined) s.roomCapMax = cmd.roomCapMax;
      if (cmd.roomCapDefault !== undefined) s.roomCapDefault = cmd.roomCapDefault;
      if (!(s.roomCapMin <= s.roomCapDefault && s.roomCapDefault <= s.roomCapMax)) return no('badRange', '최소 ≤ 기본 ≤ 최대 순서가 맞아야 합니다.');
      c.settings = s;
      return done();
    }
    case 'kickMember': {
      if (!teacher) return teacherOnly();
      const m = c.members[cmd.memberId];
      if (!m) return no('noMember', '참가자를 찾을 수 없습니다.');
      if (m.sessionHash) {
        if (!c.banned.includes(m.sessionHash)) c.banned.push(m.sessionHash);
        effects.closeSessions.push({ sessionHash: m.sessionHash, reason: 'kicked' });
      }
      m.request = null;
      m.designated = false;
      const r = m.assignment ? room(m.assignment) : undefined;
      if (r && r.status === 'waiting') {
        releaseSeat(c, r, m.id);
        effects.syncRooms.push(bump(r));
        delete c.members[m.id];
      } else if (r) {
        // 진행 중에는 자리를 자동 재배치하지 않는다: 연결만 끊고 자리는 남긴다
        m.sessionHash = null;
        if (r.hostMemberId === m.id) r.hostMemberId = null;
        effects.syncRooms.push(bump(r));
      } else {
        delete c.members[m.id];
      }
      c.helpRequests = c.helpRequests.filter((h) => h.memberId !== cmd.memberId);
      return done();
    }
    case 'reassignMember': {
      // 쿠키를 잃은 학생: 새로 들어온 세션을 원래 자리(학생 id)에 잇는다
      if (!teacher) return teacherOnly();
      const from = c.members[cmd.fromMemberId];
      const to = c.members[cmd.toMemberId];
      if (!from || !to || from.id === to.id || !from.sessionHash) return no('noMember', '참가자를 찾을 수 없습니다.');
      if (from.assignment) return no('fromAssigned', '새로 들어온 쪽이 이미 방에 배정되어 있습니다. 먼저 방에서 빼세요.');
      if (to.sessionHash) effects.closeSessions.push({ sessionHash: to.sessionHash, reason: 'replaced' });
      to.sessionHash = from.sessionHash;
      delete c.members[from.id];
      const r = to.assignment ? room(to.assignment) : undefined;
      if (r) effects.syncRooms.push(bump(r));
      return done();
    }
    case 'endClass': {
      if (!teacher) return teacherOnly();
      endClassInState(c, env.now);
      effects.syncRooms = activeRoomsIncludingClosing(c);
      effects.ended = true;
      c.revision++;
      c.lastActivity = env.now;
      return { ok: true, effects };
    }
  }
}

/** 봇을 방 좌석에 앉힌다 (정원 확인은 호출자가 한다) */
function seatBots(c: ClassState, r: ClassRoom, count: number, level: BotLevel, env: ClassEnv) {
  const taken = new Set(r.seats.map((id) => c.bots[id]?.nickname ?? c.members[id]?.nickname ?? ''));
  for (let i = 0; i < count; i++) {
    const nickname = botNickname(taken);
    taken.add(nickname);
    const id = env.newId(9);
    c.bots[id] = { id, nickname, level, roomId: r.id, createdAt: env.now };
    r.seats.push(id);
  }
}

function activeRoomsIncludingClosing(c: ClassState): string[] {
  return Object.values(c.rooms)
    .filter((r) => r.syncedVersion < r.syncVersion)
    .map((r) => r.id);
}

/** 수업 종료: 모든 방을 닫고(진행 중이면 ‘수업 종료로 중단’) 정리 목록에 올린다 */
export function endClassInState(c: ClassState, now: number) {
  for (const r of activeRooms(c)) closeRoomInState(c, r, 'classEnded', now);
  for (const m of Object.values(c.members)) {
    m.request = null;
    m.assignment = null;
  }
  c.ended = true;
  c.locked = true;
}

export function recordOp(c: ClassState, op: ClassState['ops'][number]) {
  c.ops.push(op);
  if (c.ops.length > OPS_KEEP) c.ops = c.ops.slice(-OPS_KEEP);
}

// ------------------------------------------------------------------ 게임방과의 약속 (내부 RPC)

export function buildSync(c: ClassState, roomId: string): ClassRoomSync | null {
  const r = c.rooms[roomId];
  if (!r) return null;
  return {
    classId: c.classId,
    className: c.name,
    roomId: r.id,
    syncVersion: r.syncVersion,
    name: r.name,
    capacity: r.capacity,
    hostMemberId: r.hostMemberId,
    members: r.seats.map((id) => {
      const b = c.bots[id];
      if (b) return { memberId: id, nickname: b.nickname, sessionHash: null, bot: { level: b.level } };
      const m = c.members[id];
      return { memberId: id, nickname: m?.nickname ?? '떠난 학생', sessionHash: m?.sessionHash ?? null };
    }),
    teacherHashes: c.teacher.sessionHashes.slice(),
    closed: r.status === 'closed',
    closeReason: r.closeReason,
  };
}

/** 방이 반영을 확인했다. 늦게 도착한 옛 확인이 새 확인을 덮지 않게 max 로 올린다. */
export function markSynced(c: ClassState, roomId: string, version: number): boolean {
  const r = c.rooms[roomId];
  if (!r || version <= r.syncedVersion) return false;
  r.syncedVersion = Math.min(version, r.syncVersion);
  r.syncAttempts = 0;
  r.nextSyncAt = 0;
  c.revision++;
  return true;
}

export function markSyncFailed(c: ClassState, roomId: string, now: number) {
  const r = c.rooms[roomId];
  if (!r) return;
  r.syncAttempts++;
  r.nextSyncAt = now + Math.min(30_000, 1000 * 2 ** Math.min(r.syncAttempts, 5));
}

export type LockResult = { ok: true } | { ok: false; code: string; message: string };

/**
 * 게임 시작 전 명단 잠금. 방이 본 명단 버전이 클래스의 최신·반영 완료 버전과 같아야 한다.
 * 잠긴 동안에는 승인·이동·신청이 모두 거절되어 진행 판에 새 학생이 끼어들 수 없다.
 */
export function lockForStart(c: ClassState, roomId: string, version: number, opId: string, now: number): LockResult {
  const r = c.rooms[roomId];
  if (!r || r.status === 'closed') return { ok: false, code: 'noRoom', message: '방이 닫혔습니다.' };
  if (c.ended) return { ok: false, code: 'ended', message: '수업이 끝났습니다.' };
  if (r.lock?.opId === opId) return { ok: true }; // 재전송
  if (r.status !== 'waiting') return { ok: false, code: 'roomLocked', message: '이미 시작된 방입니다.' };
  if (version !== r.syncVersion || r.syncedVersion < r.syncVersion) return { ok: false, code: 'staleRoster', message: '명단이 막 바뀌었습니다. 준비를 다시 확인하세요.' };
  if (r.seats.length !== r.capacity) return { ok: false, code: 'notFull', message: '정원이 차야 시작할 수 있습니다.' };
  r.status = 'playing';
  r.lock = { version, opId, at: now, gameId: null };
  clearRequestsForRoom(c, r, 'roomStarted', now);
  c.revision++;
  c.lastActivity = now;
  return { ok: true };
}

export function confirmStart(c: ClassState, roomId: string, opId: string, gameId: string): boolean {
  const r = c.rooms[roomId];
  if (!r?.lock || r.lock.opId !== opId) return false;
  if (r.lock.gameId === gameId) return false;
  r.lock.gameId = gameId;
  c.revision++;
  return true;
}

/** 방이 시작하지 못했다: 잠금을 푼다 (확정된 게임이 있으면 풀지 않는다) */
export function cancelStart(c: ClassState, roomId: string, opId: string): boolean {
  const r = c.rooms[roomId];
  if (!r?.lock || r.lock.opId !== opId || r.lock.gameId) return false;
  r.lock = null;
  if (r.status === 'playing') r.status = 'waiting';
  c.revision++;
  return true;
}

/** 게임이 끝나고 방이 대기실로 돌아갔다: 명단 잠금 해제 */
export function releaseRoster(c: ClassState, roomId: string, gameId: string): boolean {
  const r = c.rooms[roomId];
  if (!r || r.status === 'closed') return false;
  if (!r.lock) return false;
  if (r.lock.gameId && r.lock.gameId !== gameId) return false;
  r.lock = null;
  r.status = 'waiting';
  c.revision++;
  return true;
}

export interface RoomReport {
  roomId: string;
  syncVersion: number;
  readyCount: number;
  onlineCount: number;
  summary: RoomSummary;
}

/**
 * 방의 공개 진행 요약을 받는다. 게임이 끝났으면 상태를 finished 로.
 * statusChanged 가 아니면 교사 화면만 다시 그리면 된다 (학생 화면에는 요약이 없다).
 */
export function applyReport(c: ClassState, rep: RoomReport, now: number): { changed: boolean; statusChanged: boolean } {
  const r = c.rooms[rep.roomId];
  if (!r || r.status === 'closed') return { changed: false, statusChanged: false };
  const before = r.status;
  const beforeReady = r.report?.readyCount;
  r.report = { readyCount: rep.readyCount, onlineCount: rep.onlineCount, summary: rep.summary, at: now };
  if (r.lock && rep.summary.gameId && !r.lock.gameId && rep.summary.phase !== 'lobby') r.lock.gameId = rep.summary.gameId;
  if (r.status === 'playing' && rep.summary.phase === 'finished' && r.lock?.gameId === rep.summary.gameId) r.status = 'finished';
  c.lastActivity = now;
  c.revision++;
  return { changed: true, statusChanged: before !== r.status || beforeReady !== rep.readyCount };
}

/** 잠금 뒤 확인이 오지 않은 방 (방 상태를 직접 물어야 한다) */
export function unconfirmedLocks(c: ClassState, now: number): string[] {
  return Object.values(c.rooms)
    .filter((r) => r.lock && !r.lock.gameId && now - r.lock.at > LOCK_CONFIRM_TIMEOUT_MS)
    .map((r) => r.id);
}

/** 방이 알려 준 실제 상태로 잠금을 맞춘다 */
export function reconcileLock(c: ClassState, roomId: string, roomState: { gameId: string | null; phase: 'lobby' | 'playing' | 'finished' | 'gone' }): boolean {
  const r = c.rooms[roomId];
  if (!r?.lock) return false;
  if (roomState.gameId && roomState.phase !== 'lobby') {
    r.lock.gameId = roomState.gameId;
    if (roomState.phase === 'finished') r.status = 'finished';
  } else {
    r.lock = null;
    if (r.status !== 'closed') r.status = 'waiting';
  }
  c.revision++;
  return true;
}

export function pendingSyncs(c: ClassState, now: number): string[] {
  return Object.values(c.rooms)
    .filter((r) => r.syncedVersion < r.syncVersion && r.nextSyncAt <= now)
    .map((r) => r.id);
}

export function nextWakeAt(c: ClassState, now: number, ttlMs: number): number {
  let t = c.lastActivity + ttlMs;
  for (const r of Object.values(c.rooms)) {
    if (r.syncedVersion < r.syncVersion) t = Math.min(t, Math.max(now + 500, r.nextSyncAt || now + 2000));
    if (r.lock && !r.lock.gameId) t = Math.min(t, r.lock.at + LOCK_CONFIRM_TIMEOUT_MS + 500);
  }
  if (c.cleanup.length) t = Math.min(t, now + 3000);
  return Math.max(t, now + 500);
}

// ------------------------------------------------------------------ 화면용 projection

/** 운영 예시(고정 규칙 아님): 학생 수를 4~8명 방으로 나누는 방법 */
export function layoutSuggestions(students: number, min = 4, max = 8): string[] {
  const out: string[] = [];
  for (let size = max; size >= min; size--) {
    const rooms = Math.ceil(students / size);
    if (rooms < 1) continue;
    const base = Math.floor(students / rooms);
    const extra = students % rooms;
    if (base < min) continue;
    const desc = extra === 0 ? `${base}명 × ${rooms}방` : `${base + 1}명 × ${extra}방 + ${base}명 × ${rooms - extra}방`;
    if (!out.includes(desc)) out.push(desc);
  }
  return out.slice(0, 4);
}

export function projectClass(c: ClassState, viewer: Actor, online: Set<string>, env: ClassEnv): ClassView {
  const isT = viewer.kind === 'teacher';
  const me = viewer.kind === 'student' ? c.members[viewer.memberId] : undefined;
  const members = Object.values(c.members);
  const nick = (id: string | null) => (id ? (c.members[id]?.nickname ?? c.bots[id]?.nickname ?? null) : null);
  const ownsRoom = me ? activeRooms(c).find((r) => r.hostMemberId === me.id) : undefined;

  // 수업이 끝났으면 교사에게는 닫힌 방도 기록으로 보여 준다
  const listed = isT && c.ended ? Object.values(c.rooms) : activeRooms(c);
  const rooms: ClassRoomView[] = listed
    .sort((a, b) => a.createdAt - b.createdAt)
    .map((r) => {
      const base: ClassRoomView = {
        id: r.id,
        name: r.name,
        capacity: r.capacity,
        seatCount: r.seats.length,
        hostMemberId: r.hostMemberId,
        hostNickname: nick(r.hostMemberId),
        status: r.status,
        botCount: r.seats.filter((id) => !!c.bots[id]).length,
      };
      // 교사, 그리고 그 방의 방장·참가자만 자세한 명단을 본다. 다른 방의 단어판·정답·힌트·채팅은 여기에 없다.
      const involved = isT || (!!me && (r.seats.includes(me.id) || r.hostMemberId === me.id));
      if (!involved) return base;
      base.seats = r.seats.map((id) => (c.bots[id] ? { memberId: id, nickname: c.bots[id].nickname, online: true, bot: true } : { memberId: id, nickname: nick(id) ?? '떠난 학생', online: online.has(id) }));
      if (isT || r.hostMemberId === me?.id) {
        base.requests = members
          .filter((m) => m.request?.roomId === r.id)
          .sort((a, b) => (a.request?.at ?? 0) - (b.request?.at ?? 0))
          .map((m) => ({ memberId: m.id, nickname: m.nickname, at: m.request?.at ?? 0 }));
      }
      base.rosterVersion = r.syncVersion;
      base.synced = r.syncedVersion >= r.syncVersion;
      base.readyCount = r.report?.readyCount ?? 0;
      base.onlineCount = r.report?.onlineCount ?? 0;
      base.summary = isT ? (r.report?.summary ?? null) : null;
      return base;
    });

  const assignedRoom = me?.assignment ? c.rooms[me.assignment] : undefined;
  const view: ClassView = {
    classId: c.classId,
    name: c.name,
    revision: c.revision,
    serverNow: env.now,
    ended: c.ended,
    locked: c.locked,
    you: {
      role: isT ? 'teacher' : 'student',
      memberId: me?.id ?? null,
      nickname: isT ? '선생님' : (me?.nickname ?? ''),
      designated: !!me?.designated,
      assignment: assignedRoom && assignedRoom.status !== 'closed' ? { roomId: assignedRoom.id, synced: assignedRoom.syncedVersion >= assignedRoom.syncVersion } : null,
      request: me?.request ? { roomId: me.request.roomId } : null,
      ownsRoomId: ownsRoom?.id ?? null,
      notice: me?.notice ?? null,
      helpPending: !!me && c.helpRequests.some((h) => h.memberId === me.id),
    },
    settings: { ...c.settings, maxCapacity: env.maxCapacity, maxRooms: env.maxRooms },
    counts: {
      total: members.length,
      online: members.filter((m) => online.has(m.id)).length,
      unassigned: members.filter((m) => !m.assignment).length,
      rooms: rooms.length,
    },
    rooms,
    announcements: c.announcements.slice(),
    ttlHours: env.ttlHours,
  };
  if (isT) {
    view.members = members
      .sort((a, b) => a.joinedAt - b.joinedAt)
      .map(
        (m): ClassMemberView => ({
          id: m.id,
          nickname: m.nickname,
          online: online.has(m.id),
          designated: m.designated,
          assignment: m.assignment,
          request: m.request?.roomId ?? null,
          detached: !m.sessionHash,
          joinedAt: m.joinedAt,
        }),
      );
    view.inviteToken = c.inviteToken;
    view.helpRequests = c.helpRequests.map((h) => {
      const m = c.members[h.memberId];
      const r = m?.assignment ? c.rooms[m.assignment] : undefined;
      return { memberId: h.memberId, nickname: m?.nickname ?? '떠난 학생', roomId: r?.id ?? null, roomName: r?.name ?? null, at: h.at };
    });
  }
  return view;
}
