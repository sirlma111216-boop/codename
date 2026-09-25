// 학급 모드 검증 시뮬레이터 (addendum §8).
// 가짜 참가자(봇)는 실제 브라우저와 같은 경로를 쓴다: POST /api/session 으로 받은 쿠키 세션,
// 같은 HTTP API, 같은 WebSocket 프로토콜(Origin·Cookie 검사를 그대로 통과).
//
//   node --experimental-strip-types tests/load/class-sim.ts --base http://127.0.0.1:8788 [--only flow24,race,...] [--report docs/class-sim/local.md]
//
// 시나리오: flow24 · race · perm · load60 · rooms15  (기본: 전부)
// 소켓 수를 사용자 수로 세지 않는다: 학생 1명 = 클래스 소켓 1 + 자기 방 소켓 1.

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import WebSocket from 'ws';

const argv = process.argv.slice(2);
const arg = (k: string, d = '') => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? (argv[i + 1] ?? d) : d;
};
const BASE = arg('base', 'http://127.0.0.1:8788').replace(/\/$/, '');
const ORIGIN = new URL(BASE).origin;
const WS_BASE = BASE.replace(/^http/, 'ws');
const ONLY = arg('only') ? arg('only').split(',') : ['flow24', 'race', 'perm', 'load60', 'rooms15'];
const REPORT = arg('report');

const NICKS = '가람 나래 다올 라온 마루 바다 사랑 아라 푸른 하늘 한별 해든 가온 나린 다솜 라희 미르 보람 새봄 아름 여울 예솔 윤슬 은별 이든 재이 초롱 타리 파랑 하람 가을 겨울 구름 노을 달빛 들꽃 모래 무지 바람 별빛 봄비 새벽 소나 솔잎 시내 아침 여름 온새 우리 이슬 자두 참새 찬솔 채움 태양 튼튼 하나 한결 햇살 호수 희망 가야 나무'.split(' ');

// ------------------------------------------------------------------ 기록

interface Check {
  scenario: string;
  name: string;
  ok: boolean;
  detail: string;
}
const checks: Check[] = [];
const metrics: Record<string, number[]> = {};
const notes: string[] = [];
let scenario = '';

function check(name: string, ok: boolean, detail = '') {
  checks.push({ scenario, name, ok, detail });
  console.log(`${ok ? '  ✅' : '  ❌'} ${name}${detail ? ` — ${detail}` : ''}`);
}
function metric(name: string, ms: number) {
  (metrics[name] ??= []).push(ms);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const rnd = (a: number, b: number) => a + Math.random() * (b - a);
let seq = 0;
const newId = () => `sim${Date.now().toString(36)}${(seq++).toString(36)}xxxx`;

function pct(xs: number[], p: number) {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return Math.round(s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] as number);
}

// ------------------------------------------------------------------ 봇

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

class Bot {
  name: string;
  cookie = '';
  classWs: WebSocket | null = null;
  roomWs: WebSocket | null = null;
  classView: Json | null = null;
  roomView: Json | null = null;
  classFrames: string[] = [];
  roomFrames: string[] = [];
  byes: string[] = [];
  private waiters = new Map<string, (a: Json) => void>();
  private listeners = new Set<() => void>();

  constructor(name: string) {
    this.name = name;
  }

  async init() {
    const r = await fetch(`${BASE}/api/session`, { method: 'POST', headers: { Origin: ORIGIN, 'content-type': 'application/json' }, body: '{}' });
    const set = r.headers.getSetCookie().find((c) => c.startsWith('cn_sid='));
    if (!set) throw new Error('no session cookie');
    this.cookie = set.split(';')[0] as string;
    return this;
  }

  async api(path: string, method = 'GET', body?: object): Promise<{ status: number; json: Json }> {
    const r = await fetch(`${BASE}${path}`, {
      method,
      headers: { Origin: ORIGIN, Cookie: this.cookie, 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    let json: Json = {};
    try {
      json = (await r.json()) as Json;
    } catch {
      /* 비어 있음 */
    }
    return { status: r.status, json };
  }

  private open(path: string, kind: 'class' | 'room'): Promise<boolean> {
    return new Promise((resolve) => {
      const ws = new WebSocket(`${WS_BASE}${path}`, { headers: { Cookie: this.cookie, Origin: ORIGIN } });
      let settled = false;
      const done = (v: boolean) => {
        if (!settled) {
          settled = true;
          resolve(v);
        }
      };
      ws.on('open', () => ws.send(JSON.stringify({ t: 'hello', protocol: 1 })));
      ws.on('message', (data) => {
        const text = data.toString();
        if (text === 'pong') return;
        (kind === 'class' ? this.classFrames : this.roomFrames).push(text);
        const m = JSON.parse(text) as Json;
        if (m.t === 'class') {
          this.classView = m.view;
          done(true);
        } else if (m.t === 'state') {
          this.roomView = m.room;
          done(true);
        } else if (m.t === 'ack') {
          const id = (m.opId ?? m.commandId) as string;
          this.waiters.get(id)?.(m);
          this.waiters.delete(id);
        } else if (m.t === 'bye') this.byes.push(`${kind}:${m.reason}`);
        for (const fn of this.listeners) fn();
      });
      ws.on('unexpected-response', () => done(false));
      ws.on('error', () => done(false));
      ws.on('close', () => done(false));
      if (kind === 'class') this.classWs = ws;
      else this.roomWs = ws;
      setTimeout(() => done(false), 15_000);
    });
  }

  connectClass(classId: string) {
    return this.open(`/api/classes/${classId}/ws`, 'class');
  }
  connectRoom(roomId: string) {
    return this.open(`/api/rooms/${roomId}/ws`, 'room');
  }
  closeAll() {
    this.classWs?.close();
    this.roomWs?.close();
  }

  private sendAndWait(ws: WebSocket | null, frame: Json, id: string, metricName: string): Promise<Json> {
    const t0 = Date.now();
    return new Promise((resolve) => {
      if (!ws || ws.readyState !== WebSocket.OPEN) return resolve({ ok: false, code: 'noSocket' });
      const timer = setTimeout(() => {
        this.waiters.delete(id);
        resolve({ ok: false, code: 'timeout' });
      }, 20_000);
      this.waiters.set(id, (a) => {
        clearTimeout(timer);
        metric(metricName, Date.now() - t0);
        resolve(a);
      });
      ws.send(JSON.stringify(frame));
    });
  }

  classCmd(cmd: Json, opId = newId()): Promise<Json> {
    return this.sendAndWait(this.classWs, { t: 'cmd', opId, cmd }, opId, 'class command RTT');
  }

  roomCmd(cmd: Json): Promise<Json> {
    const id = newId();
    const g = this.roomView?.game;
    const frame = { t: 'cmd', commandId: id, gameId: cmd.type === 'game' ? (g?.gameId ?? null) : null, expectedRevision: cmd.type === 'game' ? (g?.revision ?? 0) : undefined, cmd };
    return this.sendAndWait(this.roomWs, frame, id, cmd.type === 'game' ? 'game command RTT' : 'room command RTT');
  }

  wait(pred: () => boolean, timeoutMs = 20_000): Promise<boolean> {
    if (pred()) return Promise.resolve(true);
    return new Promise((resolve) => {
      const fn = () => {
        if (pred()) {
          this.listeners.delete(fn);
          clearTimeout(t);
          resolve(true);
        }
      };
      const t = setTimeout(() => {
        this.listeners.delete(fn);
        resolve(false);
      }, timeoutMs);
      this.listeners.add(fn);
    });
  }
}

async function makeBots(n: number, offset = 0): Promise<Bot[]> {
  return Promise.all(Array.from({ length: n }, (_, i) => new Bot(NICKS[(i + offset) % NICKS.length] + (i + offset >= NICKS.length ? String(i) : '')).init()));
}

/** 교사: 클래스 생성 */
async function newClass(teacher: Bot, name: string, capacity: number) {
  const r = await teacher.api('/api/classes', 'POST', { name, capacity });
  if (r.status !== 200) throw new Error(`createClass ${r.status} ${JSON.stringify(r.json)}`);
  const [classId, token] = (r.json.invite as string).split('.') as [string, string];
  await teacher.connectClass(classId);
  return { classId, token };
}

/** 학생 입장 (흩어져 도착) */
async function joinAll(bots: Bot[], classId: string, token: string, spreadMs: number) {
  const results = await Promise.all(
    bots.map(async (b) => {
      await sleep(rnd(0, spreadMs));
      const t0 = Date.now();
      const r = await b.api(`/api/classes/${classId}/join`, 'POST', { inviteToken: token, nickname: b.name });
      metric('class join (HTTP)', Date.now() - t0);
      if (r.status !== 200) return false;
      const t1 = Date.now();
      const ok = await b.connectClass(classId);
      metric('class socket connect', Date.now() - t1);
      return ok;
    }),
  );
  return results.filter(Boolean).length;
}

const myId = (b: Bot) => b.classView?.you?.memberId as string;

/** 방장 지정 → 방 만들기 */
async function makeRooms(teacher: Bot, hosts: Bot[], cap: number): Promise<string[]> {
  for (const h of hosts) await teacher.classCmd({ type: 'designateHost', memberId: myId(h) });
  const ids: string[] = [];
  for (const [i, h] of hosts.entries()) {
    await h.wait(() => !!h.classView?.you?.designated);
    const a = await h.classCmd({ type: 'createRoom', name: `${i + 1}모둠`, capacity: cap });
    ids.push(a.result?.roomId as string);
  }
  return ids;
}

/** 신청 → 승인 (방장은 자기 화면의 최신 명단 버전으로 승인) */
async function fillRooms(hosts: Bot[], roomIds: string[], students: Bot[], per: number) {
  await Promise.all(
    students.map(async (s, i) => {
      await sleep(rnd(0, 1500));
      await s.classCmd({ type: 'requestJoin', roomId: roomIds[Math.floor(i / per) % roomIds.length] });
    }),
  );
  await Promise.all(
    hosts.map(async (h, i) => {
      const roomId = roomIds[i] as string;
      for (let guard = 0; guard < 40; guard++) {
        await h.wait(() => {
          const r = (h.classView?.rooms as Json[] | undefined)?.find((x) => x.id === roomId);
          return !!r && ((r.requests?.length ?? 0) > 0 || r.seatCount >= r.capacity);
        }, 8000);
        const r = (h.classView?.rooms as Json[]).find((x) => x.id === roomId) as Json;
        if (r.seatCount >= r.capacity || !r.requests?.length) break;
        const t0 = Date.now();
        const a = await h.classCmd({ type: 'approve', roomId, memberId: r.requests[0].memberId, expectedRosterVersion: r.rosterVersion });
        if (a.ok) metric('approve RTT', Date.now() - t0);
        else await sleep(100); // 명단이 바뀌었으면 새 화면을 기다렸다 다시
      }
    }),
  );
}

async function waitSynced(students: Bot[], label: string) {
  const t0 = Date.now();
  const ok = await Promise.all(students.map((s) => s.wait(() => !!s.classView?.you?.assignment?.synced, 30_000)));
  metric(`${label}: approve→방 반영 확인까지`, Date.now() - t0);
  return ok.every(Boolean);
}

/** 방 입장·팀 배정·준비·시작 */
async function startRoom(host: Bot, members: Bot[], roomId: string): Promise<Json> {
  await Promise.all(members.map((m) => m.connectRoom(roomId)));
  await host.wait(() => (host.roomView?.members?.filter((m: Json) => m.online).length ?? 0) >= members.length, 15_000);
  await host.roomCmd({ type: 'autoBalance' });
  await Promise.all(members.map((m) => m.wait(() => !!m.roomView?.members?.find((x: Json) => x.id === m.roomView?.you?.memberId)?.team)));
  await Promise.all(members.map((m) => m.roomCmd({ type: 'setReady', ready: true })));
  await host.wait(() => (host.roomView?.classMode?.startProblems?.length ?? 1) === 0, 15_000);
  const a = await host.roomCmd({ type: 'startGame' });
  await Promise.all(members.map((m) => m.wait(() => !!m.roomView?.game)));
  return a;
}

/** 봇끼리 한 판 진행: 스파이마스터는 힌트, 추측자는 아직 안 덮인 카드 중 하나를 고른다 */
async function playRoom(bots: Bot[], maxActions: number): Promise<{ finished: boolean; actions: number; errors: string[] }> {
  const errors: string[] = [];
  let actions = 0;
  let latest = 0;
  for (let step = 0; step < maxActions; step++) {
    const g0 = bots[0]!.roomView?.game;
    if (!g0) break;
    latest = Math.max(latest, g0.revision);
    if (g0.phase === 'finished') return { finished: true, actions, errors };
    const turn = g0.turnTeam;
    let actor: Bot | undefined;
    let cmd: Json;
    if (g0.phase === 'awaitingClue') {
      actor = bots.find((b) => b.roomView?.game?.me?.role === 'spymaster' && b.roomView?.game?.me?.team === turn);
      cmd = { type: 'game', action: { type: 'giveClue', word: `단서${step}`, number: 1 } };
    } else if (g0.phase === 'guessing') {
      actor = bots.find((b) => b.roomView?.game?.me?.role === 'operative' && b.roomView?.game?.me?.team === turn);
      const g = actor?.roomView?.game;
      if (g && g.guessesMade >= 1 && Math.random() < 0.4) cmd = { type: 'game', action: { type: 'endTurn' } };
      else {
        const open = (g?.cards as Json[] | undefined)?.filter((c) => !c.revealed) ?? [];
        cmd = { type: 'game', action: { type: 'guess', index: open[Math.floor(Math.random() * open.length)]?.index ?? 0 } };
      }
    } else {
      break;
    }
    if (!actor) {
      errors.push(`actor not found for ${g0.phase}`);
      break;
    }
    await actor.wait(() => (actor.roomView?.game?.revision ?? 0) >= latest, 10_000);
    const a = await actor.roomCmd(cmd);
    actions++;
    if (!a.ok) errors.push(`${a.code}`);
    await actor.wait(() => (actor.roomView?.game?.revision ?? 0) > latest || actor.roomView?.game?.phase === 'finished', 10_000);
  }
  return { finished: bots[0]!.roomView?.game?.phase === 'finished', actions, errors };
}

/** 비밀 노출 검사: 추측자·교사가 받은 모든 프레임 */
function leaks(frames: string[], allowKey: boolean): string[] {
  const out: string[] = [];
  for (const f of frames) {
    if (/"seed"|"keyId"|"keyRotation"|"identities"|"sessionHash"|"recoveryKey"|"cardId"/.test(f)) out.push('secret-field');
    if (allowKey) continue;
    const m = JSON.parse(f) as Json;
    const g = m.room?.game;
    if (g && g.phase !== 'finished') for (const c of g.cards) if (!c.revealed && c.key) out.push('unrevealed-key');
    if (m.t === 'class' && /"key"\s*:/.test(f)) out.push('key-in-class-view');
  }
  return [...new Set(out)];
}

// ================================================================== 시나리오

async function flow24() {
  scenario = 'flow24';
  console.log('\n■ 시나리오 1: 교사 1 + 학생 24, 방장 4명, 6인 방 4개, 4방 동시 표준 게임');
  const teacher = await new Bot('교사').init();
  const { classId, token } = await newClass(teacher, '시뮬 24명', 40);
  const students = await makeBots(24);
  const joined = await joinAll(students, classId, token, 3000);
  check('학생 24명 입장·클래스 연결', joined === 24, `${joined}/24`);
  const hosts = students.slice(0, 4);
  const others = students.slice(4);
  const roomIds = await makeRooms(teacher, hosts, 6);
  check('방장 4명이 6인 방 4개 생성', roomIds.filter(Boolean).length === 4);
  await fillRooms(hosts, roomIds, others, 5);
  check('남은 20명 신청·승인 → 방마다 6/6', await teacher.wait(() => (teacher.classView?.rooms as Json[]).every((r) => r.seatCount === 6), 20_000));
  check('미배정 0명', teacher.classView?.counts?.unassigned === 0, `미배정 ${teacher.classView?.counts?.unassigned}`);
  check('모든 학생에게 방 반영 확인(입장하기 가능)', await waitSynced(students, '24명'));
  // 좌석 일관성: 클래스 좌석 = 학생 배정
  const seatsOk = (teacher.classView?.rooms as Json[]).every((r) => (r.seats as Json[]).every((s) => (teacher.classView?.members as Json[]).find((m) => m.id === s.memberId)?.assignment === r.id));
  check('클래스 좌석과 학생 배정이 일치', seatsOk);

  const groups = roomIds.map((rid, i) => ({ rid, host: hosts[i] as Bot, members: [hosts[i] as Bot, ...others.slice(i * 5, i * 5 + 5)] }));
  const starts = await Promise.all(groups.map((g) => startRoom(g.host, g.members, g.rid)));
  check('4개 방 모두 시작 (정원·준비·역할 충족 후 명단 잠금)', starts.every((a) => a.ok), starts.map((a) => a.code ?? 'ok').join(','));
  check('교사 화면: 4방 모두 게임 중', await teacher.wait(() => (teacher.classView?.rooms as Json[]).every((r) => r.status === 'playing'), 10_000));
  const plays = await Promise.all(groups.map((g) => playRoom(g.members, 120)));
  check('4방 동시 진행 → 모두 종료', plays.every((p) => p.finished), plays.map((p) => `${p.actions}수${p.errors.length ? `(${p.errors.join('/')})` : ''}`).join(' · '));
  check('교사 화면: 끝난 방 표시', await teacher.wait(() => (teacher.classView?.rooms as Json[]).every((r) => r.status === 'finished'), 10_000));

  // 비밀 노출: 추측자 방 프레임, 모든 학생 클래스 프레임, 교사 프레임
  const opLeaks = groups.flatMap((g) => g.members.filter((m) => m.roomView?.game?.me?.role === 'operative')).flatMap((m) => leaks(m.roomFrames, false));
  check('추측자 방 프레임에 미공개 정답 없음', opLeaks.length === 0, opLeaks.join(','));
  const classLeaks = [teacher, ...students].flatMap((b) => leaks(b.classFrames, false));
  check('클래스 snapshot·교사 요약에 정답·비밀 필드 없음', classLeaks.length === 0, classLeaks.join(','));
  const otherRoom = students.some((s) => s.roomFrames.some((f) => groups.some((g) => !g.members.includes(s) && f.includes(`"roomId":"${g.rid}"`))));
  check('다른 방 이벤트가 오지 않음 (학생 = 자기 방 소켓 하나)', !otherRoom);

  // 재경기 준비: 대기실로 → 클래스 명단 잠금 해제
  await Promise.all(groups.map((g) => g.host.roomCmd({ type: 'backToLobby' })));
  check('대기실 복귀 → 클래스 명단 잠금 해제(대기 중)', await teacher.wait(() => (teacher.classView?.rooms as Json[]).every((r) => r.status === 'waiting'), 10_000));

  // 재접속: 학생·방장·교사
  const again = [hosts[0] as Bot, others[0] as Bot, others[7] as Bot];
  for (const b of again) b.closeAll();
  teacher.closeAll();
  await sleep(500);
  const before = again.map((b) => b.classView?.you?.assignment?.roomId);
  const t0 = Date.now();
  const re = await Promise.all([...again.map((b) => b.connectClass(classId)), teacher.connectClass(classId)]);
  await Promise.all(again.map((b, i) => b.connectRoom(groups[i === 0 ? 0 : i === 1 ? 0 : 1]!.rid)));
  metric('재접속 (클래스+방)', Date.now() - t0);
  check(
    '재접속한 학생·방장·교사의 배정·관리권 복원',
    re.every(Boolean) && again.every((b, i) => b.classView?.you?.assignment?.roomId === before[i]) && hosts[0]!.classView?.you?.ownsRoomId === roomIds[0] && teacher.classView?.you?.role === 'teacher',
  );

  // 수업 종료
  await teacher.classCmd({ type: 'endClass' });
  check('수업 종료 → 학생 클래스 연결 종료 안내', await students[5]!.wait(() => students[5]!.byes.includes('class:classEnded'), 10_000));
  check('교사 기록: 모든 방 닫힘', await teacher.wait(() => teacher.classView?.ended === true, 5000));
  await sleep(6000);
  const st = await others[0]!.api(`/api/rooms/${roomIds[0]}/status`);
  check('정리 뒤 게임방 없음 (자식 방 정리)', st.json.status === 'gone', st.json.status);
  for (const b of [teacher, ...students]) b.closeAll();
}

async function race() {
  scenario = 'race';
  console.log('\n■ 시나리오 3·7: 경쟁·재전송 (마지막 자리 동시 승인, 중복 신청, 취소↔승인, 승인↔시작, opId 재전송)');
  const teacher = await new Bot('교사').init();
  const { classId, token } = await newClass(teacher, '시뮬 경쟁', 40);
  const s = await makeBots(14, 30);
  await joinAll(s, classId, token, 500);
  const [h1, h2, h3, a, b, c, d, e, f, g, h4] = s as Bot[] & Bot[];
  const rooms = await makeRooms(teacher, [h1!, h2!, h3!], 4);
  const [r1, r2, r3] = rooms as [string, string, string];

  // 마지막 한 자리 동시 승인
  await fillRooms([h1!], [r1], [a!, b!], 2);
  await c!.classCmd({ type: 'requestJoin', roomId: r1 });
  await d!.classCmd({ type: 'requestJoin', roomId: r1 });
  await h1!.wait(() => ((h1!.classView?.rooms as Json[]).find((r) => r.id === r1)?.requests?.length ?? 0) === 2);
  const v = (h1!.classView?.rooms as Json[]).find((r) => r.id === r1)!.rosterVersion;
  const [x1, x2] = await Promise.all([
    h1!.classCmd({ type: 'approve', roomId: r1, memberId: myId(c!), expectedRosterVersion: v }),
    h1!.classCmd({ type: 'approve', roomId: r1, memberId: myId(d!), expectedRosterVersion: v }),
  ]);
  await teacher.wait(() => (teacher.classView?.rooms as Json[]).find((r) => r.id === r1)?.seatCount === 4);
  const room1 = (teacher.classView?.rooms as Json[]).find((r) => r.id === r1)!;
  check('마지막 자리 동시 승인 → 하나만 성공, 좌석 4/4', [x1.ok, x2.ok].filter(Boolean).length === 1 && room1.seatCount === 4, `${x1.code ?? 'ok'} / ${x2.code ?? 'ok'}`);
  const dupAssign = (teacher.classView?.members as Json[]).filter((m) => m.assignment === r1).length;
  check('중복 배정 없음 (배정 수 = 좌석 수)', dupAssign === 4);

  // 여러 방 신청 → 마지막 신청만 유지
  await e!.classCmd({ type: 'requestJoin', roomId: r2 });
  await e!.classCmd({ type: 'requestJoin', roomId: r3 });
  await h2!.wait(() => (h2!.classView?.rooms as Json[]).find((r) => r.id === r2)?.requests?.length === 0);
  const v2 = (h2!.classView?.rooms as Json[]).find((r) => r.id === r2)!.rosterVersion;
  const y = await h2!.classCmd({ type: 'approve', roomId: r2, memberId: myId(e!), expectedRosterVersion: v2 });
  const eView = await e!.wait(() => e!.classView?.you?.request?.roomId === r3, 5000); // 화면 갱신은 120ms 묶음 방송
  check('여러 방에 신청하면 앞 신청은 취소 (앞 방 방장 승인 불가)', !y.ok && y.code === 'noRequest' && eView, y.code);

  // 취소 ↔ 승인 동시
  await f!.classCmd({ type: 'requestJoin', roomId: r3 });
  await h3!.wait(() => ((h3!.classView?.rooms as Json[]).find((r) => r.id === r3)?.requests?.length ?? 0) >= 2);
  const v3 = (h3!.classView?.rooms as Json[]).find((r) => r.id === r3)!.rosterVersion;
  const [cz, az] = await Promise.all([f!.classCmd({ type: 'cancelRequest' }), h3!.classCmd({ type: 'approve', roomId: r3, memberId: myId(f!), expectedRosterVersion: v3 })]);
  await sleep(400);
  const fAssigned = f!.classView?.you?.assignment?.roomId === r3;
  check('취소와 승인 경합 → 정확히 하나만, 상태 일치', [cz.ok, az.ok].filter(Boolean).length === 1 && fAssigned === !!az.ok, `cancel ${cz.code ?? 'ok'} / approve ${az.code ?? 'ok'}`);

  // opId 재전송: 승인·방 만들기 중복 없음
  await g!.classCmd({ type: 'requestJoin', roomId: r2 });
  await h2!.wait(() => ((h2!.classView?.rooms as Json[]).find((r) => r.id === r2)?.requests?.length ?? 0) >= 1);
  const vv = (h2!.classView?.rooms as Json[]).find((r) => r.id === r2)!.rosterVersion;
  const op = newId();
  const p1 = await h2!.classCmd({ type: 'approve', roomId: r2, memberId: myId(g!), expectedRosterVersion: vv }, op);
  const p2 = await h2!.classCmd({ type: 'approve', roomId: r2, memberId: myId(g!), expectedRosterVersion: vv }, op);
  await sleep(300);
  const seats2 = (teacher.classView?.rooms as Json[]).find((r) => r.id === r2)!.seatCount;
  check('같은 opId 로 승인 재전송 → 한 번만 반영', !!p1.ok && !!p2.ok && seats2 === 2, `좌석 ${seats2}`);
  await teacher.classCmd({ type: 'designateHost', memberId: myId(h4!) });
  await h4!.wait(() => !!h4!.classView?.you?.designated);
  const cop = newId();
  const c1 = await h4!.classCmd({ type: 'createRoom', name: '재전송방', capacity: 4 }, cop);
  const c2 = await h4!.classCmd({ type: 'createRoom', name: '재전송방', capacity: 4 }, cop);
  await sleep(300);
  const same = (teacher.classView?.rooms as Json[]).filter((r) => r.name === '재전송방').length;
  check('같은 opId 로 방 만들기 재전송 → 방 하나', c1.result?.roomId === c2.result?.roomId && same === 1);

  // 승인 ↔ 시작 경합: 가득 찬 방이 준비를 마친 순간, 교사가 학생을 옮긴다
  const members1 = [h1!, a!, b!, x1.ok ? c! : d!];
  await Promise.all(members1.map((m) => m.wait(() => !!m.classView?.you?.assignment?.synced)));
  await Promise.all(members1.map((m) => m.connectRoom(r1)));
  await h1!.roomCmd({ type: 'autoBalance' });
  await Promise.all(members1.map((m) => m.wait(() => !!m.roomView?.members?.find((x: Json) => x.id === m.roomView?.you?.memberId)?.team)));
  await Promise.all(members1.map((m) => m.roomCmd({ type: 'setReady', ready: true })));
  await h1!.wait(() => (h1!.roomView?.classMode?.startProblems?.length ?? 1) === 0);
  const [st, mv] = await Promise.all([h1!.roomCmd({ type: 'startGame' }), teacher.classCmd({ type: 'moveStudent', memberId: myId(a!), toRoomId: null })]);
  await sleep(1500);
  const tv = (teacher.classView?.rooms as Json[]).find((r) => r.id === r1)!;
  const aAssigned = (teacher.classView?.members as Json[]).find((m) => m.id === myId(a!))?.assignment === r1;
  const consistent = st.ok ? !mv.ok && tv.status === 'playing' && aAssigned && tv.seatCount === 4 : !!mv.ok && !h1!.roomView?.game && !aAssigned;
  check('승인·이동 ↔ 시작 경합 → 한쪽만 성공, 진행 판에 끼어들기 없음', [st.ok, mv.ok].filter(Boolean).length === 1 && consistent, `start ${st.code ?? 'ok'} / move ${mv.code ?? 'ok'}`);

  // 진행 중 이동·신규 참가 차단, 정답 본 사람 우회 차단 — 이동이 이겼으면 다시 채워 시작한 뒤 검사한다
  if (!st.ok) {
    await a!.classCmd({ type: 'requestJoin', roomId: r1 });
    await h1!.wait(() => ((h1!.classView?.rooms as Json[]).find((r) => r.id === r1)?.requests?.length ?? 0) > 0);
    const vr = (h1!.classView?.rooms as Json[]).find((r) => r.id === r1)!.rosterVersion;
    await h1!.classCmd({ type: 'approve', roomId: r1, memberId: myId(a!), expectedRosterVersion: vr });
    await a!.wait(() => !!a!.classView?.you?.assignment?.synced);
    await a!.connectRoom(r1);
    await h1!.roomCmd({ type: 'autoBalance' });
    await Promise.all(members1.map((m) => m.wait(() => !!m.roomView?.members?.find((x: Json) => x.id === m.roomView?.you?.memberId)?.team)));
    await Promise.all(members1.map((m) => m.roomCmd({ type: 'setReady', ready: true })));
    await h1!.wait(() => (h1!.roomView?.classMode?.startProblems?.length ?? 1) === 0);
    const again = await h1!.roomCmd({ type: 'startGame' });
    check('다시 채운 뒤 시작', !!again.ok, again.code);
    await Promise.all(members1.map((m) => m.wait(() => !!m.roomView?.game)));
  }
  {
    const late = await i2(e!, r1);
    check('진행 중인 방: 신규 신청 차단', !late.ok && late.code === 'roomLocked', late.code);
    const mv2 = await teacher.classCmd({ type: 'moveStudent', memberId: myId(b!), toRoomId: null });
    check('진행 중인 방: 교사 이동도 차단', !mv2.ok && mv2.code === 'roomLocked', mv2.code);
    const spy = members1.find((m) => m.roomView?.game?.me?.role === 'spymaster')!;
    const r = await spy.roomCmd({ type: 'setSeat', team: 'red', role: 'operative' });
    check('정답을 본 스파이마스터는 게임 중 추측자로 못 바꿈', !r.ok, r.code);
  }
  notes.push('race: 승인↔시작 경합에서 이긴 쪽 = ' + (st.ok ? '시작' : '이동'));
  for (const b of [teacher, ...s]) b.closeAll();
  await teacher.classCmd({ type: 'endClass' }).catch(() => {});

  async function i2(bot: Bot, roomId: string) {
    return bot.classCmd({ type: 'requestJoin', roomId });
  }
  void classId;
}

async function perm() {
  scenario = 'perm';
  console.log('\n■ 시나리오 4·6·10: 권한·다른 클래스 차단·독립 방 경로 우회 차단');
  const tA = await new Bot('교사A').init();
  const tB = await new Bot('교사B').init();
  const A = await newClass(tA, '시뮬 A반', 40);
  const B = await newClass(tB, '시뮬 B반', 40);
  const sa = await makeBots(6, 44);
  const sb = await makeBots(1, 50);
  await joinAll(sa, A.classId, A.token, 300);
  await joinAll(sb, B.classId, B.token, 0);
  const [host, host2, p1, p2] = sa as [Bot, Bot, Bot, Bot];
  const [ra, ra2] = (await makeRooms(tA, [host, host2], 4)) as [string, string];

  const n1 = await p1.classCmd({ type: 'createRoom', name: 'x', capacity: 4 });
  check('방장이 아닌 학생의 방 생성 거절', !n1.ok && n1.code === 'notDesignated', n1.code);
  await p1.classCmd({ type: 'requestJoin', roomId: ra });
  await host.wait(() => ((host.classView?.rooms as Json[]).find((r) => r.id === ra)?.requests?.length ?? 0) > 0);
  const v = (host.classView?.rooms as Json[]).find((r) => r.id === ra)!.rosterVersion;
  const n2 = await host2.classCmd({ type: 'approve', roomId: ra, memberId: myId(p1), expectedRosterVersion: v });
  check('다른 방 방장의 승인 거절', !n2.ok && n2.code === 'forbidden', n2.code);

  const outsider = sb[0] as Bot;
  const wsA = await outsider.connectClass(A.classId);
  check('다른 클래스 학생의 클래스 구독 거절', !wsA);
  const stA = await outsider.api(`/api/classes/${A.classId}/status`);
  check('다른 클래스 학생: 클래스 상태 = 참가자 아님', stA.json.status === 'notMember', stA.json.status);
  const stR = await outsider.api(`/api/rooms/${ra}/status`);
  check('방 id 를 알아도 다른 클래스 학생은 방 참가자가 아님', stR.json.status === 'notMember', stR.json.status);
  const wsR = await outsider.connectRoom(ra);
  check('다른 클래스 학생의 방 소켓 구독 거절', !wsR);
  const sj = await outsider.api(`/api/rooms/${ra}/join`, 'POST', { inviteToken: 'x'.repeat(32), nickname: '우회' });
  check('독립 방 초대 경로로 학급 방 입장 불가', sj.status === 403 && sj.json.code === 'classManaged', `${sj.status} ${sj.json.code}`);

  await tA.classCmd({ type: 'revokeHost', memberId: myId(host2) });
  await host2.wait(() => host2.classView?.you?.designated === false);
  const n3 = await host2.classCmd({ type: 'createRoom', name: 'y', capacity: 4 });
  check('취소된 방장 권한으로 방 생성 거절', !n3.ok && n3.code === 'notDesignated', n3.code);
  await p2.classCmd({ type: 'requestJoin', roomId: ra2 });
  await sleep(300);
  const n4 = await host2.classCmd({ type: 'approve', roomId: ra2, memberId: myId(p2), expectedRosterVersion: 1 });
  check('취소된 방장의 승인 거절 (방에도 관리권 없음)', !n4.ok && n4.code === 'forbidden', n4.code);

  // 교사 공개 관전: 게임 행동 불가, 정답 없음
  await tA.connectRoom(ra);
  const tc = await tA.roomCmd({ type: 'chat', text: '힌트' });
  check('교사 관전 소켓은 게임 행동·채팅 불가', !tc.ok && tc.code === 'forbidden', tc.code);
  check('교사 관전 화면에 정답 없음', leaks(tA.roomFrames, false).length === 0);

  // 강퇴된 학생의 세션 재사용
  await tA.classCmd({ type: 'kickMember', memberId: myId(p2) });
  await p2.wait(() => p2.byes.includes('class:kicked'), 5000);
  const back = await p2.connectClass(A.classId);
  const rejoin = await p2.api(`/api/classes/${A.classId}/join`, 'POST', { inviteToken: A.token, nickname: '다시' });
  check('강퇴 세션은 소켓·초대 재사용 모두 거절', !back && rejoin.status === 403, `${rejoin.json.code}`);

  for (const b of [tA, tB, ...sa, ...sb]) b.closeAll();
  await tA.connectClass(A.classId);
  await tB.connectClass(B.classId);
  await tA.classCmd({ type: 'endClass' });
  await tB.classCmd({ type: 'endClass' });
  tA.closeAll();
  tB.closeAll();
}

async function load60() {
  scenario = 'load60';
  console.log('\n■ 시나리오 8: 학생 60 + 교사 1, 6인 방 10개 동시 연결·힌트·공개·재접속');
  const teacher = await new Bot('교사').init();
  const { classId, token } = await newClass(teacher, '시뮬 60명', 60);
  const st = await makeBots(60);
  const t0 = Date.now();
  const joined = await joinAll(st, classId, token, 5000);
  metric('60명 입장 전체 소요', Date.now() - t0);
  check('학생 60명 입장·클래스 연결', joined === 60, `${joined}/60`);
  const hosts = st.slice(0, 10);
  const others = st.slice(10);
  const roomIds = await makeRooms(teacher, hosts, 6);
  await fillRooms(hosts, roomIds, others, 5);
  check('10개 방 6/6, 미배정 0', await teacher.wait(() => (teacher.classView?.rooms as Json[]).every((r) => r.seatCount === 6) && teacher.classView?.counts?.unassigned === 0, 30_000));
  check('60명 모두 방 반영 확인', await waitSynced(st, '60명'));
  const groups = roomIds.map((rid, i) => ({ rid, host: hosts[i] as Bot, members: [hosts[i] as Bot, ...others.slice(i * 5, i * 5 + 5)] }));
  const tStart = Date.now();
  const starts = await Promise.all(groups.map((g) => startRoom(g.host, g.members, g.rid)));
  metric('10방 입장~시작 전체', Date.now() - tStart);
  const openSockets = st.filter((b) => b.classWs?.readyState === WebSocket.OPEN).length + st.filter((b) => b.roomWs?.readyState === WebSocket.OPEN).length + 1;
  check('동시 연결: 사용자 61명 / 소켓 121개 (학생 = 클래스 1 + 방 1, 교사 = 클래스 1)', openSockets === 121, `열린 소켓 ${openSockets}`);
  check('10개 방 모두 시작', starts.every((a) => a.ok), starts.map((a) => a.code ?? 'ok').join(','));
  const tPlay = Date.now();
  const plays = await Promise.all(groups.map((g) => playRoom(g.members, 10)));
  metric('10방 × 10수 동시 진행', Date.now() - tPlay);
  const totalActions = plays.reduce((n, p) => n + p.actions, 0);
  const errs = plays.flatMap((p) => p.errors);
  check('10방 동시 힌트 제출·카드 공개', totalActions >= 60 && errs.length === 0, `${totalActions}수, 오류 ${errs.length}${errs.length ? ` (${[...new Set(errs)].join('/')})` : ''}`);

  // 재접속: 60명 방·클래스 소켓을 모두 끊었다 다시 붙인다
  const revs = groups.map((g) => g.host.roomView?.game?.revision);
  for (const b of st) b.closeAll();
  await sleep(1000);
  const tr = Date.now();
  const re = await Promise.all(st.map(async (b, i) => (await b.connectClass(classId)) && (await b.connectRoom(groups[i < 10 ? i : Math.floor((i - 10) / 5)]!.rid))));
  metric('60명 동시 재접속 (클래스+방)', Date.now() - tr);
  const restored = groups.every((g, i) => g.host.roomView?.game?.revision === revs[i]) && st.every((b) => b.classView?.you?.assignment?.synced);
  check('60명 재접속 후 같은 게임·배정으로 복원', re.every(Boolean) && restored, `${re.filter(Boolean).length}/60`);
  const extra = await (await new Bot('61번째').init()).api(`/api/classes/${classId}/join`, 'POST', { inviteToken: token, nickname: '61번째' });
  check('정원 60명 초과 입장 거절', extra.status === 403 && extra.json.code === 'full', extra.json.code);
  await teacher.classCmd({ type: 'endClass' });
  for (const b of [teacher, ...st]) b.closeAll();
}

async function rooms15() {
  scenario = 'rooms15';
  console.log('\n■ 시나리오 9: 4인 방 15개 편성, 방 한도·정원 초과, 수업 종료 뒤 정리');
  const teacher = await new Bot('교사').init();
  const { classId, token } = await newClass(teacher, '시뮬 4인×15', 60);
  const st = await makeBots(60);
  await joinAll(st, classId, token, 4000);
  const hosts = st.slice(0, 15);
  const others = st.slice(15);
  const roomIds = await makeRooms(teacher, hosts, 4);
  await fillRooms(hosts, roomIds, others, 3);
  check('4인 방 15개, 60명 모두 배정', await teacher.wait(() => (teacher.classView?.rooms as Json[]).length === 15 && (teacher.classView?.rooms as Json[]).every((r) => r.seatCount === 4) && teacher.classView?.counts?.unassigned === 0, 30_000));
  const extraHost = others[0] as Bot;
  await teacher.classCmd({ type: 'designateHost', memberId: myId(extraHost) });
  await extraHost.wait(() => !!extraHost.classView?.you?.designated);
  await extraHost.classCmd({ type: 'leaveRoom' });
  const over = await extraHost.classCmd({ type: 'createRoom', name: '16번째', capacity: 4 });
  check('16번째 방은 한도로 거절', !over.ok && over.code === 'tooManyRooms', over.code);
  const extra = await (await new Bot('61번째').init()).api(`/api/classes/${classId}/join`, 'POST', { inviteToken: token, nickname: '61번째' });
  check('61번째 학생 입장 거절', extra.status === 403, extra.json.code);
  await teacher.classCmd({ type: 'endClass' });
  await sleep(8000);
  const statuses = await Promise.all(roomIds.map((r, i) => hosts[i]!.api(`/api/rooms/${r}/status`)));
  check('수업 종료 뒤 15개 방 모두 정리됨', statuses.every((s) => s.json.status === 'gone'), statuses.map((s) => s.json.status).join(','));
  const cs = await st[3]!.api(`/api/classes/${classId}/status`);
  check('학생에게 클래스 상태 = 종료', cs.json.status === 'ended', cs.json.status);
  for (const b of [teacher, ...st]) b.closeAll();
}

// ================================================================== 실행

const runners: Record<string, () => Promise<void>> = { flow24, race, perm, load60, rooms15 };
const started = Date.now();
console.log(`대상: ${BASE}\n시나리오: ${ONLY.join(', ')}`);
for (const name of ONLY) {
  try {
    await runners[name]!();
  } catch (e) {
    check(`${name} 실행`, false, String((e as Error).stack ?? e).slice(0, 300));
  }
}
const failed = checks.filter((c) => !c.ok);
console.log(`\n결과: ${checks.length - failed.length}/${checks.length} 통과 · ${((Date.now() - started) / 1000).toFixed(1)}초`);
const lines = [
  `# 학급 모드 시뮬레이션 결과`,
  '',
  `- 대상: \`${BASE}\``,
  `- 실행: ${new Date().toISOString()} · ${((Date.now() - started) / 1000).toFixed(1)}초`,
  `- 방법: 봇마다 독립 쿠키 세션, 실제 브라우저와 같은 HTTP API·WebSocket 프로토콜 (Node \`ws\`, Origin·Cookie 헤더)`,
  `- 결과: **${checks.length - failed.length}/${checks.length} 통과**`,
  '',
  '| 시나리오 | 검사 | 결과 | 비고 |',
  '|---|---|---|---|',
  ...checks.map((c) => `| ${c.scenario} | ${c.name} | ${c.ok ? '통과' : '**실패**'} | ${c.detail.replace(/\|/g, '/').slice(0, 160)} |`),
  '',
  '## 측정값 (ms)',
  '',
  '| 항목 | 횟수 | p50 | p95 | 최대 |',
  '|---|---|---|---|---|',
  ...Object.entries(metrics).map(([k, v]) => `| ${k} | ${v.length} | ${pct(v, 50)} | ${pct(v, 95)} | ${Math.round(Math.max(...v))} |`),
  '',
  ...(notes.length ? ['## 메모', '', ...notes.map((n) => `- ${n}`), ''] : []),
];
if (REPORT) {
  mkdirSync(dirname(REPORT), { recursive: true });
  writeFileSync(REPORT, lines.join('\n') + '\n', 'utf8');
  console.log(`보고서: ${REPORT}`);
}
process.exit(failed.length ? 1 : 0);
