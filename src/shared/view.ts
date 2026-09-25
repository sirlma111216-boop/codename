// 클라이언트로 나가는 표시용 타입. 비밀 키 원본(키 id, 회전, seed, 미공개 정체)은 여기에 없다.
// 스파이마스터에게만 `key` 가 채워진다 — 서버의 projection 함수가 역할별로 결정한다.

import type { ClueNumber, EndReason, GameRole, Identity, LogEntry, Phase, RulesetId, Team, ContentKind } from '../game/types.ts';
import type { BotLevel, BotSpeed, BotTaskKind } from './bots.ts';

export type { ClueNumber, EndReason, GameRole, Identity, LogEntry, Phase, RulesetId, Team, ContentKind };

export const PROTOCOL_VERSION = 1;

export type SeatRole = 'spymaster' | 'operative' | 'spectator';

export interface RevealView {
  identity: Identity;
  cover: string;
  by: 'guess' | 'penalty' | 'simulated';
  order: number;
}

export interface CardView {
  index: number;
  word: string;
  revealed: RevealView | null;
  /** 스파이마스터(또는 종료 후 모두)에게만 채워진다 */
  key?: Identity;
}

export interface ClueView {
  id: number;
  team: Team;
  word: string;
  number: ClueNumber;
  turn: number;
}

export interface SpyQueryView {
  id: number;
  from: Team;
  draft: string;
  answer: 'allow' | 'disallow' | null;
  at: number;
}

export interface GameView {
  gameId: string;
  revision: number;
  rulesetId: RulesetId;
  rulesetVersion: string;
  phase: Phase;
  startingTeam: Team;
  coopTeam: Team | null;
  turnTeam: Team;
  turnNumber: number;
  cards: CardView[];
  currentClue: ClueView | null;
  guessesMade: number;
  guessLimit: number | null;
  remaining: Record<Team, number>;
  clues: ClueView[];
  log: LogEntry[];
  dispute: { clueId: number; reportedBy: string; votes: Record<Team, 'invalid' | 'valid' | null> } | null;
  penalty: { team: Team } | null;
  winner: Team | null;
  endReason: EndReason | null;
  coopScore: number | null;
  roster: { memberId: string; team: Team | null; role: GameRole }[];
  sawKey: string[];
  content: { packTitle: string; kind: ContentKind; keySource: 'officialKey' | 'randomLayout' };
  me: { role: GameRole | 'spectator'; team: Team | null; canSeeKey: boolean };
  /** 두 스파이마스터에게만 */
  spyQueries?: SpyQueryView[];
}

export interface MemberView {
  id: string;
  nickname: string;
  team: Team | null;
  role: SeatRole;
  online: boolean;
  isHost: boolean;
  /** 게임 중 자리 주인의 연결(쿠키)이 없어진 상태 — 방장이 새 세션을 지정할 수 있다 */
  detached: boolean;
  joinedAt: number;
  /** 학급 방: 준비 완료 */
  ready: boolean;
  /** 봇이면 채워진다 (사람과 같은 규칙으로 서버가 움직인다) */
  bot: { level: BotLevel } | null;
}

export interface PackOption {
  packId: string;
  title: string;
  kind: ContentKind;
  status: string;
  playable: boolean;
  reason: string | null;
  cardCount: number;
  keyLabel: string;
}

export interface ChatMessage {
  id: number;
  memberId: string;
  nickname: string;
  text: string;
  at: number;
}

export interface RoomSettings {
  rulesetId: RulesetId;
  packId: string;
  timerSeconds: number;
  replayMode: 'fresh' | 'flip';
  /** 봇이 생각하는 시간 (운영 설정) */
  botSpeed: BotSpeed;
}

export interface RoomView {
  roomId: string;
  revision: number;
  serverNow: number;
  you: { memberId: string; isHost: boolean; nickname: string };
  members: MemberView[];
  hostId: string;
  hostOfflineSince: number | null;
  hostGraceSeconds: number;
  locked: boolean;
  inviteToken: string;
  settings: RoomSettings;
  customWords: string[];
  packs: PackOption[];
  game: GameView | null;
  chat: ChatMessage[];
  timer: { endsAt: number; seconds: number; startedBy: string } | null;
  ttlHours: number;
  /** 학급 모드 방이면 채워진다. 참가자 관리(초대·강퇴 등)는 클래스가 한다 */
  classMode: { classId: string; className: string; roomName: string; capacity: number; isTeacher: boolean; startProblems: string[] } | null;
  /** 혼자 하기 방 (다른 사람이 들어올 수 없다) */
  solo: boolean;
  /** 참가자가 모두 봇인 게임에서 관전자에게 정답을 보여 주는가 */
  watchKey: boolean;
  /** 지금 생각 중인 봇 */
  botActivity: { memberId: string; kind: BotTaskKind } | null;
  /** 봇 스파이마스터가 노린 단어. 게임이 끝났거나, 모두 봇인 게임을 정답 보기로 관전할 때만 채워진다 */
  botIntents: { clueId: number; words: string[] }[];
  /** 시작 전에 알아야 할 봇 관련 문제 (예: 봇 스파이마스터가 모르는 단어 팩) */
  botProblems: string[];
}
