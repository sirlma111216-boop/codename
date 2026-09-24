// 방 WebSocket 연결: 지수 백오프 + jitter 재접속, 명령 outbox(같은 commandId 로 재전송 → 서버가 멱등 처리),
// 온라인 복귀·탭 절전 복귀·세션 만료·방 삭제·강퇴를 구분한다.

import { CLOSE } from '../shared/constants.ts';
import type { Command, ServerMessage } from '../shared/protocol.ts';
import { PROTOCOL_VERSION, type RoomView } from '../shared/view.ts';
import { api, ApiError } from './api.ts';

export type ConnStatus = 'connecting' | 'open' | 'reconnecting' | 'offline' | 'ended';
export type EndReason = 'kicked' | 'gone' | 'expired' | 'protocol' | 'replaced' | 'notMember' | 'banned' | 'noSession' | 'closed';

export interface Ack {
  ok: boolean;
  code?: string;
  message?: string;
}

interface Pending {
  commandId: string;
  frame: string;
  createdAt: number;
  resolve: (a: Ack) => void;
}

const PENDING_TTL_MS = 60_000;
const PING_MS = 25_000;

function newCommandId(): string {
  const b = new Uint8Array(12);
  crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
}

export class RoomConnection {
  status: ConnStatus = 'connecting';
  endReason: EndReason | null = null;
  room: RoomView | null = null;
  /** 서버 시각 - 내 시각 */
  clockOffset = 0;
  attempt = 0;

  private ws: WebSocket | null = null;
  private helloDone = false;
  private pending = new Map<string, Pending>();
  private retryTimer: number | null = null;
  private pingTimer: number | null = null;
  private stopped = false;
  private listeners = new Set<() => void>();

  private roomId: string;

  constructor(roomId: string) {
    this.roomId = roomId;
    window.addEventListener('online', this.onOnline);
    window.addEventListener('offline', this.onOffline);
    document.addEventListener('visibilitychange', this.onVisible);
    this.connect();
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit() {
    for (const fn of this.listeners) fn();
  }

  dispose() {
    this.stopped = true;
    window.removeEventListener('online', this.onOnline);
    window.removeEventListener('offline', this.onOffline);
    document.removeEventListener('visibilitychange', this.onVisible);
    this.clearTimers();
    this.ws?.close(1000, 'leave');
    this.ws = null;
  }

  private clearTimers() {
    if (this.retryTimer) window.clearTimeout(this.retryTimer);
    if (this.pingTimer) window.clearInterval(this.pingTimer);
    this.retryTimer = null;
    this.pingTimer = null;
  }

  private onOnline = () => {
    if (this.status === 'offline' || this.status === 'reconnecting') this.reconnectNow();
  };

  private onOffline = () => {
    if (this.status === 'ended') return;
    this.status = 'offline';
    this.emit();
  };

  private onVisible = () => {
    if (document.visibilityState !== 'visible' || this.status === 'ended') return;
    // 탭 절전에서 돌아오면 연결이 조용히 끊겨 있을 수 있다.
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) this.reconnectNow();
  };

  reconnectNow() {
    if (this.stopped || this.status === 'ended') return;
    this.clearTimers();
    this.attempt = 0;
    this.connect();
  }

  private connect() {
    if (this.stopped) return;
    this.helloDone = false;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/api/rooms/${encodeURIComponent(this.roomId)}/ws`);
    this.ws = ws;
    if (this.status !== 'offline') this.status = this.room ? 'reconnecting' : 'connecting';
    this.emit();

    ws.onopen = () => {
      ws.send(JSON.stringify({ t: 'hello', protocol: PROTOCOL_VERSION }));
      this.pingTimer = window.setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.send('ping');
      }, PING_MS);
    };
    ws.onmessage = (ev) => {
      if (typeof ev.data !== 'string' || ev.data === 'pong') return;
      let msg: ServerMessage;
      try {
        msg = JSON.parse(ev.data) as ServerMessage;
      } catch {
        return;
      }
      this.handle(msg);
    };
    ws.onclose = (ev) => {
      if (this.ws !== ws) return;
      this.clearTimers();
      this.ws = null;
      if (this.stopped || this.status === 'ended') return;
      const byCode: Partial<Record<number, EndReason>> = {
        [CLOSE.kicked]: 'kicked',
        [CLOSE.gone]: 'gone',
        [CLOSE.expired]: 'expired',
        [CLOSE.protocol]: 'protocol',
        [CLOSE.replaced]: 'replaced',
      };
      const end = byCode[ev.code];
      if (end) return this.end(end);
      void this.scheduleRetry();
    };
  }

  private async scheduleRetry() {
    if (!navigator.onLine) {
      this.status = 'offline';
      this.emit();
      return; // 'online' 이벤트에서 다시 붙는다
    }
    this.status = 'reconnecting';
    this.attempt++;
    this.emit();
    // 몇 번 실패하면 이유를 서버에 묻는다 (방 삭제·강퇴·세션 만료 구분)
    if (this.attempt >= 2) {
      try {
        const s = await api.status(this.roomId);
        if (s.status === 'gone') return this.end('gone');
        if (s.status === 'banned') return this.end('banned');
        if (s.status === 'notMember') return this.end('notMember');
      } catch (e) {
        if (e instanceof ApiError && e.code === 'noSession') return this.end('noSession');
      }
    }
    const base = Math.min(15_000, 500 * 2 ** Math.min(this.attempt, 5));
    const delay = base / 2 + Math.random() * base; // jitter
    this.retryTimer = window.setTimeout(() => this.connect(), delay);
  }

  private end(reason: EndReason) {
    this.status = 'ended';
    this.endReason = reason;
    this.clearTimers();
    for (const p of this.pending.values()) p.resolve({ ok: false, code: reason, message: '연결이 끝났습니다.' });
    this.pending.clear();
    this.emit();
  }

  private handle(msg: ServerMessage) {
    switch (msg.t) {
      case 'hello':
        this.helloDone = true;
        this.status = 'open';
        this.attempt = 0;
        this.clockOffset = msg.serverNow - Date.now();
        this.flushPending();
        this.emit();
        break;
      case 'state':
        this.room = msg.room;
        this.clockOffset = msg.room.serverNow - Date.now();
        this.emit();
        break;
      case 'ack': {
        const p = this.pending.get(msg.commandId);
        if (p) {
          this.pending.delete(msg.commandId);
          p.resolve(msg.ok ? { ok: true } : { ok: false, code: msg.code, message: msg.message });
        }
        break;
      }
      case 'error':
        this.lastError = msg.message;
        this.emit();
        break;
      case 'bye': {
        const map: Record<string, EndReason> = { kicked: 'kicked', closed: 'closed', expired: 'expired', protocol: 'protocol', replaced: 'replaced' };
        this.end(map[msg.reason] ?? 'closed');
        break;
      }
    }
  }

  lastError: string | null = null;

  private flushPending() {
    const now = Date.now();
    for (const [id, p] of this.pending) {
      if (now - p.createdAt > PENDING_TTL_MS) {
        this.pending.delete(id);
        p.resolve({ ok: false, code: 'timeout', message: '응답이 없어 취소했습니다. 화면을 확인하고 다시 시도하세요.' });
        continue;
      }
      // 같은 commandId 로 다시 보낸다. 이미 반영됐다면 서버가 이전 결과만 돌려준다.
      this.ws?.send(p.frame);
    }
  }

  /** 명령 전송. 게임 명령은 현재 화면의 gameId·revision 을 함께 보낸다. */
  send(cmd: Command): Promise<Ack> {
    const commandId = newCommandId();
    const game = this.room?.game;
    const frame = JSON.stringify({
      t: 'cmd',
      commandId,
      gameId: cmd.type === 'game' ? (game?.gameId ?? null) : null,
      expectedRevision: cmd.type === 'game' ? (game?.revision ?? 0) : undefined,
      cmd,
    });
    return new Promise<Ack>((resolve) => {
      this.pending.set(commandId, { commandId, frame, createdAt: Date.now(), resolve });
      if (this.ws && this.ws.readyState === WebSocket.OPEN && this.helloDone) this.ws.send(frame);
    });
  }

  serverNow(): number {
    return Date.now() + this.clockOffset;
  }
}
