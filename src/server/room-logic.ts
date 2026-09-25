// 방(대기실·권한·채팅·타이머)과 게임 명령 처리. 입출력이 없는 함수라 테스트할 수 있다.
// 실제 저장·전송은 room.ts(Durable Object)가 한다.

import { applyAction, remainingAgents, rosterEntry } from '../game/engine.ts';
import type { ClassRoomSync, RoomSummary } from '../shared/classroom.ts';
import { projectGame } from '../game/projection.ts';
import { validateRoster, type Seat } from '../game/rulesets.ts';
import { createGame } from '../game/setup.ts';
import type { GameState, RulesetId, Team } from '../game/types.ts';
import { CHAT_MAX, CUSTOM_WORD_MAX, CUSTOM_WORDS_MAX_COUNT, NICKNAME_MAX, TIMER_CHOICES, type ClientMessage, type Command } from '../shared/protocol.ts';
import type { ChatMessage, MemberView, RoomSettings, RoomView, SeatRole } from '../shared/view.ts';
import { normalizeWord } from '../game/content.ts';
import { CUSTOM_PACK_ID, DEFAULT_PACK_ID, packOptions, packTitle, resolvePack } from './packs.ts';
import { MAX_BOTS_PER_ROOM, type BotLevel, type BotTaskKind, type SoloConfig } from '../shared/bots.ts';
import { lexiconCovers } from './bots/lexicon.ts';

export const ROOM_SCHEMA_VERSION = 1;
export const MAX_MEMBERS = 30;
const CHAT_KEEP = 80;
const DEDUP_KEEP = 200;

export interface Member {
  id: string;
  nickname: string;
  /** SHA-256(세션 쿠키). 원본 세션 값은 저장하지 않는다. null = 강퇴 등으로 자리만 남은 상태 */
  sessionHash: string | null;
  joinedAt: number;
  team: Team | null;
  role: SeatRole;
  /** 학급 방에서 쓰는 준비 완료 표시 */
  ready?: boolean;
  /** 봇 참가자. 세션이 없고, 서버가 사람과 같은 명령 경로로 움직인다 (room.ts) */
  bot?: { level: BotLevel };
}

/** 자리에 실제로 있는 참가자: 연결(세션)이 있는 사람 또는 봇 */
export const present = (m: Member): boolean => !!m.sessionHash || !!m.bot;

/** 봇이 다음에 할 일의 예약 (alarm 으로 실행) */
export interface BotTimer {
  key: string;
  at: number;
  memberId: string;
  kind: BotTaskKind;
}

/** 이번 게임에서 봇이 한 일의 기록 */
export interface BotMemo {
  gameId: string;
  /** 해석을 채팅에 남긴 힌트 */
  advised: number[];
  /** 봇 스파이마스터가 노린 카드 (게임이 끝나야 공개) */
  intents: { clueId: number; targets: number[] }[];
  /** 적용에 실패해 다시 시도하지 않을 일 */
  failed: string[];
}

/** 학급 모드 방의 클래스 연결 정보. 명단은 클래스가 버전 붙여 보낸 것만 반영한다. */
export interface ClassLink {
  classId: string;
  className: string;
  roomName: string;
  syncVersion: number;
  capacity: number;
  teacherHashes: string[];
  closed: boolean;
  closeReason: ClassRoomSync['closeReason'];
  /** 시작 잠금은 받았고 클래스에 게임 확정을 아직 못 알린 경우 */
  pendingConfirm: { opId: string; gameId: string } | null;
  /** 게임 뒤 대기실로 돌아왔고 클래스에 명단 잠금 해제를 아직 못 알린 경우 */
  pendingRelease: string | null;
}

/** 관전하는 교사의 소켓 표시 */
export const TEACHER_ID = 'teacher';

export interface DedupEntry {
  id: string;
  memberId: string;
  ok: boolean;
  code?: string;
  message?: string;
}

export interface RoomState {
  schemaVersion: number;
  roomId: string;
  createdAt: number;
  lastActivity: number;
  revision: number;
  inviteToken: string;
  locked: boolean;
  hostId: string;
  hostOfflineSince: number | null;
  members: Record<string, Member>;
  banned: string[];
  settings: RoomSettings;
  customWords: string[];
  game: GameState | null;
  lastGame: { packId: string; cards: GameState['setup']['cards'] } | null;
  chat: ChatMessage[];
  nextChatId: number;
  timer: { endsAt: number; seconds: number; startedBy: string } | null;
  dedup: DedupEntry[];
  classLink: ClassLink | null;
  /** 혼자 하기 방: 다른 사람이 들어올 수 없다 */
  solo: boolean;
  /** 모두 봇인 게임을 관전할 때 정답 보기 */
  watchKey: boolean;
  botTimer: BotTimer | null;
  botMemo: BotMemo | null;
}

export interface RoomEnv {
  now: number;
  newId: (bytes: number) => string;
  ttlHours: number;
  hostGraceSeconds: number;
}

/** 저장된 방 상태를 현재 코드의 형태로 맞춘다. 기존 방을 파괴하지 않는다. */
export function migrateRoom(raw: unknown): RoomState | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Partial<RoomState>;
  if (typeof r.schemaVersion === 'number' && r.schemaVersion > ROOM_SCHEMA_VERSION) {
    // 더 새로운 코드가 저장한 상태 — 건드리지 않고 그대로 쓴다(알 수 없는 칸은 보존).
    return r as RoomState;
  }
  return {
    schemaVersion: ROOM_SCHEMA_VERSION,
    roomId: r.roomId ?? '',
    createdAt: r.createdAt ?? Date.now(),
    lastActivity: r.lastActivity ?? Date.now(),
    revision: r.revision ?? 1,
    inviteToken: r.inviteToken ?? '',
    locked: r.locked ?? false,
    hostId: r.hostId ?? '',
    hostOfflineSince: r.hostOfflineSince ?? null,
    members: r.members ?? {},
    banned: r.banned ?? [],
    settings: { rulesetId: 'cge2015-standard', packId: DEFAULT_PACK_ID, timerSeconds: 60, replayMode: 'fresh', botSpeed: 'normal', ...(r.settings ?? {}) },
    customWords: r.customWords ?? [],
    game: r.game ?? null,
    lastGame: r.lastGame ?? null,
    chat: r.chat ?? [],
    nextChatId: r.nextChatId ?? 1,
    timer: r.timer ?? null,
    dedup: r.dedup ?? [],
    classLink: r.classLink ?? null,
    solo: r.solo ?? false,
    watchKey: r.watchKey ?? false,
    botTimer: r.botTimer ?? null,
    botMemo: r.botMemo ?? null,
  };
}

export function cleanNickname(v: string): string {
  let out = '';
  for (const ch of v.normalize('NFC')) {
    const c = ch.codePointAt(0) ?? 0;
    if (c < 0x20 || c === 0x7f || '<>&"\'`\\'.includes(ch)) continue;
    out += ch;
  }
  return [...out.replace(/\s+/g, ' ').trim()].slice(0, NICKNAME_MAX).join('');
}

export function cleanText(v: string, max: number): string {
  let out = '';
  for (const ch of v.normalize('NFC')) {
    const c = ch.codePointAt(0) ?? 0;
    if ((c < 0x20 && c !== 0x0a) || c === 0x7f) continue;
    out += ch;
  }
  return [...out.trim()].slice(0, max).join('');
}

function uniqueNickname(room: RoomState, nick: string, selfId?: string): string {
  const taken = new Set(Object.values(room.members).filter((m) => m.id !== selfId).map((m) => m.nickname));
  if (!taken.has(nick)) return nick;
  for (let i = 2; i < 100; i++) {
    const cand = `${[...nick].slice(0, NICKNAME_MAX - 3).join('')}(${i})`;
    if (!taken.has(cand)) return cand;
  }
  return nick;
}

export function createRoom(roomId: string, sessionHash: string, nickname: string, env: RoomEnv): RoomState {
  const hostId = env.newId(9);
  return {
    schemaVersion: ROOM_SCHEMA_VERSION,
    roomId,
    createdAt: env.now,
    lastActivity: env.now,
    revision: 1,
    inviteToken: env.newId(24),
    locked: false,
    hostId,
    hostOfflineSince: null,
    members: {
      [hostId]: { id: hostId, nickname, sessionHash, joinedAt: env.now, team: null, role: 'spectator' },
    },
    banned: [],
    settings: { rulesetId: 'cge2015-standard', packId: DEFAULT_PACK_ID, timerSeconds: 60, replayMode: 'fresh', botSpeed: 'normal' },
    customWords: [],
    game: null,
    lastGame: null,
    chat: [],
    nextChatId: 1,
    timer: null,
    dedup: [],
    classLink: null,
    solo: false,
    watchKey: false,
    botTimer: null,
    botMemo: null,
  };
}

export function memberBySession(room: RoomState, sessionHash: string): Member | undefined {
  return Object.values(room.members).find((m) => m.sessionHash === sessionHash);
}

export type JoinResult = { ok: true; memberId: string; created: boolean } | { ok: false; code: 'banned' | 'badInvite' | 'locked' | 'full' | 'badNickname' | 'classManaged' | 'solo' };

export function joinRoom(room: RoomState, sessionHash: string, inviteOk: boolean, nicknameRaw: string, env: RoomEnv): JoinResult {
  // 학급 방은 독립 방의 초대 경로로 들어올 수 없다 (좌석은 클래스만 정한다)
  if (room.classLink) return { ok: false, code: 'classManaged' };
  if (room.banned.includes(sessionHash)) return { ok: false, code: 'banned' };
  const existing = memberBySession(room, sessionHash);
  if (existing) return { ok: true, memberId: existing.id, created: false };
  if (room.solo) return { ok: false, code: 'solo' };
  if (!inviteOk) return { ok: false, code: 'badInvite' };
  if (room.locked) return { ok: false, code: 'locked' };
  if (Object.keys(room.members).length >= MAX_MEMBERS) return { ok: false, code: 'full' };
  const nick = cleanNickname(nicknameRaw);
  if (!nick) return { ok: false, code: 'badNickname' };
  const id = env.newId(9);
  room.members[id] = { id, nickname: uniqueNickname(room, nick), sessionHash, joinedAt: env.now, team: null, role: 'spectator' };
  room.lastActivity = env.now;
  room.revision++;
  return { ok: true, memberId: id, created: true };
}

export function gameActive(room: RoomState): boolean {
  return !!room.game && room.game.phase !== 'finished';
}

/** 오래 끊긴 방장의 관리 권한을 온라인 참가자에게 넘긴다. 게임 역할·비밀 정보 접근권은 바뀌지 않는다. */
export function maybeTransferHost(room: RoomState, online: Set<string>, env: RoomEnv): boolean {
  if (online.has(room.hostId)) {
    if (room.hostOfflineSince !== null) {
      room.hostOfflineSince = null;
      return true;
    }
    return false;
  }
  if (room.hostOfflineSince === null) {
    room.hostOfflineSince = env.now;
    return true;
  }
  if (env.now - room.hostOfflineSince < env.hostGraceSeconds * 1000) return false;
  const next = Object.values(room.members)
    .filter((m) => m.id !== room.hostId && online.has(m.id) && m.sessionHash)
    .sort((a, b) => a.joinedAt - b.joinedAt)[0];
  if (!next) return false;
  room.hostId = next.id;
  room.hostOfflineSince = null;
  room.revision++;
  return true;
}

export interface CommandEffects {
  /** 강퇴 등으로 연결을 끊어야 하는 세션 */
  closeSessions: { sessionHash: string; reason: 'kicked' | 'replaced' }[];
  /** 세션을 다른 자리로 옮김(쿠키 분실 복구) */
  remapSession: { sessionHash: string; memberId: string } | null;
  closeRoom: boolean;
}

export type CommandResult =
  | { ok: true; scope: 'all' | 'spymasters'; effects: CommandEffects }
  | { ok: false; code: string; message: string; sendState: boolean };

const no = (code: string, message: string, sendState = false): CommandResult => ({ ok: false, code, message, sendState });

function cleanCustomWords(words: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const w of words) {
    const n = normalizeWord(cleanText(w, CUSTOM_WORD_MAX));
    if (!n) continue;
    const k = n.toLocaleLowerCase('ko');
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(n);
    if (out.length >= CUSTOM_WORDS_MAX_COUNT) break;
  }
  return out;
}

// ------------------------------------------------------------------ 봇 참가자

/** 봇 이름: 판의 단어와 헷갈리지 않는 사람 이름. 화면에는 봇 표시가 함께 붙는다. */
export const BOT_NAMES = ['가람', '나래', '다올', '라온', '아라', '한별', '해든', '초롱', '윤슬', '은별', '여울', '새봄', '온새', '이든', '하람', '미르'];

export function botNickname(taken: Set<string>): string {
  for (const n of BOT_NAMES) if (!taken.has(`봇 ${n}`)) return `봇 ${n}`;
  for (let i = 2; i < 100; i++) if (!taken.has(`봇 ${i}`)) return `봇 ${i}`;
  return '봇';
}

const botsIn = (room: RoomState) => Object.values(room.members).filter((m) => m.bot);

/** 새 봇의 자리: 규칙 프로필에 맞춰 빈 역할부터 채운다 */
export function autoSeatBot(room: RoomState, bot: Member) {
  const players = Object.values(room.members).filter((m) => m.id !== bot.id && present(m) && m.role !== 'spectator');
  const count = (t: Team) => players.filter((m) => m.team === t).length;
  const hasSm = (t: Team) => players.some((m) => m.team === t && m.role === 'spymaster');
  const rs = room.classLink ? 'cge2015-standard' : room.settings.rulesetId;
  let team: Team | null;
  let role: SeatRole;
  if (rs === 'cge2015-coop') {
    team = players.find((m) => m.team)?.team ?? 'red';
    role = hasSm(team) ? 'operative' : 'spymaster';
  } else if (rs === 'cge2015-shared-operative') {
    const noSm = (['red', 'blue'] as Team[]).find((t) => !hasSm(t));
    if (noSm) {
      team = noSm;
      role = 'spymaster';
    } else if (!players.some((m) => m.team === null && m.role === 'operative')) {
      team = null;
      role = 'operative';
    } else {
      team = null;
      role = 'spectator';
    }
  } else {
    team = count('red') <= count('blue') ? 'red' : 'blue';
    role = hasSm(team) ? 'operative' : 'spymaster';
  }
  bot.team = team;
  bot.role = role;
  readyBot(room, bot);
}

export function newBotMember(room: RoomState, level: BotLevel, env: RoomEnv, id = env.newId(9), nickname?: string): Member {
  const taken = new Set(Object.values(room.members).map((m) => m.nickname));
  return { id, nickname: nickname ?? botNickname(taken), sessionHash: null, joinedAt: env.now, team: null, role: 'spectator', ready: false, bot: { level } };
}

/** 봇은 자리가 있으면 늘 준비되어 있다 */
function readyBot(room: RoomState, m: Member) {
  m.ready = m.role !== 'spectator' && (!!m.team || (!room.classLink && room.settings.rulesetId === 'cge2015-shared-operative'));
}
function readyBots(room: RoomState) {
  for (const m of botsIn(room)) readyBot(room, m);
}

const coverageCache = new Map<string, boolean>();
/** 이 방의 단어 팩을 봇 스파이마스터가 다룰 수 있는가 (연상 사전에 모든 단어가 있는가) */
export function packKnownToBots(room: RoomState): boolean {
  const id = room.settings.packId;
  if (id === CUSTOM_PACK_ID) return lexiconCovers(room.customWords);
  const hit = coverageCache.get(id);
  if (hit !== undefined) return hit;
  const pack = resolvePack(id, []);
  const ok = !!pack && pack.cards.length > 0 && lexiconCovers(pack.cards.flatMap((c) => (c.faceB ? [c.faceA, c.faceB] : [c.faceA])));
  coverageCache.set(id, ok);
  return ok;
}

export function botProblems(room: RoomState): string[] {
  const sm = botsIn(room).filter((m) => m.role === 'spymaster');
  if (sm.length && !packKnownToBots(room)) return ['봇 스파이마스터는 이 단어 팩의 단어를 모릅니다. 기본 단어 팩(자체 제작)을 고르거나 봇을 추측자 자리로 옮기세요.'];
  return [];
}

/** 혼자 하기 방: 나 + 봇으로 자리를 채운다. 게임 시작은 호출자가 한다. */
export function createSoloRoom(roomId: string, sessionHash: string, nickname: string, cfg: SoloConfig, env: RoomEnv): RoomState {
  const room = createRoom(roomId, sessionHash, nickname, env);
  room.solo = true;
  room.locked = true;
  room.settings.rulesetId = cfg.rulesetId;
  room.settings.botSpeed = cfg.botSpeed;
  const me = room.members[room.hostId] as Member;
  const coop = cfg.rulesetId === 'cge2015-coop';
  const lim = coop ? { min: 2, max: 6 } : { min: 4, max: 8 };
  const total = Math.max(lim.min, Math.min(lim.max, Math.floor(cfg.players)));
  const mine = cfg.myTeam;
  const theirs: Team = mine === 'red' ? 'blue' : 'red';
  const add = (team: Team, role: 'spymaster' | 'operative', level: BotLevel) => {
    const b = newBotMember(room, level, env);
    b.team = team;
    b.role = role;
    b.ready = true;
    room.members[b.id] = b;
  };
  const fill = (team: Team, size: number, level: BotLevel, human: 'spymaster' | 'operative' | null) => {
    let n = human ? size - 1 : size;
    if (human !== 'spymaster') {
      add(team, 'spymaster', level);
      n--;
    }
    for (let i = 0; i < n; i++) add(team, 'operative', level);
  };
  if (cfg.myRole === 'spectator') {
    me.team = null;
    me.role = 'spectator';
    if (coop) fill(mine, total, cfg.allyLevel, null);
    else {
      fill('red', Math.ceil(total / 2), cfg.allyLevel, null);
      fill('blue', Math.floor(total / 2), cfg.enemyLevel, null);
    }
  } else {
    me.team = mine;
    me.role = cfg.myRole;
    if (coop) fill(mine, total, cfg.allyLevel, cfg.myRole);
    else {
      fill(mine, Math.ceil(total / 2), cfg.allyLevel, cfg.myRole);
      fill(theirs, Math.floor(total / 2), cfg.enemyLevel, null);
    }
  }
  return room;
}

/**
 * 명령 하나를 room 에 적용한다(room 을 직접 바꾼다 — 호출자는 복사본을 넘긴다).
 * 멱등 처리(dedup)와 저장은 호출자가 한다.
 */
const CLASS_MANAGED_COMMANDS = new Set<Command['type']>(['lock', 'rotateInvite', 'kick', 'closeRoom', 'transferHost', 'reassignSeat', 'addBot', 'removeBot', 'rematch']);
/** 혼자 하기 방에는 다른 사람이 없으므로 초대·강퇴·이양이 없다 */
const SOLO_BLOCKED_COMMANDS = new Set<Command['type']>(['lock', 'rotateInvite', 'kick', 'transferHost', 'reassignSeat']);

export function applyCommand(
  room: RoomState,
  me: Member,
  msg: Extract<ClientMessage, { t: 'cmd' }>,
  env: RoomEnv,
  online: Set<string>,
  opts: { classStartApproved?: boolean } = {},
): CommandResult {
  const cmd: Command = msg.cmd;
  const cls = room.classLink;
  const isHost = !!room.hostId && me.id === room.hostId;
  if (cls && CLASS_MANAGED_COMMANDS.has(cmd.type)) return no('classManaged', '학급 방의 참가자·초대·봇 관리는 클래스가 합니다.');
  if (room.solo && SOLO_BLOCKED_COMMANDS.has(cmd.type)) return no('soloRoom', '혼자 하기 방에서는 쓰지 않는 기능입니다.');
  if (cls?.closed) return no('closed', '닫힌 방입니다.');
  const effects: CommandEffects = { closeSessions: [], remapSession: null, closeRoom: false };
  const done = (scope: 'all' | 'spymasters' = 'all'): CommandResult => {
    if (scope === 'all') room.revision++;
    room.lastActivity = env.now;
    return { ok: true, scope, effects };
  };
  const hostOnly = () => no('forbidden', '방장만 할 수 있습니다.');
  const inLobby = room.game === null;

  switch (cmd.type) {
    case 'setSeat': {
      if (!inLobby) return no('locked', '게임이 시작되면 팀과 역할이 잠깁니다.');
      if (cls && (cmd.role === 'spectator' || !cmd.team)) return no('badInput', '학급 방에서는 빨강·파랑 중 한 팀을 골라야 합니다.');
      me.ready = false; // 자리를 바꾸면 준비를 다시 누른다
      if (cmd.role === 'spectator') {
        me.team = null;
        me.role = 'spectator';
      } else if (cmd.role === 'spymaster') {
        if (!cmd.team) return no('badInput', '스파이마스터는 팀을 골라야 합니다.');
        me.team = cmd.team;
        me.role = 'spymaster';
      } else {
        me.team = cmd.team; // null = 3인 변형의 공용 추측자
        me.role = 'operative';
      }
      return done();
    }
    case 'setNickname': {
      const nick = cleanNickname(cmd.nickname);
      if (!nick) return no('badInput', '닉네임을 입력하세요.');
      me.nickname = uniqueNickname(room, nick, me.id);
      return done();
    }
    case 'setSettings': {
      if (!isHost) return hostOnly();
      if (!inLobby) return no('locked', '게임 중에는 설정을 바꿀 수 없습니다.');
      if (cls && cmd.rulesetId && cmd.rulesetId !== 'cge2015-standard') return no('classStandardOnly', '학급 모드는 표준 대전으로 진행합니다. 소인원 변형은 독립 게임방에서 쓸 수 있습니다.');
      if (cmd.rulesetId) room.settings.rulesetId = cmd.rulesetId as RulesetId;
      if (cmd.packId) {
        const opt = packOptions(room.customWords).find((p) => p.packId === cmd.packId);
        if (!opt) return no('badInput', '알 수 없는 단어 팩입니다.');
        if (opt.kind === 'official' && !opt.playable) return no('contentUnavailable', opt.reason ?? '정식 콘텐츠가 검증되지 않았습니다.');
        room.settings.packId = cmd.packId;
      }
      if (cmd.timerSeconds) room.settings.timerSeconds = cmd.timerSeconds;
      if (cmd.replayMode) room.settings.replayMode = cmd.replayMode;
      if (cmd.botSpeed) room.settings.botSpeed = cmd.botSpeed;
      if (cmd.rulesetId) readyBots(room);
      return done();
    }
    case 'setCustomWords': {
      if (!isHost) return hostOnly();
      if (!inLobby) return no('locked', '게임 중에는 단어를 바꿀 수 없습니다.');
      room.customWords = cleanCustomWords(cmd.words);
      return done();
    }
    case 'setReady': {
      if (!cls) return no('notSupported', '학급 방에서만 씁니다.');
      if (!inLobby) return no('locked', '게임 중입니다.');
      if (cmd.ready && (!me.team || me.role === 'spectator')) return no('noSeat', '먼저 팀과 역할을 고르세요.');
      me.ready = cmd.ready;
      return done();
    }
    case 'autoBalance': {
      if (!cls) return no('notSupported', '학급 방에서만 씁니다.');
      if (!isHost) return hostOnly();
      if (!inLobby) return no('locked', '게임 중입니다.');
      // 두 팀 인원 차이가 1명 이하가 되게 무작위로 나누고, 팀마다 한 명을 스파이마스터로 둔다 (봇 포함)
      const people = Object.values(room.members).filter(present);
      for (let i = people.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [people[i], people[j]] = [people[j] as Member, people[i] as Member];
      }
      const firstTeam: Team = Math.random() < 0.5 ? 'red' : 'blue';
      people.forEach((m, i) => {
        m.team = i % 2 === 0 ? firstTeam : firstTeam === 'red' ? 'blue' : 'red';
        m.role = i < 2 ? 'spymaster' : 'operative';
        m.ready = false;
      });
      readyBots(room);
      return done();
    }
    case 'startGame': {
      if (!isHost) return hostOnly();
      if (!inLobby) return no('locked', '이미 게임이 진행 중입니다.');
      // 학급 방은 클래스가 명단 버전을 잠근 뒤에만 시작한다 (room.ts 가 잠금을 받아 opts 로 알려 준다)
      if (cls && !opts.classStartApproved) return no('needClassLock', '클래스의 명단 확인이 필요합니다.');
      const seats: Seat[] = Object.values(room.members)
        .filter(present)
        .map((m) => ({ memberId: m.id, team: m.team, role: m.role }));
      const check = validateRoster(room.settings.rulesetId, seats);
      if (!check.ok) return no('notReady', check.problems.join(' '));
      const bp = botProblems(room);
      if (bp.length) return no('botPack', bp.join(' '));
      const option = packOptions(room.customWords).find((p) => p.packId === room.settings.packId);
      if (!option || !option.playable) return no('contentUnavailable', option?.reason ?? '단어 팩을 쓸 수 없습니다.');
      const pack = resolvePack(room.settings.packId, room.customWords);
      if (!pack) return no('contentUnavailable', '단어 팩을 찾을 수 없습니다.');
      const flipFrom =
        room.settings.replayMode === 'flip' && room.lastGame && room.lastGame.packId === room.settings.packId && room.settings.packId !== CUSTOM_PACK_ID
          ? room.lastGame.cards
          : null;
      const res = createGame({
        gameId: env.newId(12),
        rulesetId: room.settings.rulesetId,
        pack,
        seed: env.newId(16),
        roster: check.roster,
        coopTeam: check.coopTeam,
        now: env.now,
        flipFrom,
      });
      if (!res.ok) return no('contentUnavailable', res.message);
      room.game = res.state;
      room.timer = null;
      return done();
    }
    case 'backToLobby': {
      if (!isHost) return hostOnly();
      if (!room.game) return no('badInput', '이미 대기실입니다.');
      if (room.game.phase !== 'finished') return no('locked', '진행 중인 게임은 먼저 중단해야 합니다.');
      room.lastGame = { packId: room.game.setup.packId, cards: room.game.setup.cards };
      if (cls) {
        cls.pendingRelease = room.game.gameId; // 클래스에 명단 잠금 해제를 알린다 (room.ts)
        for (const m of Object.values(room.members)) m.ready = false;
        readyBots(room);
      }
      room.game = null;
      room.timer = null;
      room.botTimer = null;
      return done();
    }
    case 'rematch': {
      // 끝난 게임 → 대기실 → 같은 구성으로 새 게임 (한 번의 저장)
      if (!isHost) return hostOnly();
      if (!room.game || room.game.phase !== 'finished') return no('badInput', '끝난 게임에서만 다시 할 수 있습니다.');
      const back = applyCommand(room, me, { ...msg, cmd: { type: 'backToLobby' } }, env, online, opts);
      if (!back.ok) return back;
      return applyCommand(room, me, { ...msg, cmd: { type: 'startGame' } }, env, online, opts);
    }
    case 'addBot': {
      if (!isHost) return hostOnly();
      if (!inLobby) return no('locked', '게임 중에는 봇을 넣을 수 없습니다.');
      if (botsIn(room).length >= MAX_BOTS_PER_ROOM) return no('tooManyBots', `봇은 한 방에 ${MAX_BOTS_PER_ROOM}명까지입니다.`);
      if (Object.keys(room.members).length >= MAX_MEMBERS) return no('full', '방 인원이 가득 찼습니다.');
      const b = newBotMember(room, cmd.level, env);
      room.members[b.id] = b;
      autoSeatBot(room, b);
      return done();
    }
    case 'removeBot': {
      if (!isHost) return hostOnly();
      if (!inLobby) return no('locked', '게임 중에는 봇을 뺄 수 없습니다.');
      const b = room.members[cmd.memberId];
      if (!b?.bot) return no('badInput', '봇을 찾을 수 없습니다.');
      delete room.members[b.id];
      return done();
    }
    case 'setBotSeat': {
      if (!isHost) return hostOnly();
      if (!inLobby) return no('locked', '게임이 시작되면 팀과 역할이 잠깁니다.');
      const b = room.members[cmd.memberId];
      if (!b?.bot) return no('badInput', '봇을 찾을 수 없습니다.');
      if (cls && (cmd.role === 'spectator' || !cmd.team)) return no('badInput', '학급 방에서는 빨강·파랑 중 한 팀을 골라야 합니다.');
      if (cmd.role === 'spymaster' && !cmd.team) return no('badInput', '스파이마스터는 팀을 골라야 합니다.');
      b.team = cmd.role === 'spectator' ? null : cmd.team;
      b.role = cmd.role;
      readyBot(room, b);
      return done();
    }
    case 'setWatchKey': {
      if (!isHost) return hostOnly();
      room.watchKey = cmd.on;
      return done();
    }
    case 'chat': {
      const text = cleanText(cmd.text, CHAT_MAX);
      if (!text) return no('badInput', '빈 메시지입니다.');
      if (gameActive(room)) {
        // 진행 중에는 추측자끼리의 공개 토론만. 스파이마스터·관전자는 자유 채팅으로 추가 힌트를 줄 수 없다.
        const r = rosterEntry(room.game as GameState, me.id);
        if (!r || r.role === 'spymaster') return no('forbidden', '게임 중에는 추측자만 토론 채팅을 쓸 수 있습니다.');
      }
      room.chat.push({ id: room.nextChatId++, memberId: me.id, nickname: me.nickname, text, at: env.now });
      room.chat = room.chat.slice(-CHAT_KEEP);
      return done();
    }
    case 'timerStart': {
      if (!gameActive(room)) return no('badInput', '게임 중에만 쓸 수 있습니다.');
      if (!rosterEntry(room.game as GameState, me.id)) return no('forbidden', '참가자만 모래시계를 뒤집을 수 있습니다.');
      const seconds = (TIMER_CHOICES as readonly number[]).includes(room.settings.timerSeconds) ? room.settings.timerSeconds : 60;
      room.timer = { endsAt: env.now + seconds * 1000, seconds, startedBy: me.id };
      return done();
    }
    case 'timerCancel': {
      if (!room.timer) return no('badInput', '진행 중인 모래시계가 없습니다.');
      if (!room.game || !rosterEntry(room.game, me.id)) return no('forbidden', '참가자만 멈출 수 있습니다.');
      room.timer = null;
      return done();
    }
    case 'lock': {
      if (!isHost) return hostOnly();
      room.locked = cmd.locked;
      return done();
    }
    case 'rotateInvite': {
      if (!isHost) return hostOnly();
      room.inviteToken = env.newId(24);
      return done();
    }
    case 'kick': {
      if (!isHost) return hostOnly();
      const target = room.members[cmd.memberId];
      if (!target) return no('badInput', '참가자를 찾을 수 없습니다.');
      if (target.id === me.id) return no('badInput', '자기 자신은 강퇴할 수 없습니다.');
      if (target.bot) return no('isBot', '봇은 대기실에서 ‘봇 빼기’로 뺍니다.');
      if (target.sessionHash) {
        if (!room.banned.includes(target.sessionHash)) room.banned.push(target.sessionHash);
        effects.closeSessions.push({ sessionHash: target.sessionHash, reason: 'kicked' });
      }
      if (gameActive(room) && rosterEntry(room.game as GameState, target.id)) {
        target.sessionHash = null; // 게임 자리는 남기고 연결만 끊는다. 방장이 새 세션을 지정할 수 있다.
      } else {
        delete room.members[target.id];
      }
      return done();
    }
    case 'closeRoom': {
      if (!isHost) return hostOnly();
      effects.closeRoom = true;
      return done();
    }
    case 'transferHost': {
      if (!isHost) return hostOnly();
      const target = room.members[cmd.memberId];
      if (!target || !target.sessionHash) return no('badInput', '넘겨받을 참가자를 찾을 수 없습니다.');
      room.hostId = target.id;
      room.hostOfflineSince = online.has(target.id) ? null : env.now;
      return done();
    }
    case 'reassignSeat': {
      // 쿠키를 잃은 참가자가 새 세션으로 들어왔을 때, 방장 승인으로 기존 자리를 되찾게 한다.
      if (!isHost) return hostOnly();
      const from = room.members[cmd.fromMemberId];
      const to = room.members[cmd.toMemberId];
      if (!from || !to || from.id === to.id || !from.sessionHash) return no('badInput', '참가자를 찾을 수 없습니다.');
      if (to.sessionHash && online.has(to.id)) return no('badInput', '지금 접속 중인 자리는 넘길 수 없습니다.');
      if (room.game) {
        if (rosterEntry(room.game, from.id)) return no('badInput', '이미 게임 자리가 있는 참가자입니다.');
        const toRole = rosterEntry(room.game, to.id)?.role;
        // 이미 정답을 본 사람이 추측자 자리로 옮기는 우회를 막는다.
        if (room.game.sawKey.includes(from.id) && toRole !== 'spymaster') return no('forbidden', '정답을 본 참가자는 추측자 자리로 옮길 수 없습니다.');
      }
      if (to.sessionHash) effects.closeSessions.push({ sessionHash: to.sessionHash, reason: 'replaced' });
      to.sessionHash = from.sessionHash;
      effects.remapSession = { sessionHash: from.sessionHash, memberId: to.id };
      if (room.hostId === from.id) room.hostId = to.id;
      delete room.members[from.id];
      if (to.bot) {
        // 봇 자리를 사람이 이어받는다: 이름도 그 사람 것으로
        delete to.bot;
        to.nickname = uniqueNickname(room, from.nickname, to.id);
      }
      return done();
    }
    case 'game': {
      const g = room.game;
      if (!g) return no('staleGame', '진행 중인 게임이 없습니다.', true);
      if (msg.gameId !== g.gameId) return no('staleGame', '이전 게임의 명령입니다.', true);
      const a = cmd.action;
      const isPrivate = a.type === 'spyQuery' || a.type === 'spyQueryAnswer';
      if (!isPrivate && msg.expectedRevision !== g.revision) return no('staleRevision', '화면이 최신이 아니었습니다. 최신 상태를 확인하고 다시 선택하세요.', true);
      if ((a.type === 'replaceSpymaster' || a.type === 'abort') && !isHost) return hostOnly();
      const res = applyAction(g, me.id, a, env.now);
      if (!res.ok) return no(res.error.code, res.error.message, true);
      room.game = res.state;
      if (a.type === 'replaceSpymaster') {
        for (const m of Object.values(room.members)) {
          if (m.role === 'spymaster' && m.team === a.team && m.id !== a.newMemberId) {
            m.role = 'spectator';
            m.team = null;
          }
        }
        const nm = room.members[a.newMemberId];
        if (nm) nm.role = 'spymaster';
      }
      if (res.state.phase === 'finished') room.timer = null;
      return done(res.changed === 'spymasters' ? 'spymasters' : 'all');
    }
  }
}

// ------------------------------------------------------------------ 학급 모드

export function isTeacherSession(room: RoomState, sessionHash: string): boolean {
  return !!room.classLink && !room.classLink.closed && room.classLink.teacherHashes.includes(sessionHash);
}

export interface ClassSyncOutcome {
  room: RoomState | null;
  result: 'created' | 'applied' | 'stale' | 'ignored' | 'mismatch';
  /** 연결을 끊어야 하는 세션: removed = 명단에서 빠진 학생, replaced = 세션이 바뀐 자리·권한이 거둬진 교사 세션 */
  closeSessions: { sessionHash: string; reason: 'removed' | 'replaced' }[];
  closedNow: boolean;
}

/**
 * 클래스가 보낸 명단을 반영한다. 버전이 더 새로울 때만 적용하므로 재전송·순서 바뀜에 안전하다.
 * 게임이 진행 중이면 좌석을 더하거나 빼지 않고(클래스도 그러지 않는다) 세션·방장 변경만 반영한다.
 */
export function applyClassSync(room: RoomState | null, p: ClassRoomSync, env: RoomEnv): ClassSyncOutcome {
  if (!room) {
    if (p.closed) return { room: null, result: 'ignored', closeSessions: [], closedNow: false };
    const r: RoomState = {
      ...createRoom(p.roomId, '', '', env),
      members: {},
      hostId: '',
      inviteToken: '',
      classLink: {
        classId: p.classId,
        className: p.className,
        roomName: p.name,
        syncVersion: 0,
        capacity: p.capacity,
        teacherHashes: [],
        closed: false,
        closeReason: null,
        pendingConfirm: null,
        pendingRelease: null,
      },
    };
    const out = applyClassSync(r, p, env);
    return { ...out, result: out.result === 'applied' ? 'created' : out.result };
  }
  const link = room.classLink;
  if (!link || link.classId !== p.classId) return { room, result: 'mismatch', closeSessions: [], closedNow: false };
  if (p.syncVersion <= link.syncVersion) return { room, result: 'stale', closeSessions: [], closedNow: false };

  // 닫힘: 명단은 그대로 두고(기록용) 진행 중 게임만 ‘수업 종료로 중단’. 연결 종료는 room.ts 가 'closed' 로 한다.
  if (p.closed) {
    const wasClosed = link.closed;
    if (!wasClosed && gameActive(room) && room.game) {
      const res = applyAction(room.game, '', { type: 'abort', reason: 'classEnded' }, env.now);
      if (res.ok) room.game = res.state;
    }
    link.closed = true;
    link.closeReason = p.closeReason;
    link.syncVersion = p.syncVersion;
    room.timer = null;
    room.revision++;
    room.lastActivity = env.now;
    return { room, result: 'applied', closeSessions: [], closedNow: !wasClosed };
  }

  const closeSessions: ClassSyncOutcome['closeSessions'] = [];
  const active = gameActive(room);
  const inRoster = (id: string) => !!room.game && !!rosterEntry(room.game, id);
  let rosterChanged = false;

  const incoming = new Map(p.members.map((m) => [m.memberId, m]));
  for (const [id, m] of Object.entries(room.members)) {
    const next = incoming.get(id);
    if (!next) {
      if (m.sessionHash) closeSessions.push({ sessionHash: m.sessionHash, reason: 'removed' });
      if (active && inRoster(id)) m.sessionHash = null; // 진행 중인 게임 자리는 남긴다
      else delete room.members[id];
      rosterChanged = true;
      continue;
    }
    if (m.sessionHash !== next.sessionHash) {
      if (m.sessionHash) closeSessions.push({ sessionHash: m.sessionHash, reason: 'replaced' });
      m.sessionHash = next.sessionHash;
    }
    m.nickname = next.nickname;
  }
  const newBots: Member[] = [];
  for (const [id, m] of incoming) {
    if (room.members[id]) continue;
    if (m.bot) {
      // 클래스가 넣은 봇: 비어 있는 역할부터 앉힌다 (대기실에서 방장이 옮길 수 있다)
      const b = newBotMember(room, m.bot.level, env, id, m.nickname);
      room.members[id] = b;
      newBots.push(b);
    } else {
      // 진행 중에는 새 학생을 게임에 끼워 넣지 않는다 (들어와도 관전만 되고, 클래스는 애초에 보내지 않는다)
      room.members[id] = { id, nickname: m.nickname, sessionHash: m.sessionHash, joinedAt: env.now, team: null, role: 'spectator', ready: false };
    }
    rosterChanged = true;
  }
  if (!active) for (const b of newBots) autoSeatBot(room, b);
  for (const h of link.teacherHashes) if (!p.teacherHashes.includes(h)) closeSessions.push({ sessionHash: h, reason: 'replaced' });
  // 학생 방장이 없으면(선생님이 만든 방, 방장 권한 회수) 선생님이 방장 역할을 한다
  const hostChanged = room.hostId !== (p.hostMemberId ?? TEACHER_ID);
  const capChanged = link.capacity !== p.capacity;
  room.hostId = p.hostMemberId ?? TEACHER_ID;
  link.roomName = p.name;
  link.capacity = p.capacity;
  link.className = p.className;
  link.teacherHashes = p.teacherHashes.slice();
  link.syncVersion = p.syncVersion;
  // 운영상 변경(명단·정원·방장)은 모두에게 보이고 준비 상태를 초기화한다
  if (rosterChanged || capChanged || hostChanged) {
    for (const m of Object.values(room.members)) m.ready = false;
    readyBots(room);
  }

  room.revision++;
  room.lastActivity = env.now;
  return { room, result: 'applied', closeSessions, closedNow: false };
}

/** 학급 방 시작 조건: 정원 충족, 전원 온라인·준비, 역할 조건, 두 팀 인원 차이 1명 이하 */
export function classStartProblems(room: RoomState, online: Set<string>): string[] {
  const link = room.classLink;
  if (!link) return [];
  const problems: string[] = [];
  const people = Object.values(room.members).filter(present);
  if (people.length !== link.capacity) problems.push(`정원 ${link.capacity}명이 모두 들어와야 시작할 수 있습니다 (지금 ${people.length}명).`);
  const offline = people.filter((m) => !m.bot && !online.has(m.id)).map((m) => m.nickname);
  if (offline.length) problems.push(`접속하지 않은 사람: ${offline.join(', ')}`);
  const noSeat = people.filter((m) => !m.team || m.role === 'spectator').map((m) => m.nickname);
  if (noSeat.length) problems.push(`팀·역할을 고르지 않은 사람: ${noSeat.join(', ')}`);
  const notReady = people.filter((m) => !m.ready).map((m) => m.nickname);
  if (notReady.length) problems.push(`준비 완료를 누르지 않은 사람: ${notReady.join(', ')}`);
  const red = people.filter((m) => m.team === 'red').length;
  const blue = people.filter((m) => m.team === 'blue').length;
  if (Math.abs(red - blue) > 1) problems.push(`두 팀 인원 차이는 1명 이하여야 합니다 (빨강 ${red} · 파랑 ${blue}).`);
  const check = validateRoster('cge2015-standard', people.filter((m) => m.team).map((m) => ({ memberId: m.id, team: m.team, role: m.role })));
  if (!check.ok) problems.push(...check.problems);
  problems.push(...botProblems(room));
  return [...new Set(problems)];
}

/** 클래스에 보내는 공개 진행 요약 (정답·단어·힌트 없음) */
export function roomSummary(room: RoomState, online: Set<string>): { readyCount: number; onlineCount: number; summary: RoomSummary } {
  const people = Object.values(room.members).filter(present);
  const g = room.game;
  return {
    readyCount: people.filter((m) => m.ready).length,
    onlineCount: people.filter((m) => m.bot || online.has(m.id)).length,
    summary: {
      phase: !g ? 'lobby' : g.phase === 'finished' ? 'finished' : 'playing',
      gameId: g?.gameId ?? null,
      turnTeam: g && g.phase !== 'finished' ? g.turnTeam : null,
      remaining: g ? { red: remainingAgents(g, 'red'), blue: remainingAgents(g, 'blue') } : null,
      clueCount: g?.clues.length ?? 0,
      winner: g?.winner ?? null,
      endReason: g?.endReason ?? null,
    },
  };
}

export function recordDedup(room: RoomState, entry: DedupEntry) {
  room.dedup.push(entry);
  if (room.dedup.length > DEDUP_KEEP) room.dedup = room.dedup.slice(-DEDUP_KEEP);
}

export function isSpymasterViewer(room: RoomState, memberId: string): boolean {
  return !!room.game && rosterEntry(room.game, memberId)?.role === 'spymaster';
}

export function projectRoom(room: RoomState, memberId: string, online: Set<string>, env: RoomEnv): RoomView {
  const me = room.members[memberId];
  const teacherView = memberId === TEACHER_ID;
  const cls = room.classLink;
  const game = room.game;
  const members: MemberView[] = Object.values(room.members)
    .sort((a, b) => a.joinedAt - b.joinedAt)
    .map((m) => {
      let team = m.team;
      let role: SeatRole = m.role;
      if (game) {
        const r = rosterEntry(game, m.id);
        if (r) {
          team = r.team;
          role = r.role === 'spymaster' ? 'spymaster' : 'operative';
        } else {
          team = null;
          role = 'spectator';
        }
      }
      return {
        id: m.id,
        nickname: m.nickname,
        team,
        role,
        online: !!m.bot || online.has(m.id),
        isHost: m.id === room.hostId,
        detached: !m.sessionHash && !m.bot,
        joinedAt: m.joinedAt,
        ready: !!m.ready,
        bot: m.bot ? { level: m.bot.level } : null,
      };
    });
  // 참가자가 모두 봇인 게임만 관전자에게 정답을 보여 줄 수 있다 (사람이 한 명이라도 있으면 끈다)
  const allBots = !!game && game.roster.length > 0 && game.roster.every((r) => !!room.members[r.memberId]?.bot);
  const watch = allBots && room.watchKey && !!game && !rosterEntry(game, memberId);
  const memo = game && room.botMemo?.gameId === game.gameId ? room.botMemo : null;
  const showIntents = !!game && (game.phase === 'finished' || watch);
  return {
    roomId: room.roomId,
    revision: room.revision,
    serverNow: env.now,
    you: { memberId, isHost: !!room.hostId && memberId === room.hostId, nickname: teacherView ? '선생님 (관전)' : (me?.nickname ?? '') },
    members,
    hostId: room.hostId,
    hostOfflineSince: room.hostOfflineSince,
    hostGraceSeconds: env.hostGraceSeconds,
    locked: room.locked,
    inviteToken: cls ? '' : room.inviteToken,
    settings: { ...room.settings },
    customWords: room.customWords.slice(),
    packs: packOptions(room.customWords),
    game: game ? projectGame(game, memberId, packTitle(game.setup.packId), { watchKey: watch }) : null,
    chat: room.chat.slice(),
    timer: room.timer ? { ...room.timer } : null,
    ttlHours: env.ttlHours,
    classMode: cls
      ? { classId: cls.classId, className: cls.className, roomName: cls.roomName, capacity: cls.capacity, isTeacher: teacherView, startProblems: game ? [] : classStartProblems(room, online) }
      : null,
    solo: room.solo,
    watchKey: room.watchKey,
    botActivity: room.botTimer && game && game.phase !== 'finished' ? { memberId: room.botTimer.memberId, kind: room.botTimer.kind } : null,
    botIntents:
      showIntents && memo && game
        ? memo.intents.map((x) => ({ clueId: x.clueId, words: x.targets.map((i) => game.words[i] ?? '').filter(Boolean) }))
        : [],
    botProblems: game ? [] : botProblems(room),
  };
}
