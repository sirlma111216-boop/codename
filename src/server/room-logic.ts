// 방(대기실·권한·채팅·타이머)과 게임 명령 처리. 입출력이 없는 함수라 테스트할 수 있다.
// 실제 저장·전송은 room.ts(Durable Object)가 한다.

import { applyAction, rosterEntry } from '../game/engine.ts';
import { projectGame } from '../game/projection.ts';
import { validateRoster, type Seat } from '../game/rulesets.ts';
import { createGame } from '../game/setup.ts';
import type { GameState, RulesetId, Team } from '../game/types.ts';
import { CHAT_MAX, CUSTOM_WORD_MAX, CUSTOM_WORDS_MAX_COUNT, NICKNAME_MAX, TIMER_CHOICES, type ClientMessage, type Command } from '../shared/protocol.ts';
import type { ChatMessage, MemberView, RoomSettings, RoomView, SeatRole } from '../shared/view.ts';
import { normalizeWord } from '../game/content.ts';
import { CUSTOM_PACK_ID, DEFAULT_PACK_ID, packOptions, packTitle, resolvePack } from './packs.ts';

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
}

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
    settings: { rulesetId: 'cge2015-standard', packId: DEFAULT_PACK_ID, timerSeconds: 60, replayMode: 'fresh', ...(r.settings ?? {}) },
    customWords: r.customWords ?? [],
    game: r.game ?? null,
    lastGame: r.lastGame ?? null,
    chat: r.chat ?? [],
    nextChatId: r.nextChatId ?? 1,
    timer: r.timer ?? null,
    dedup: r.dedup ?? [],
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
    settings: { rulesetId: 'cge2015-standard', packId: DEFAULT_PACK_ID, timerSeconds: 60, replayMode: 'fresh' },
    customWords: [],
    game: null,
    lastGame: null,
    chat: [],
    nextChatId: 1,
    timer: null,
    dedup: [],
  };
}

export function memberBySession(room: RoomState, sessionHash: string): Member | undefined {
  return Object.values(room.members).find((m) => m.sessionHash === sessionHash);
}

export type JoinResult = { ok: true; memberId: string; created: boolean } | { ok: false; code: 'banned' | 'badInvite' | 'locked' | 'full' | 'badNickname' };

export function joinRoom(room: RoomState, sessionHash: string, inviteOk: boolean, nicknameRaw: string, env: RoomEnv): JoinResult {
  if (room.banned.includes(sessionHash)) return { ok: false, code: 'banned' };
  const existing = memberBySession(room, sessionHash);
  if (existing) return { ok: true, memberId: existing.id, created: false };
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

/**
 * 명령 하나를 room 에 적용한다(room 을 직접 바꾼다 — 호출자는 복사본을 넘긴다).
 * 멱등 처리(dedup)와 저장은 호출자가 한다.
 */
export function applyCommand(room: RoomState, me: Member, msg: Extract<ClientMessage, { t: 'cmd' }>, env: RoomEnv, online: Set<string>): CommandResult {
  const cmd: Command = msg.cmd;
  const isHost = me.id === room.hostId;
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
      if (cmd.rulesetId) room.settings.rulesetId = cmd.rulesetId as RulesetId;
      if (cmd.packId) {
        const opt = packOptions(room.customWords).find((p) => p.packId === cmd.packId);
        if (!opt) return no('badInput', '알 수 없는 단어 팩입니다.');
        if (opt.kind === 'official' && !opt.playable) return no('contentUnavailable', opt.reason ?? '정식 콘텐츠가 검증되지 않았습니다.');
        room.settings.packId = cmd.packId;
      }
      if (cmd.timerSeconds) room.settings.timerSeconds = cmd.timerSeconds;
      if (cmd.replayMode) room.settings.replayMode = cmd.replayMode;
      return done();
    }
    case 'setCustomWords': {
      if (!isHost) return hostOnly();
      if (!inLobby) return no('locked', '게임 중에는 단어를 바꿀 수 없습니다.');
      room.customWords = cleanCustomWords(cmd.words);
      return done();
    }
    case 'startGame': {
      if (!isHost) return hostOnly();
      if (!inLobby) return no('locked', '이미 게임이 진행 중입니다.');
      const seats: Seat[] = Object.values(room.members)
        .filter((m) => m.sessionHash)
        .map((m) => ({ memberId: m.id, team: m.team, role: m.role }));
      const check = validateRoster(room.settings.rulesetId, seats);
      if (!check.ok) return no('notReady', check.problems.join(' '));
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
      room.game = null;
      room.timer = null;
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

export function recordDedup(room: RoomState, entry: DedupEntry) {
  room.dedup.push(entry);
  if (room.dedup.length > DEDUP_KEEP) room.dedup = room.dedup.slice(-DEDUP_KEEP);
}

export function isSpymasterViewer(room: RoomState, memberId: string): boolean {
  return !!room.game && rosterEntry(room.game, memberId)?.role === 'spymaster';
}

export function projectRoom(room: RoomState, memberId: string, online: Set<string>, env: RoomEnv): RoomView {
  const me = room.members[memberId];
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
      return { id: m.id, nickname: m.nickname, team, role, online: online.has(m.id), isHost: m.id === room.hostId, detached: !m.sessionHash, joinedAt: m.joinedAt };
    });
  return {
    roomId: room.roomId,
    revision: room.revision,
    serverNow: env.now,
    you: { memberId, isHost: memberId === room.hostId, nickname: me?.nickname ?? '' },
    members,
    hostId: room.hostId,
    hostOfflineSince: room.hostOfflineSince,
    hostGraceSeconds: env.hostGraceSeconds,
    locked: room.locked,
    inviteToken: room.inviteToken,
    settings: { ...room.settings },
    customWords: room.customWords.slice(),
    packs: packOptions(room.customWords),
    game: game ? projectGame(game, memberId, packTitle(game.setup.packId)) : null,
    chat: room.chat.slice(),
    timer: room.timer ? { ...room.timer } : null,
    ttlHours: env.ttlHours,
  };
}
