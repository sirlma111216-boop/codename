// 클래스 하나 = ClassroomDurableObject 하나. 참가자 membership, 교사·방장 권한, 방 메타데이터,
// 신청, 좌석 배정, 클래스 상태와 revision 을 관리한다. 좌석 배정의 최종 판단은 여기서만 한다.
//
// Durable Object 사이에는 하나의 DB 트랜잭션이 없으므로:
//  1) 클래스가 승인·예약을 먼저 저장하고
//  2) 게임방에 버전 붙은 전체 명단을 멱등 반영(classSync)한 뒤
//  3) 방이 확인하면 syncedVersion 을 올려 학생에게 ‘입장하기’를 보인다.
// 반영이 실패하면 좌석은 예약된 채로 두고(다른 학생에게 넘기지 않는다) alarm 으로 다시 보낸다.

import { DurableObject } from 'cloudflare:workers';
import { CLASS_MAX_CAPACITY_DEFAULT, CLASS_MAX_ROOMS_DEFAULT, MAX_MESSAGE_BYTES } from '../shared/constants.ts';
import { classClientMessageSchema, type ClassServerMessage } from '../shared/class-protocol.ts';
import { CLASS_PROTOCOL_VERSION } from '../shared/classroom.ts';
import {
  actorKey,
  addTeacherSession,
  applyClassCommand,
  applyReport,
  buildSync,
  cancelStart,
  classStatus,
  confirmStart,
  createClass,
  endClassInState,
  isTeacher,
  joinClass,
  lockForStart,
  markSynced,
  markSyncFailed,
  memberBySession,
  migrateClass,
  nextWakeAt,
  pendingSyncs,
  projectClass,
  reconcileLock,
  recordOp,
  releaseRoster,
  unconfirmedLocks,
  type Actor,
  type ClassEnv,
  type ClassState,
  type ClassStatus,
  type LockResult,
  type RoomReport,
} from './class-logic.ts';
import type { Env } from './env.ts';
import { randomToken, safeEqual } from './security.ts';

const STORAGE_KEY = 'class';
const TEACHER = 'teacher';
const RATE_CAPACITY = 20;
const RATE_REFILL_PER_SEC = 6;
/** 여러 명이 한꺼번에 움직일 때 방송을 묶는다 */
const BROADCAST_DELAY_MS = 120;

interface Attachment {
  /** 학생 id 또는 'teacher' */
  memberId: string;
  sessionHash: string;
}

export const CLOSE_CLASS = { kicked: 4403, gone: 4404, ended: 4410, protocol: 4426, replaced: 4409 } as const;

export class ClassroomDurableObject extends DurableObject<Env> {
  private state: ClassState | null | undefined = undefined;
  private rates = new WeakMap<WebSocket, { tokens: number; at: number }>();
  private failed = new Map<string, { code: string; message: string }>();
  private broadcastTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingScope: 'all' | 'teacher' | null = null;
  private syncing = new Set<string>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }

  private classEnv(): ClassEnv {
    return {
      now: Date.now(),
      newId: randomToken,
      maxCapacity: Math.max(1, Number(this.env.CLASS_MAX_STUDENTS) || CLASS_MAX_CAPACITY_DEFAULT),
      maxRooms: Math.max(1, Number(this.env.CLASS_MAX_ROOMS) || CLASS_MAX_ROOMS_DEFAULT),
      ttlHours: Math.max(1, Number(this.env.ROOM_TTL_HOURS) || 24),
    };
  }

  private async load(): Promise<ClassState | null> {
    if (this.state === undefined) this.state = migrateClass(await this.ctx.storage.get(STORAGE_KEY));
    return this.state;
  }

  /** 저장이 끝난 뒤에만 메모리 상태를 바꾼다. 실패하면 예외 → 성공 응답을 보내지 않는다. */
  private async persist(next: ClassState) {
    await this.ctx.storage.put(STORAGE_KEY, next);
    this.state = next;
    const env = this.classEnv();
    await this.ctx.storage.setAlarm(nextWakeAt(next, env.now, env.ttlHours * 3600_000));
  }

  private roomStub(roomId: string) {
    return this.env.ROOMS.get(this.env.ROOMS.idFromName(roomId));
  }

  // ------------------------------------------------------------------ 소켓·방송

  private sockets(): { ws: WebSocket; att: Attachment }[] {
    const out: { ws: WebSocket; att: Attachment }[] = [];
    for (const ws of this.ctx.getWebSockets()) {
      try {
        const att = ws.deserializeAttachment() as Attachment | null;
        if (att?.memberId) out.push({ ws, att });
      } catch {
        /* 아직 없음 */
      }
    }
    return out;
  }

  private online(): Set<string> {
    return new Set(this.sockets().map((s) => s.att.memberId));
  }

  private send(ws: WebSocket, msg: ClassServerMessage) {
    try {
      ws.send(JSON.stringify(msg));
    } catch {
      /* 닫힘 */
    }
  }

  private actorOf(c: ClassState, att: Attachment): Actor | null {
    if (att.memberId === TEACHER) return isTeacher(c, att.sessionHash) ? { kind: 'teacher', sessionHash: att.sessionHash } : null;
    const m = c.members[att.memberId];
    return m && m.sessionHash === att.sessionHash ? { kind: 'student', memberId: m.id } : null;
  }

  private sendView(ws: WebSocket, c: ClassState, actor: Actor, online: Set<string>) {
    this.send(ws, { t: 'class', view: projectClass(c, actor, online, this.classEnv()) });
  }

  /** 짧게 모았다가 한 번에 방송한다 (60명이 한꺼번에 들어와도 폭주하지 않게) */
  private scheduleBroadcast(scope: 'all' | 'teacher' = 'all') {
    this.pendingScope = this.pendingScope === 'all' || scope === 'all' ? 'all' : 'teacher';
    if (this.broadcastTimer) return;
    this.broadcastTimer = setTimeout(() => {
      this.broadcastTimer = null;
      const s = this.pendingScope;
      this.pendingScope = null;
      this.broadcastNow(s ?? 'all');
    }, BROADCAST_DELAY_MS);
  }

  private broadcastNow(scope: 'all' | 'teacher') {
    const c = this.state;
    if (!c) return;
    const online = this.online();
    for (const { ws, att } of this.sockets()) {
      if (scope === 'teacher' && att.memberId !== TEACHER) continue;
      const actor = this.actorOf(c, att);
      if (actor) this.sendView(ws, c, actor, online);
    }
  }

  private closeSessions(list: { sessionHash: string; reason: 'kicked' | 'replaced' }[]) {
    for (const x of list) {
      for (const s of this.sockets()) {
        if (s.att.sessionHash !== x.sessionHash || s.att.memberId === TEACHER) continue;
        this.send(s.ws, { t: 'bye', reason: x.reason });
        try {
          s.ws.close(x.reason === 'kicked' ? CLOSE_CLASS.kicked : CLOSE_CLASS.replaced, x.reason);
        } catch {
          /* 무시 */
        }
      }
    }
  }

  // ------------------------------------------------------------------ Worker 가 부르는 RPC

  async createClass(input: { classId: string; sessionHash: string; recoveryKeyHash: string; name: string; capacity: number }): Promise<{ ok: true; inviteToken: string } | { ok: false }> {
    if (await this.load()) return { ok: false };
    const c = createClass(input.classId, input.sessionHash, input.recoveryKeyHash, input.name, input.capacity, this.classEnv());
    await this.persist(c);
    return { ok: true, inviteToken: c.inviteToken };
  }

  async join(input: { sessionHash: string; inviteToken: string; nickname: string }): Promise<{ ok: true } | { ok: false; code: string }> {
    const c = await this.load();
    if (!c) return { ok: false, code: 'gone' };
    const next = structuredClone(c);
    const inviteOk = !!input.inviteToken && safeEqual(input.inviteToken, next.inviteToken);
    const res = joinClass(next, input.sessionHash, inviteOk, input.nickname, this.classEnv());
    if (!res.ok) return { ok: false, code: res.code };
    if (res.created) {
      await this.persist(next);
      this.scheduleBroadcast();
    }
    return { ok: true };
  }

  async status(sessionHash: string): Promise<ClassStatus> {
    return classStatus((await this.load()) ?? null, sessionHash);
  }

  async recoverTeacher(input: { sessionHash: string; keyHash: string }): Promise<{ ok: boolean }> {
    const c = await this.load();
    if (!c || c.ended) return { ok: false };
    if (!safeEqual(input.keyHash, c.teacher.recoveryKeyHash)) return { ok: false };
    const next = structuredClone(c);
    const rooms = addTeacherSession(next, input.sessionHash);
    await this.persist(next);
    this.scheduleBroadcast();
    for (const r of rooms) void this.syncRoom(r);
    return { ok: true };
  }

  // ------------------------------------------------------------------ 게임방이 부르는 RPC (내부 전용)

  async lockForStart(input: { roomId: string; version: number; opId: string }): Promise<LockResult> {
    const c = await this.load();
    if (!c) return { ok: false, code: 'gone', message: '클래스가 없습니다.' };
    const next = structuredClone(c);
    const res = lockForStart(next, input.roomId, input.version, input.opId, Date.now());
    if (!res.ok) return res;
    await this.persist(next);
    this.scheduleBroadcast();
    return res;
  }

  async confirmStart(input: { roomId: string; opId: string; gameId: string }): Promise<{ ok: boolean }> {
    const c = await this.load();
    if (!c) return { ok: false };
    const next = structuredClone(c);
    if (confirmStart(next, input.roomId, input.opId, input.gameId)) {
      await this.persist(next);
      this.scheduleBroadcast('teacher');
    }
    const r = next.rooms[input.roomId];
    return { ok: !!r?.lock && r.lock.opId === input.opId && r.lock.gameId === input.gameId };
  }

  async cancelStart(input: { roomId: string; opId: string }): Promise<{ ok: boolean }> {
    const c = await this.load();
    if (!c) return { ok: false };
    const next = structuredClone(c);
    if (cancelStart(next, input.roomId, input.opId)) {
      await this.persist(next);
      this.scheduleBroadcast();
    }
    return { ok: true };
  }

  async releaseRoster(input: { roomId: string; gameId: string }): Promise<{ ok: boolean }> {
    const c = await this.load();
    if (!c) return { ok: false };
    const next = structuredClone(c);
    if (releaseRoster(next, input.roomId, input.gameId)) {
      await this.persist(next);
      this.scheduleBroadcast();
    }
    const r = next.rooms[input.roomId];
    return { ok: !r || r.status === 'closed' || !r.lock };
  }

  async report(rep: RoomReport): Promise<{ ok: boolean }> {
    const c = await this.load();
    if (!c) return { ok: false };
    const next = structuredClone(c);
    const res = applyReport(next, rep, Date.now());
    if (res.changed) {
      await this.persist(next);
      this.scheduleBroadcast(res.statusChanged ? 'all' : 'teacher');
    }
    return { ok: true };
  }

  /** 방의 보존 기간 확인: 활성 수업의 방은 방 자체 TTL 로 지우지 않는다 */
  async roomAlive(roomId: string): Promise<boolean> {
    const c = await this.load();
    if (!c || c.ended) return false;
    const r = c.rooms[roomId];
    return !!r && r.status !== 'closed';
  }

  // ------------------------------------------------------------------ 클래스 → 게임방 반영

  /** 방에 최신 명단을 보낸다. 같은 방에 대한 반영은 한 번에 하나씩 (끝나면 더 새 버전이 있는지 다시 본다) */
  private async syncRoom(roomId: string): Promise<boolean> {
    if (this.syncing.has(roomId)) return false;
    this.syncing.add(roomId);
    try {
      for (let guard = 0; guard < 5; guard++) {
        const c = await this.load();
        if (!c) return false;
        const payload = buildSync(c, roomId);
        const r = c.rooms[roomId];
        if (!payload || !r || r.syncedVersion >= r.syncVersion) return true;
        let ok = false;
        try {
          const res = await this.roomStub(roomId).classSync(payload);
          ok = res.ok;
        } catch {
          ok = false;
        }
        const cur = await this.load();
        if (!cur) return false;
        const next = structuredClone(cur);
        if (ok) markSynced(next, roomId, payload.syncVersion);
        else markSyncFailed(next, roomId, Date.now());
        await this.persist(next);
        this.scheduleBroadcast();
        if (!ok) return false;
      }
      return true;
    } finally {
      this.syncing.delete(roomId);
    }
  }

  // ------------------------------------------------------------------ WebSocket

  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return new Response('WebSocket 전용', { status: 426 });
    const sessionHash = request.headers.get('X-Session-Hash') ?? '';
    const c = await this.load();
    if (!c) return new Response('gone', { status: 404 });
    let memberId: string;
    if (isTeacher(c, sessionHash)) memberId = TEACHER; // 수업이 끝나도 교사는 기록을 본다 (명령은 거절)
    else {
      if (c.ended) return new Response('ended', { status: 410 });
      if (c.banned.includes(sessionHash)) return new Response('banned', { status: 403 });
      const m = memberBySession(c, sessionHash);
      if (!m) return new Response('not a member', { status: 403 });
      memberId = m.id;
    }
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ memberId, sessionHash } satisfies Attachment);
    this.scheduleBroadcast(); // 접속 표시가 바뀌었다
    return new Response(null, { status: 101, webSocket: client });
  }

  private rateOk(ws: WebSocket): boolean {
    const now = Date.now();
    const b = this.rates.get(ws) ?? { tokens: RATE_CAPACITY, at: now };
    b.tokens = Math.min(RATE_CAPACITY, b.tokens + ((now - b.at) / 1000) * RATE_REFILL_PER_SEC);
    b.at = now;
    const ok = b.tokens >= 1;
    if (ok) b.tokens -= 1;
    this.rates.set(ws, b);
    return ok;
  }

  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== 'string' || message.length > MAX_MESSAGE_BYTES) return this.send(ws, { t: 'error', code: 'badMessage', message: '메시지 형식이 다릅니다.' });
    if (!this.rateOk(ws)) return this.send(ws, { t: 'error', code: 'rateLimited', message: '너무 빠르게 보내고 있습니다.' });
    let parsed;
    try {
      parsed = classClientMessageSchema.safeParse(JSON.parse(message));
    } catch {
      parsed = null;
    }
    if (!parsed?.success) return this.send(ws, { t: 'error', code: 'badMessage', message: '알 수 없는 메시지입니다.' });
    const msg = parsed.data;
    const c = await this.load();
    const att = ws.deserializeAttachment() as Attachment | null;
    if (!c || !att) {
      this.send(ws, { t: 'bye', reason: 'classEnded' });
      ws.close(CLOSE_CLASS.gone, 'gone');
      return;
    }
    if (c.ended && att.memberId !== TEACHER) {
      this.send(ws, { t: 'bye', reason: 'classEnded' });
      ws.close(CLOSE_CLASS.ended, 'ended');
      return;
    }
    const actor = this.actorOf(c, att);
    if (!actor) {
      this.send(ws, { t: 'bye', reason: 'kicked' });
      ws.close(CLOSE_CLASS.kicked, 'not a member');
      return;
    }

    if (msg.t === 'hello') {
      if (msg.protocol !== CLASS_PROTOCOL_VERSION) {
        this.send(ws, { t: 'bye', reason: 'protocol' });
        ws.close(CLOSE_CLASS.protocol, 'protocol');
        return;
      }
      this.send(ws, { t: 'hello', protocol: CLASS_PROTOCOL_VERSION, serverNow: Date.now() });
      this.sendView(ws, c, actor, this.online());
      return;
    }

    // ---- 명령: 멱등(opId) → 적용 → 저장 → 응답 → 방 반영 → 방송
    const key = actorKey(actor);
    const prior = c.ops.find((o) => o.id === msg.opId && o.actor === key);
    if (prior) {
      this.send(ws, prior.ok ? { t: 'ack', opId: msg.opId, ok: true, result: prior.roomId ? { roomId: prior.roomId } : undefined } : { t: 'ack', opId: msg.opId, ok: false, code: prior.code ?? 'error', message: prior.message ?? '' });
      this.sendView(ws, c, actor, this.online());
      // 이전 시도에서 방 반영이 남아 있으면 이어서 보낸다
      for (const r of pendingSyncs(c, Date.now())) void this.syncRoom(r);
      return;
    }
    const failKey = `${key}:${msg.opId}`;
    const priorFail = this.failed.get(failKey);
    if (priorFail) {
      this.send(ws, { t: 'ack', opId: msg.opId, ok: false, ...priorFail });
      return;
    }
    const next = structuredClone(c);
    const res = applyClassCommand(next, actor, msg.cmd, this.classEnv());
    if (!res.ok) {
      this.failed.set(failKey, { code: res.code, message: res.message });
      if (this.failed.size > 1000) this.failed.clear();
      this.send(ws, { t: 'ack', opId: msg.opId, ok: false, code: res.code, message: res.message });
      this.sendView(ws, c, actor, this.online());
      return;
    }
    recordOp(next, { id: msg.opId, actor: key, ok: true, roomId: res.effects.roomId });
    try {
      await this.persist(next);
    } catch {
      this.state = undefined;
      this.send(ws, { t: 'ack', opId: msg.opId, ok: false, code: 'storageFailed', message: '저장에 실패했습니다. 다시 시도하세요.' });
      return;
    }
    this.send(ws, { t: 'ack', opId: msg.opId, ok: true, result: res.effects.roomId ? { roomId: res.effects.roomId } : undefined });
    this.closeSessions(res.effects.closeSessions);
    this.scheduleBroadcast();
    if (res.effects.ended) {
      // 수업 종료: 방에 닫힘을 반영하고, 클래스 소켓을 닫는다
      for (const r of res.effects.syncRooms) void this.syncRoom(r);
      this.broadcastNow('all');
      for (const s of this.sockets()) {
        if (s.att.memberId === TEACHER) continue;
        this.send(s.ws, { t: 'bye', reason: 'classEnded' });
        try {
          s.ws.close(CLOSE_CLASS.ended, 'ended');
        } catch {
          /* 무시 */
        }
      }
      return;
    }
    for (const r of res.effects.syncRooms) void this.syncRoom(r);
  }

  override async webSocketClose(ws: WebSocket): Promise<void> {
    try {
      ws.close(1000, 'bye');
    } catch {
      /* 닫힘 */
    }
    this.scheduleBroadcast();
  }

  override async webSocketError(): Promise<void> {
    this.scheduleBroadcast();
  }

  // ------------------------------------------------------------------ 재시도·복구·정리 (alarm)

  override async alarm(): Promise<void> {
    const c = await this.load();
    if (!c) {
      await this.ctx.storage.deleteAll();
      return;
    }
    const env = this.classEnv();
    const now = env.now;

    // 1) 보존 기간이 지났으면 수업을 끝내고 방 정리 목록에 올린다
    if (!c.ended && now - c.lastActivity >= env.ttlHours * 3600_000) {
      const next = structuredClone(c);
      endClassInState(next, now);
      next.revision++;
      await this.persist(next);
    }

    // 2) 반영이 밀린 방에 다시 보낸다
    for (const r of pendingSyncs((await this.load()) as ClassState, now)) await this.syncRoom(r);

    // 3) 시작 잠금 뒤 확인이 없는 방: 방에게 실제 상태를 묻고 맞춘다
    for (const roomId of unconfirmedLocks((await this.load()) as ClassState, now)) {
      let st: { gameId: string | null; phase: 'lobby' | 'playing' | 'finished' | 'gone' };
      try {
        st = await this.roomStub(roomId).statusForClass();
      } catch {
        continue;
      }
      const cur = (await this.load()) as ClassState;
      const next = structuredClone(cur);
      if (reconcileLock(next, roomId, st)) {
        await this.persist(next);
        this.scheduleBroadcast();
      }
    }

    // 4) 닫힌 방 정리 (실패하면 다음 alarm 에서 이어 간다)
    const cur = (await this.load()) as ClassState;
    const remaining: string[] = [];
    for (const roomId of cur.cleanup) {
      try {
        const res = await this.roomStub(roomId).purgeForClass(cur.classId);
        if (!res.ok) remaining.push(roomId);
      } catch {
        remaining.push(roomId);
      }
    }
    const after = structuredClone((await this.load()) as ClassState);
    after.cleanup = after.cleanup.filter((id) => remaining.includes(id) || !cur.cleanup.includes(id));
    // 정리가 끝난 수업은 보존 기간 뒤 저장소까지 비운다
    if (after.ended && after.cleanup.length === 0 && now - after.lastActivity >= env.ttlHours * 3600_000) {
      for (const s of this.sockets()) {
        try {
          s.ws.close(CLOSE_CLASS.ended, 'ended');
        } catch {
          /* 무시 */
        }
      }
      await this.ctx.storage.deleteAll();
      this.state = null;
      return;
    }
    await this.persist(after);
  }
}
