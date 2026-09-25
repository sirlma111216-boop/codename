// 실시간 연결 공용 부품: 게임방 연결과 클래스 연결이 함께 쓴다.
// 지수 백오프 + jitter 재접속, 명령 outbox(같은 id 로 재전송 → 서버가 멱등 처리),
// 온라인 복귀·탭 절전 복귀·세션 만료·삭제·강퇴를 구분한다.

import { ApiError } from './api.ts';

export type ConnStatus = 'connecting' | 'open' | 'reconnecting' | 'offline' | 'ended';
export type EndReason = 'kicked' | 'gone' | 'expired' | 'protocol' | 'replaced' | 'notMember' | 'banned' | 'noSession' | 'closed' | 'classEnded' | 'removed';

export interface Ack {
  ok: boolean;
  code?: string;
  message?: string;
  result?: { roomId?: string };
}

interface Pending {
  frame: string;
  createdAt: number;
  resolve: (a: Ack) => void;
}

export interface LiveConfig<V> {
  path: string;
  protocol: number;
  /** 서버가 보내는 화면 상태 메시지 종류와, 그 안의 필드 */
  viewMessage: 't:state/room' | 't:class/view';
  /** 명령 응답의 id 필드 */
  idField: 'commandId' | 'opId';
  closeCodes: Record<number, EndReason>;
  /** 재접속이 거듭 실패할 때 이유를 묻는다 */
  statusCheck: () => Promise<'member' | 'gone' | 'banned' | 'notMember' | 'ended'>;
  serverNowOf: (view: V) => number;
}

const PENDING_TTL_MS = 60_000;
const PING_MS = 25_000;

export function newId(): string {
  const b = new Uint8Array(12);
  crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
}

export class LiveConnection<V> {
  status: ConnStatus = 'connecting';
  endReason: EndReason | null = null;
  view: V | null = null;
  clockOffset = 0;
  attempt = 0;
  lastError: string | null = null;

  private ws: WebSocket | null = null;
  private helloDone = false;
  private pending = new Map<string, Pending>();
  private retryTimer: number | null = null;
  private pingTimer: number | null = null;
  private stopped = false;
  private listeners = new Set<() => void>();
  private cfg: LiveConfig<V>;

  constructor(cfg: LiveConfig<V>) {
    this.cfg = cfg;
    window.addEventListener('online', this.onOnline);
    window.addEventListener('offline', this.onOffline);
    document.addEventListener('visibilitychange', this.onVisible);
    this.connect();
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  protected emit() {
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
    const ws = new WebSocket(`${proto}://${location.host}${this.cfg.path}`);
    this.ws = ws;
    if (this.status !== 'offline') this.status = this.view ? 'reconnecting' : 'connecting';
    this.emit();

    ws.onopen = () => {
      ws.send(JSON.stringify({ t: 'hello', protocol: this.cfg.protocol }));
      this.pingTimer = window.setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.send('ping');
      }, PING_MS);
    };
    ws.onmessage = (ev) => {
      if (typeof ev.data !== 'string' || ev.data === 'pong') return;
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(ev.data) as Record<string, unknown>;
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
      const end = this.cfg.closeCodes[ev.code];
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
    if (this.attempt >= 2) {
      try {
        const s = await this.cfg.statusCheck();
        if (s === 'gone') return this.end('gone');
        if (s === 'banned') return this.end('banned');
        if (s === 'notMember') return this.end('notMember');
        if (s === 'ended') return this.end('classEnded');
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

  private handle(msg: Record<string, unknown>) {
    const [viewT, viewKey] = this.cfg.viewMessage.slice(2).split('/') as [string, string];
    if (msg.t === 'hello') {
      this.helloDone = true;
      this.status = 'open';
      this.attempt = 0;
      this.clockOffset = Number(msg.serverNow) - Date.now();
      this.flushPending();
      this.emit();
    } else if (msg.t === viewT) {
      this.view = msg[viewKey] as V;
      this.clockOffset = this.cfg.serverNowOf(this.view) - Date.now();
      this.emit();
    } else if (msg.t === 'ack') {
      const id = String(msg[this.cfg.idField]);
      const p = this.pending.get(id);
      if (p) {
        this.pending.delete(id);
        p.resolve(msg.ok ? { ok: true, result: msg.result as Ack['result'] } : { ok: false, code: String(msg.code), message: String(msg.message) });
      }
    } else if (msg.t === 'error') {
      this.lastError = String(msg.message);
      this.emit();
    } else if (msg.t === 'bye') {
      const map: Record<string, EndReason> = { kicked: 'kicked', closed: 'closed', expired: 'expired', protocol: 'protocol', replaced: 'replaced', classEnded: 'classEnded', removed: 'removed' };
      this.end(map[String(msg.reason)] ?? 'closed');
    }
  }

  private flushPending() {
    const now = Date.now();
    for (const [id, p] of this.pending) {
      if (now - p.createdAt > PENDING_TTL_MS) {
        this.pending.delete(id);
        p.resolve({ ok: false, code: 'timeout', message: '응답이 없어 취소했습니다. 화면을 확인하고 다시 시도하세요.' });
        continue;
      }
      // 같은 id 로 다시 보낸다. 이미 반영됐다면 서버가 이전 결과만 돌려준다.
      this.ws?.send(p.frame);
    }
  }

  /** 명령 전송: frame 에 id 를 넣어 보낸다 */
  protected sendFrame(build: (id: string) => object): Promise<Ack> {
    const id = newId();
    const frame = JSON.stringify(build(id));
    return new Promise<Ack>((resolve) => {
      this.pending.set(id, { frame, createdAt: Date.now(), resolve });
      if (this.ws && this.ws.readyState === WebSocket.OPEN && this.helloDone) this.ws.send(frame);
    });
  }

  serverNow(): number {
    return Date.now() + this.clockOffset;
  }
}
