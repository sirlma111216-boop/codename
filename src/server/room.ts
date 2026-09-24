// 방 하나 = SQLite-backed Durable Object 하나. 이 객체가 유일한 진실의 원천이다.
// WebSocket Hibernation API 를 쓴다: 휴면 뒤 깨어나면 메모리는 비어 있으므로
// 상태는 저장소에서, 참가자 정보는 소켓 attachment 에서 복원한다.

import { DurableObject } from 'cloudflare:workers';
import { CLOSE, MAX_MESSAGE_BYTES, clientMessageSchema, type ServerMessage } from '../shared/protocol.ts';
import { PROTOCOL_VERSION } from '../shared/view.ts';
import {
  applyCommand,
  createRoom,
  isSpymasterViewer,
  joinRoom,
  maybeTransferHost,
  memberBySession,
  migrateRoom,
  projectRoom,
  recordDedup,
  type RoomEnv,
  type RoomState,
} from './room-logic.ts';
import { randomToken, safeEqual } from './security.ts';
import type { Env } from './env.ts';

interface Attachment {
  memberId: string;
  sessionHash: string;
}

const STORAGE_KEY = 'room';
/** 소켓당 초당 명령 수 제한 (토큰 버킷) */
const RATE_CAPACITY = 20;
const RATE_REFILL_PER_SEC = 6;

export type RoomStatus = 'member' | 'notMember' | 'gone' | 'banned';

export class RoomDurableObject extends DurableObject<Env> {
  /** undefined = 아직 안 읽음, null = 방 없음 */
  private room: RoomState | null | undefined = undefined;
  private rates = new WeakMap<WebSocket, { tokens: number; at: number }>();
  /** 실패한 명령의 멱등 기록(메모리). 성공한 명령은 상태와 함께 저장된다. */
  private failedCommands = new Map<string, { code: string; message: string }>();

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

  /** 저장이 끝난 뒤에만 메모리 상태를 바꾼다. 실패하면 예외가 올라가고 전송하지 않는다. */
  private async persist(next: RoomState): Promise<void> {
    await this.ctx.storage.put(STORAGE_KEY, next);
    this.room = next;
    const env = this.roomEnv();
    let at = next.lastActivity + env.ttlHours * 3600_000;
    if (next.hostOfflineSince !== null) at = Math.min(at, next.hostOfflineSince + env.hostGraceSeconds * 1000 + 1000);
    await this.ctx.storage.setAlarm(Math.max(at, Date.now() + 1000));
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

  private broadcast(room: RoomState, scope: 'all' | 'spymasters' = 'all') {
    const online = this.online();
    for (const { ws, att } of this.sockets()) {
      if (!room.members[att.memberId]) continue;
      // 비공개 채널 변경은 스파이마스터에게만 보낸다. 추측자에게는 전송 시점조차 새지 않게 한다.
      if (scope === 'spymasters' && !isSpymasterViewer(room, att.memberId)) continue;
      this.sendState(ws, room, att.memberId, online);
    }
  }

  // ------------------------------------------------------------------ RPC (Worker 가 호출)

  async create(input: { roomId: string; sessionHash: string; nickname: string }): Promise<{ ok: true; inviteToken: string } | { ok: false }> {
    const existing = await this.load();
    if (existing) return { ok: false };
    const room = createRoom(input.roomId, input.sessionHash, input.nickname, this.roomEnv());
    await this.persist(room);
    return { ok: true, inviteToken: room.inviteToken };
  }

  async join(input: { sessionHash: string; inviteToken: string; nickname: string }): Promise<{ ok: true } | { ok: false; code: string }> {
    const room = await this.load();
    if (!room) return { ok: false, code: 'gone' };
    const next = structuredClone(room);
    const inviteOk = !!input.inviteToken && safeEqual(input.inviteToken, next.inviteToken);
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
    if (!room) return 'gone';
    if (room.banned.includes(sessionHash)) return 'banned';
    return memberBySession(room, sessionHash) ? 'member' : 'notMember';
  }

  // ------------------------------------------------------------------ WebSocket

  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return new Response('WebSocket 전용', { status: 426 });
    const sessionHash = request.headers.get('X-Session-Hash') ?? '';
    const room = await this.load();
    if (!room) return new Response('gone', { status: 404 });
    if (room.banned.includes(sessionHash)) return new Response('banned', { status: 403 });
    const member = memberBySession(room, sessionHash);
    if (!member) return new Response('not a member', { status: 403 });

    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ memberId: member.id, sessionHash } satisfies Attachment);

    const next = structuredClone(room);
    next.lastActivity = Date.now();
    maybeTransferHost(next, this.online(), this.roomEnv());
    await this.persist(next);
    this.broadcast(next);
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
    if (!room) {
      this.send(ws, { t: 'bye', reason: 'closed' });
      ws.close(CLOSE.gone, 'gone');
      return;
    }
    const me = att ? room.members[att.memberId] : undefined;
    if (!att || !me || me.sessionHash !== att.sessionHash) {
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
      this.send(ws, { t: 'hello', protocol: PROTOCOL_VERSION, memberId: me.id, serverNow: Date.now() });
      this.sendState(ws, room, me.id);
      return;
    }

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

    const env = this.roomEnv();
    const next = structuredClone(room);
    const meNext = next.members[me.id];
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
    if (maybeTransferHost(next, online, this.roomEnv())) {
      await this.persist(next);
    }
    // 접속 표시가 바뀌었으므로 남은 참가자에게 알린다(revision 은 그대로).
    for (const { ws, att } of this.sockets()) {
      if (ws === closing || !next.members[att.memberId]) continue;
      this.send(ws, { t: 'state', room: projectRoom(next, att.memberId, online, this.roomEnv()) });
    }
  }

  // ------------------------------------------------------------------ 정리 (보존 정책, 카드 규칙 아님)

  override async alarm(): Promise<void> {
    const room = await this.load();
    if (!room) {
      await this.ctx.storage.deleteAll();
      return;
    }
    const env = this.roomEnv();
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

  /** 방을 없앤다: 소켓 종료 + 저장 데이터·초대 정보 삭제 */
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
