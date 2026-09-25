// 게임방 하나 = GameRoomDurableObject 하나. 보드·비밀 정보·턴·역할·게임 기록을 관리한다.
// 독립 방(초대 링크)과 학급 방(클래스가 명단을 보냄) 두 가지로 쓰인다.
// WebSocket Hibernation API 를 쓴다: 깨어나면 메모리는 비어 있으므로 상태는 저장소에서,
// 참가자 정보는 소켓 attachment 에서 복원한다.

import { DurableObject } from 'cloudflare:workers';
import type { ClassRoomSync } from '../shared/classroom.ts';
import { CLOSE, MAX_MESSAGE_BYTES, clientMessageSchema, type ClientMessage, type Command, type ServerMessage } from '../shared/protocol.ts';
import type { SoloConfig } from '../shared/bots.ts';
import { PROTOCOL_VERSION } from '../shared/view.ts';
import {
  applyClassSync,
  applyCommand,
  classStartProblems,
  createRoom,
  createSoloRoom,
  isSpymasterViewer,
  isTeacherSession,
  joinRoom,
  maybeTransferHost,
  memberBySession,
  migrateRoom,
  projectRoom,
  recordDedup,
  roomSummary,
  TEACHER_ID,
  type Member,
  type RoomEnv,
  type RoomState,
} from './room-logic.ts';
import { botDelayMs, decideBotCommand, fallbackBotCommand, markBotFailed, nextBotTask, recordBotDecision, type BotTask } from './bots/room-bots.ts';
import { randomToken, safeEqual } from './security.ts';
import type { Env } from './env.ts';

interface Attachment {
  memberId: string;
  sessionHash: string;
}

const STORAGE_KEY = 'room';
const TOMBSTONE_KEY = 'tombstone';
const RATE_CAPACITY = 20;
const RATE_REFILL_PER_SEC = 6;
/** 학급 방: 활동이 없어도 이 기간은 클래스에 먼저 묻고 지운다 */
const CLASS_ROOM_CHECK_MS = 6 * 3600_000;
const TOMBSTONE_TTL_MS = 3 * 24 * 3600_000;

export type RoomStatus = 'member' | 'notMember' | 'gone' | 'banned';

/** 학생 방장이 없는 학급 방에서 선생님이 방장으로 쓸 수 있는 명령 */
function teacherHostAllowed(cmd: Command): boolean {
  if (cmd.type === 'game') return cmd.action.type === 'abort' || cmd.action.type === 'replaceSpymaster';
  return ['startGame', 'autoBalance', 'backToLobby', 'setSettings', 'setBotSeat', 'setWatchKey'].includes(cmd.type);
}

/** 관전하는 선생님을 명령 적용용으로 나타낸 값 (방 참가자 목록에는 없다) */
const teacherActor = (sessionHash: string): Member => ({ id: TEACHER_ID, nickname: '선생님', sessionHash, joinedAt: 0, team: null, role: 'spectator' });

export class GameRoomDurableObject extends DurableObject<Env> {
  /** undefined = 아직 안 읽음, null = 방 없음 */
  private room: RoomState | null | undefined = undefined;
  private rates = new WeakMap<WebSocket, { tokens: number; at: number }>();
  /** 실패한 명령의 멱등 기록(메모리). 성공한 명령은 상태와 함께 저장된다. */
  private failedCommands = new Map<string, { code: string; message: string }>();
  private lastReport = '';

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // 연결 유지용 ping 은 객체를 깨우지 않고 런타임이 바로 응답한다.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }

  private roomEnv(): RoomEnv {
    return {
      now: Date.now(),
      newId: randomToken,
      ttlHours: Math.max(1, Number(this.env.ROOM_TTL_HOURS) || 24),
      hostGraceSeconds: Math.max(30, Number(this.env.HOST_GRACE_SECONDS) || 180),
    };
  }

  private async load(): Promise<RoomState | null> {
    if (this.room === undefined) {
      const raw = await this.ctx.storage.get(STORAGE_KEY);
      this.room = migrateRoom(raw);
    }
    return this.room;
  }

  /** 사람(참가자 또는 관전 교사)이 한 명이라도 연결되어 있는가. 아무도 없으면 봇은 쉰다. */
  private hasHumans(room: RoomState): boolean {
    return this.sockets().some((s) => this.validSocket(room, s.att));
  }

  /** 봇이 할 일을 예약한다. 같은 상황이면 기존 예약을 그대로 둔다. */
  private planBots(next: RoomState) {
    const task = this.hasHumans(next) ? nextBotTask(next) : null;
    if (!task) {
      next.botTimer = null;
      return;
    }
    if (next.botTimer?.key === task.key) return;
    next.botTimer = { key: task.key, memberId: task.memberId, kind: task.kind, at: Date.now() + botDelayMs(next, task) };
  }

  /** 저장이 끝난 뒤에만 메모리 상태를 바꾼다. 실패하면 예외가 올라가고 전송하지 않는다. */
  private async persist(next: RoomState): Promise<void> {
    this.planBots(next);
    await this.ctx.storage.put(STORAGE_KEY, next);
    this.room = next;
    const env = this.roomEnv();
    let at: number;
    if (next.classLink) {
      // 학급 방은 부모 클래스와 수명을 맞춘다: 자체 TTL 로 지우지 않고, 오래 조용하면 클래스에 먼저 묻는다
      at = next.lastActivity + CLASS_ROOM_CHECK_MS;
      if (next.classLink.pendingConfirm || next.classLink.pendingRelease) at = Date.now() + 3000;
    } else {
      at = next.lastActivity + env.ttlHours * 3600_000;
      if (next.hostOfflineSince !== null) at = Math.min(at, next.hostOfflineSince + env.hostGraceSeconds * 1000 + 1000);
    }
    let floor = Date.now() + 1000;
    if (next.botTimer && next.botTimer.at < at) {
      at = next.botTimer.at;
      floor = Date.now() + 150;
    }
    await this.ctx.storage.setAlarm(Math.max(at, floor));
  }

  private classStub(classId: string) {
    return this.env.CLASSES.get(this.env.CLASSES.idFromName(classId));
  }

  private sockets(): { ws: WebSocket; att: Attachment }[] {
    const out: { ws: WebSocket; att: Attachment }[] = [];
    for (const ws of this.ctx.getWebSockets()) {
      try {
        const att = ws.deserializeAttachment() as Attachment | null;
        if (att?.memberId) out.push({ ws, att });
      } catch {
        /* 아직 attachment 가 없는 소켓 */
      }
    }
    return out;
  }

  private online(): Set<string> {
    return new Set(this.sockets().map((s) => s.att.memberId));
  }

  private send(ws: WebSocket, msg: ServerMessage) {
    try {
      ws.send(JSON.stringify(msg));
    } catch {
      /* 이미 닫힌 소켓 */
    }
  }

  private sendState(ws: WebSocket, room: RoomState, memberId: string, online = this.online()) {
    this.send(ws, { t: 'state', room: projectRoom(room, memberId, online, this.roomEnv()) });
  }

  /** 이 소켓이 아직 유효한가: 명단의 그 세션이거나, 관전 권한이 있는 교사 세션 */
  private validSocket(room: RoomState, att: Attachment): boolean {
    if (att.memberId === TEACHER_ID) return isTeacherSession(room, att.sessionHash);
    const m = room.members[att.memberId];
    return !!m && m.sessionHash === att.sessionHash;
  }

  private broadcast(room: RoomState, scope: 'all' | 'spymasters' = 'all') {
    const online = this.online();
    for (const { ws, att } of this.sockets()) {
      if (!this.validSocket(room, att)) continue;
      // 비공개 채널 변경은 스파이마스터에게만 보낸다. 추측자·교사에게는 전송 시점조차 새지 않게 한다.
      if (scope === 'spymasters' && !isSpymasterViewer(room, att.memberId)) continue;
      this.sendState(ws, room, att.memberId, online);
    }
  }

  private closeSessionSockets(hashes: string[], reason: 'kicked' | 'replaced' | 'closed' | 'removed') {
    if (!hashes.length) return;
    for (const s of this.sockets()) {
      if (!hashes.includes(s.att.sessionHash)) continue;
      this.send(s.ws, { t: 'bye', reason });
      try {
        s.ws.close(reason === 'kicked' ? CLOSE.kicked : reason === 'replaced' ? CLOSE.replaced : reason === 'removed' ? CLOSE.removed : CLOSE.gone, reason);
      } catch {
        /* 무시 */
      }
    }
  }

  /** 학급 방: 공개 진행 요약을 클래스에 알린다 (바뀐 경우에만, 실패해도 게임은 계속) */
  private reportToClass(room: RoomState) {
    const link = room.classLink;
    if (!link || link.closed) return;
    const rep = { roomId: room.roomId, syncVersion: link.syncVersion, ...roomSummary(room, this.online()) };
    const sig = JSON.stringify(rep);
    if (sig === this.lastReport) return;
    this.lastReport = sig;
    this.classStub(link.classId)
      .report(rep)
      .catch(() => {
        this.lastReport = ''; // 다음 변화 때 다시 보낸다
      });
  }

  // ------------------------------------------------------------------ RPC (Worker 가 호출)

  async create(input: { roomId: string; sessionHash: string; nickname: string }): Promise<{ ok: true; inviteToken: string } | { ok: false }> {
    const existing = await this.load();
    if (existing || (await this.ctx.storage.get(TOMBSTONE_KEY))) return { ok: false };
    const room = createRoom(input.roomId, input.sessionHash, input.nickname, this.roomEnv());
    await this.persist(room);
    return { ok: true, inviteToken: room.inviteToken };
  }

  /** 혼자 하기: 나 + 봇으로 방을 만들고 바로 게임을 시작한다. 봇은 내가 접속하면 움직이기 시작한다. */
  async createSolo(input: { roomId: string; sessionHash: string; nickname: string; config: SoloConfig }): Promise<{ ok: true } | { ok: false; code: string; message: string }> {
    const existing = await this.load();
    if (existing || (await this.ctx.storage.get(TOMBSTONE_KEY))) return { ok: false, code: 'exists', message: '이미 있는 방입니다.' };
    const env = this.roomEnv();
    const room = createSoloRoom(input.roomId, input.sessionHash, input.nickname, input.config, env);
    const host = room.members[room.hostId] as Member;
    const res = applyCommand(room, host, { t: 'cmd', commandId: `solo-${randomToken(9)}`, cmd: { type: 'startGame' } }, env, new Set([host.id]));
    if (!res.ok) return { ok: false, code: res.code, message: res.message };
    await this.persist(room);
    return { ok: true };
  }

  async join(input: { sessionHash: string; inviteToken: string; nickname: string }): Promise<{ ok: true } | { ok: false; code: string }> {
    const room = await this.load();
    if (!room) return { ok: false, code: 'gone' };
    const next = structuredClone(room);
    const inviteOk = !!input.inviteToken && !!next.inviteToken && safeEqual(input.inviteToken, next.inviteToken);
    const res = joinRoom(next, input.sessionHash, inviteOk, input.nickname, this.roomEnv());
    if (!res.ok) return { ok: false, code: res.code };
    if (res.created) {
      await this.persist(next);
      this.broadcast(next);
    }
    return { ok: true };
  }

  async status(sessionHash: string): Promise<RoomStatus> {
    const room = await this.load();
    if (!room || room.classLink?.closed) return 'gone';
    if (room.banned.includes(sessionHash)) return 'banned';
    if (isTeacherSession(room, sessionHash)) return 'member'; // 교사는 공개 관전만 한다
    return memberBySession(room, sessionHash) ? 'member' : 'notMember';
  }

  // ------------------------------------------------------------------ 클래스가 부르는 RPC (내부 전용)

  /** 클래스 명단 반영. 버전으로 멱등 처리하고, 닫힌 방은 묘비만 남긴다. */
  async classSync(p: ClassRoomSync): Promise<{ ok: boolean; version: number }> {
    if (await this.ctx.storage.get(TOMBSTONE_KEY)) return { ok: true, version: p.syncVersion };
    const room = await this.load();
    const out = applyClassSync(room ? structuredClone(room) : null, p, this.roomEnv());
    if (out.result === 'mismatch') return { ok: false, version: 0 };
    if (out.result === 'stale' || out.result === 'ignored' || !out.room) return { ok: true, version: p.syncVersion };
    await this.persist(out.room);
    for (const reason of ['removed', 'replaced'] as const) {
      this.closeSessionSockets(
        out.closeSessions.filter((x) => x.reason === reason).map((x) => x.sessionHash),
        reason,
      );
    }
    if (out.closedNow) {
      this.broadcast(out.room); // 중단된 결과를 한 번 보여 주고
      this.closeSessionSockets(this.sockets().map((s) => s.att.sessionHash), 'closed');
      return { ok: true, version: p.syncVersion };
    }
    this.broadcast(out.room);
    this.reportToClass(out.room);
    return { ok: true, version: p.syncVersion };
  }

  /** 클래스의 잠금 복구용: 이 방에 진행 중(또는 끝난) 게임이 있는가 */
  async statusForClass(): Promise<{ gameId: string | null; phase: 'lobby' | 'playing' | 'finished' | 'gone' }> {
    const room = await this.load();
    if (!room) return { gameId: null, phase: 'gone' };
    if (!room.game) return { gameId: null, phase: 'lobby' };
    return { gameId: room.game.gameId, phase: room.game.phase === 'finished' ? 'finished' : 'playing' };
  }

  /** 수업 종료·방 폐쇄 뒤 정리. 다시 만들어지지 않게 짧은 묘비를 남기고 나머지는 지운다. */
  async purgeForClass(classId: string): Promise<{ ok: boolean }> {
    const room = await this.load();
    if (room && room.classLink?.classId !== classId) return { ok: false };
    this.closeSessionSockets(this.sockets().map((s) => s.att.sessionHash), 'closed');
    await this.ctx.storage.deleteAll();
    await this.ctx.storage.put(TOMBSTONE_KEY, { classId, at: Date.now() });
    await this.ctx.storage.setAlarm(Date.now() + TOMBSTONE_TTL_MS);
    this.room = null;
    return { ok: true };
  }

  // ------------------------------------------------------------------ WebSocket

  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return new Response('WebSocket 전용', { status: 426 });
    const sessionHash = request.headers.get('X-Session-Hash') ?? '';
    const room = await this.load();
    if (!room || room.classLink?.closed) return new Response('gone', { status: 404 });
    if (room.banned.includes(sessionHash)) return new Response('banned', { status: 403 });
    const member = memberBySession(room, sessionHash);
    const teacher = !member && isTeacherSession(room, sessionHash);
    if (!member && !teacher) return new Response('not a member', { status: 403 });

    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ memberId: member ? member.id : TEACHER_ID, sessionHash } satisfies Attachment);

    const next = structuredClone(room);
    next.lastActivity = Date.now();
    if (!next.classLink) maybeTransferHost(next, this.online(), this.roomEnv());
    await this.persist(next);
    this.broadcast(next);
    this.reportToClass(next);
    return new Response(null, { status: 101, webSocket: client });
  }

  private rateOk(ws: WebSocket): boolean {
    const now = Date.now();
    const b = this.rates.get(ws) ?? { tokens: RATE_CAPACITY, at: now };
    b.tokens = Math.min(RATE_CAPACITY, b.tokens + ((now - b.at) / 1000) * RATE_REFILL_PER_SEC);
    b.at = now;
    if (b.tokens < 1) {
      this.rates.set(ws, b);
      return false;
    }
    b.tokens -= 1;
    this.rates.set(ws, b);
    return true;
  }

  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== 'string' || message.length > MAX_MESSAGE_BYTES) {
      this.send(ws, { t: 'error', code: 'badMessage', message: '메시지가 너무 크거나 형식이 다릅니다.' });
      return;
    }
    if (!this.rateOk(ws)) {
      this.send(ws, { t: 'error', code: 'rateLimited', message: '너무 빠르게 보내고 있습니다. 잠시 뒤 다시 시도하세요.' });
      return;
    }
    let parsed;
    try {
      parsed = clientMessageSchema.safeParse(JSON.parse(message));
    } catch {
      parsed = null;
    }
    if (!parsed || !parsed.success) {
      this.send(ws, { t: 'error', code: 'badMessage', message: '알 수 없는 메시지입니다.' });
      return;
    }
    const msg = parsed.data;
    const att = ws.deserializeAttachment() as Attachment | null;
    const room = await this.load();
    if (!room || room.classLink?.closed) {
      this.send(ws, { t: 'bye', reason: 'closed' });
      ws.close(CLOSE.gone, 'gone');
      return;
    }
    if (!att || !this.validSocket(room, att)) {
      this.send(ws, { t: 'bye', reason: 'kicked' });
      ws.close(CLOSE.kicked, 'not a member');
      return;
    }

    if (msg.t === 'hello') {
      if (msg.protocol !== PROTOCOL_VERSION) {
        this.send(ws, { t: 'bye', reason: 'protocol' });
        ws.close(CLOSE.protocol, 'protocol mismatch');
        return;
      }
      this.send(ws, { t: 'hello', protocol: PROTOCOL_VERSION, memberId: att.memberId, serverNow: Date.now() });
      this.sendState(ws, room, att.memberId);
      return;
    }

    const asTeacher = att.memberId === TEACHER_ID;
    if (asTeacher && !(room.classLink && room.hostId === TEACHER_ID && teacherHostAllowed(msg.cmd))) {
      // 교사의 관전은 공개 정보만 본다. 게임 행동·채팅은 보낼 수 없다.
      // 학생 방장이 없는 방(선생님이 만든 방 등)에서만 시작·중단 같은 방장 일을 대신한다.
      this.send(ws, { t: 'ack', commandId: msg.commandId, ok: false, code: 'forbidden', message: '관전 중인 선생님은 게임 행동을 할 수 없습니다.' });
      return;
    }
    const me = asTeacher ? teacherActor(att.sessionHash) : room.members[att.memberId];
    if (!me) return;

    // ---- 명령: 멱등 처리 → 적용 → 저장 → 응답 → 전송
    const dedupKey = `${me.id}:${msg.commandId}`;
    const prior = room.dedup.find((d) => d.id === msg.commandId && d.memberId === me.id);
    if (prior) {
      this.send(ws, prior.ok ? { t: 'ack', commandId: msg.commandId, ok: true } : { t: 'ack', commandId: msg.commandId, ok: false, code: prior.code ?? 'error', message: prior.message ?? '' });
      this.sendState(ws, room, me.id);
      return;
    }
    const priorFail = this.failedCommands.get(dedupKey);
    if (priorFail) {
      this.send(ws, { t: 'ack', commandId: msg.commandId, ok: false, ...priorFail });
      this.sendState(ws, room, me.id);
      return;
    }

    if (room.classLink && msg.cmd.type === 'startGame') {
      await this.startClassGame(ws, me.id, msg);
      return;
    }

    const env = this.roomEnv();
    const next = structuredClone(room);
    const meNext = asTeacher ? teacherActor(att.sessionHash) : next.members[me.id];
    if (!meNext) return;
    const res = applyCommand(next, meNext, msg, env, this.online());
    if (!res.ok) {
      this.failedCommands.set(dedupKey, { code: res.code, message: res.message });
      if (this.failedCommands.size > 500) this.failedCommands.clear();
      this.send(ws, { t: 'ack', commandId: msg.commandId, ok: false, code: res.code, message: res.message });
      if (res.sendState) this.sendState(ws, room, me.id);
      return;
    }
    recordDedup(next, { id: msg.commandId, memberId: me.id, ok: true });

    if (res.effects.closeRoom) {
      await this.destroy('closed');
      return;
    }

    try {
      await this.persist(next);
    } catch {
      // 저장 실패: 성공 메시지를 보내지 않고, 저장소 기준으로 다시 읽는다.
      this.room = undefined;
      console.error('room persist failed');
      this.send(ws, { t: 'ack', commandId: msg.commandId, ok: false, code: 'storageFailed', message: '저장에 실패했습니다. 다시 시도하세요.' });
      return;
    }

    this.send(ws, { t: 'ack', commandId: msg.commandId, ok: true });

    if (res.effects.remapSession) {
      const { sessionHash, memberId } = res.effects.remapSession;
      for (const s of this.sockets()) {
        if (s.att.sessionHash === sessionHash) s.ws.serializeAttachment({ memberId, sessionHash } satisfies Attachment);
      }
    }
    for (const c of res.effects.closeSessions) {
      for (const s of this.sockets()) {
        if (s.att.sessionHash !== c.sessionHash) continue;
        // 재지정의 경우 새 세션 소켓은 위에서 새 자리로 옮겨졌다. 옛 세션 소켓만 닫는다.
        if (c.reason === 'replaced' && res.effects.remapSession?.sessionHash === c.sessionHash) continue;
        this.send(s.ws, { t: 'bye', reason: c.reason });
        s.ws.close(c.reason === 'kicked' ? CLOSE.kicked : CLOSE.replaced, c.reason);
      }
    }
    this.broadcast(next, res.scope);
    if (next.classLink) {
      if (next.classLink.pendingRelease) await this.releaseToClass();
      this.reportToClass(this.room ?? next);
    }
  }

  /**
   * 학급 방의 게임 시작: 클래스가 이 명단 버전을 잠근 뒤에만 시작한다.
   * 잠금 → 게임 생성·저장 → 클래스에 확정. 저장이 실패하면 잠금을 푼다.
   * blockConcurrencyWhile 로 이 사이에 다른 명령·명단 반영이 끼어들지 못하게 한다.
   */
  private async startClassGame(ws: WebSocket, memberId: string, msg: Extract<ClientMessage, { t: 'cmd' }>) {
    await this.ctx.blockConcurrencyWhile(async () => {
      const room = await this.load();
      const link = room?.classLink;
      const me = memberId === TEACHER_ID ? teacherActor('') : room?.members[memberId];
      const fail = (code: string, message: string) => this.send(ws, { t: 'ack', commandId: msg.commandId, ok: false, code, message });
      if (!room || !link || !me) return fail('gone', '방이 없습니다.');
      if (room.hostId !== me.id) return fail('forbidden', '방장만 시작할 수 있습니다.');
      if (room.game) return fail('locked', '이미 게임이 진행 중입니다.');
      const problems = classStartProblems(room, this.online());
      if (problems.length) return fail('notReady', problems.join(' '));

      let lock;
      try {
        lock = await this.classStub(link.classId).lockForStart({ roomId: room.roomId, version: link.syncVersion, opId: msg.commandId });
      } catch {
        return fail('classUnavailable', '클래스 서버에 연결하지 못했습니다. 잠시 뒤 다시 시도하세요.');
      }
      if (!lock.ok) return fail(lock.code, lock.message);

      const env = this.roomEnv();
      const next = structuredClone(room);
      const meNext = memberId === TEACHER_ID ? me : (next.members[me.id] as NonNullable<typeof me>);
      const res = applyCommand(next, meNext, msg, env, this.online(), { classStartApproved: true });
      if (!res.ok || !next.game || !next.classLink) {
        await this.classStub(link.classId).cancelStart({ roomId: room.roomId, opId: msg.commandId }).catch(() => {});
        return fail(res.ok ? 'error' : res.code, res.ok ? '시작하지 못했습니다.' : res.message);
      }
      recordDedup(next, { id: msg.commandId, memberId: me.id, ok: true });
      next.classLink.pendingConfirm = { opId: msg.commandId, gameId: next.game.gameId };
      try {
        await this.persist(next);
      } catch {
        this.room = undefined;
        await this.classStub(link.classId).cancelStart({ roomId: room.roomId, opId: msg.commandId }).catch(() => {});
        return fail('storageFailed', '저장에 실패했습니다. 다시 시도하세요.');
      }
      this.send(ws, { t: 'ack', commandId: msg.commandId, ok: true });
      this.broadcast(next);
      await this.confirmToClass();
      this.reportToClass(this.room ?? next);
    });
  }

  private async confirmToClass() {
    const room = await this.load();
    const link = room?.classLink;
    if (!room || !link?.pendingConfirm) return;
    try {
      const r = await this.classStub(link.classId).confirmStart({ roomId: room.roomId, ...link.pendingConfirm });
      if (!r.ok) return;
    } catch {
      return; // alarm 에서 다시
    }
    const next = structuredClone(room);
    if (next.classLink) next.classLink.pendingConfirm = null;
    await this.persist(next);
  }

  private async releaseToClass() {
    const room = await this.load();
    const link = room?.classLink;
    if (!room || !link?.pendingRelease) return;
    try {
      const r = await this.classStub(link.classId).releaseRoster({ roomId: room.roomId, gameId: link.pendingRelease });
      if (!r.ok) return;
    } catch {
      return; // alarm 에서 다시
    }
    const next = structuredClone(room);
    if (next.classLink) next.classLink.pendingRelease = null;
    await this.persist(next);
  }

  override async webSocketClose(ws: WebSocket): Promise<void> {
    try {
      ws.close(1000, 'bye');
    } catch {
      /* 이미 닫힘 */
    }
    await this.onPresenceChange(ws);
  }

  override async webSocketError(ws: WebSocket): Promise<void> {
    await this.onPresenceChange(ws);
  }

  private async onPresenceChange(closing: WebSocket) {
    const room = await this.load();
    if (!room) return;
    const online = new Set(this.sockets().filter((s) => s.ws !== closing).map((s) => s.att.memberId));
    const next = structuredClone(room);
    if (!next.classLink && maybeTransferHost(next, online, this.roomEnv())) {
      await this.persist(next);
    }
    // 접속 표시가 바뀌었으므로 남은 참가자에게 알린다(revision 은 그대로).
    for (const { ws, att } of this.sockets()) {
      if (ws === closing || !this.validSocket(next, att)) continue;
      this.send(ws, { t: 'state', room: projectRoom(next, att.memberId, online, this.roomEnv()) });
    }
    if (next.classLink && !next.classLink.closed) {
      const rep = { roomId: next.roomId, syncVersion: next.classLink.syncVersion, ...roomSummary(next, online) };
      const sig = JSON.stringify(rep);
      if (sig !== this.lastReport) {
        this.lastReport = sig;
        this.classStub(next.classLink.classId)
          .report(rep)
          .catch(() => {
            this.lastReport = '';
          });
      }
    }
  }

  // ------------------------------------------------------------------ 정리 (보존 정책, 카드 규칙 아님)

  override async alarm(): Promise<void> {
    const tomb = await this.ctx.storage.get<{ at: number }>(TOMBSTONE_KEY);
    if (tomb) {
      if (Date.now() - tomb.at >= TOMBSTONE_TTL_MS) await this.ctx.storage.deleteAll();
      else await this.ctx.storage.setAlarm(tomb.at + TOMBSTONE_TTL_MS);
      return;
    }
    const room = await this.load();
    if (!room) {
      await this.ctx.storage.deleteAll();
      return;
    }
    if (room.botTimer && Date.now() >= room.botTimer.at - 30) {
      await this.runBotStep(room);
      return; // 저장하면서 다음 alarm(다음 봇 차례·정리 확인)을 다시 예약했다
    }
    const env = this.roomEnv();

    if (room.classLink) {
      // 밀린 클래스 알림을 다시 보낸다
      if (room.classLink.pendingConfirm) await this.confirmToClass();
      if ((await this.load())?.classLink?.pendingRelease) await this.releaseToClass();
      const cur = (await this.load()) as RoomState;
      if (env.now - cur.lastActivity >= CLASS_ROOM_CHECK_MS) {
        // 부모 클래스가 이 방을 여전히 쓰는지 묻는다. 수업 중이면 지우지 않는다.
        // 물어보지 못하면(오류) 지우지 않는다
        const alive = await this.classStub(cur.classLink!.classId)
          .roomAlive(cur.roomId)
          .catch(() => true);
        if (!alive) {
          await this.purgeForClass(cur.classLink!.classId);
          return;
        }
        const next = structuredClone(cur);
        next.lastActivity = env.now;
        await this.persist(next);
        return;
      }
      await this.persist(cur); // 다음 확인 예약
      return;
    }

    if (env.now - room.lastActivity >= env.ttlHours * 3600_000) {
      await this.destroy('expired');
      return;
    }
    const next = structuredClone(room);
    if (maybeTransferHost(next, this.online(), env)) {
      await this.persist(next);
      this.broadcast(next);
    } else {
      await this.persist(next); // 다음 알람 예약
    }
  }

  // ------------------------------------------------------------------ 봇

  private applyBot(room: RoomState, task: BotTask, cmd: Command) {
    const bot = room.members[task.memberId] as Member;
    const msg: Extract<ClientMessage, { t: 'cmd' }> = {
      t: 'cmd',
      commandId: `bot-${randomToken(9)}`,
      gameId: room.game?.gameId ?? null,
      expectedRevision: room.game?.revision ?? 0,
      cmd,
    };
    return applyCommand(room, bot, msg, this.roomEnv(), this.online());
  }

  /**
   * 예약된 봇 차례 하나를 실행한다. 봇의 명령도 사람과 같은 applyCommand 를 거친다
   * (차례·역할·revision·게임 규칙 검사). 거절되면 안전한 대안을 쓰고, 그래도 안 되면 그 일을 건너뛴다.
   */
  private async runBotStep(room: RoomState) {
    const base = structuredClone(room);
    const timer = base.botTimer;
    base.botTimer = null;
    const task = this.hasHumans(base) ? nextBotTask(base) : null;
    if (!task || !timer || task.key !== timer.key) {
      await this.persist(base); // 상황이 바뀌었으면 다시 예약
      this.broadcast(base);
      return;
    }
    let final: RoomState | null = null;
    let scope: 'all' | 'spymasters' = 'all';
    const decision = decideBotCommand(base, task);
    if (decision) {
      const trial = structuredClone(base);
      const clueIdBefore = trial.game?.nextClueId ?? null;
      const res = this.applyBot(trial, task, decision.cmd);
      if (res.ok) {
        recordBotDecision(trial, decision, task.kind === 'clue' ? clueIdBefore : null);
        final = trial;
        scope = res.scope;
      } else {
        console.error('bot command rejected', task.kind, res.code);
      }
    }
    if (!final) {
      const fb = fallbackBotCommand(base, task);
      const trial = structuredClone(base);
      const res = fb ? this.applyBot(trial, task, fb) : null;
      if (res?.ok) {
        final = trial;
        scope = res.scope;
      } else {
        markBotFailed(base, task.key);
        final = base;
      }
    }
    await this.persist(final);
    this.broadcast(final, scope);
    if (final.classLink) this.reportToClass(final);
  }

  /** 독립 방을 없앤다: 소켓 종료 + 저장 데이터·초대 정보 삭제 */
  private async destroy(reason: 'closed' | 'expired') {
    for (const { ws } of this.sockets()) {
      this.send(ws, { t: 'bye', reason });
      try {
        ws.close(reason === 'expired' ? CLOSE.expired : CLOSE.gone, reason);
      } catch {
        /* 무시 */
      }
    }
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
    this.room = null;
  }
}
