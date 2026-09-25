// 봇(가짜 참가자) 표시용 타입과 설정값. 서버·클라이언트가 함께 쓴다.
// 봇의 판단 로직과 연상 사전은 서버 전용이다 (src/server/bots).

import type { Team } from '../game/types.ts';

export type BotLevel = 'easy' | 'normal' | 'hard';
export type BotSpeed = 'slow' | 'normal' | 'fast';

export const BOT_LEVELS: readonly BotLevel[] = ['easy', 'normal', 'hard'];
export const BOT_SPEEDS: readonly BotSpeed[] = ['slow', 'normal', 'fast'];

export const BOT_LEVEL_NAME: Record<BotLevel, string> = { easy: '쉬움', normal: '보통', hard: '어려움' };
export const BOT_SPEED_NAME: Record<BotSpeed, string> = { slow: '천천히', normal: '보통', fast: '빠르게' };

/** 난이도 설명 (화면 안내용) */
export const BOT_LEVEL_HINT: Record<BotLevel, string> = {
  easy: '한 번에 1~2장만 노리는 쉬운 힌트. 추측은 자주 흔들립니다.',
  normal: '연결이 분명할 때만 여러 장(최대 3장)을 묶습니다. 추측이 대체로 정확합니다.',
  hard: '약한 연결까지 묶어 최대 4장을 노리고, 추측이 정확하며 지난 힌트의 +1 기회도 씁니다.',
};

/** 한 방에 둘 수 있는 봇 수 (운영 설정) */
export const MAX_BOTS_PER_ROOM = 8;

/** 봇이 지금 하는 일 (화면 안내용) */
export type BotTaskKind = 'clue' | 'guess' | 'advise' | 'vote' | 'penalty' | 'simulate' | 'answer';

export const BOT_TASK_TEXT: Record<BotTaskKind, string> = {
  clue: '힌트를 생각하는 중',
  guess: '카드를 고르는 중',
  advise: '힌트를 풀어 보는 중',
  vote: '신고를 판정하는 중',
  penalty: '벌칙 카드를 고르는 중',
  simulate: '가상 상대의 요원을 고르는 중',
  answer: '문의에 답하는 중',
};

/** 혼자 하기 설정 */
export interface SoloConfig {
  rulesetId: 'cge2015-standard' | 'cge2015-coop';
  /** spectator = 봇끼리 하는 게임을 관전 */
  myRole: 'operative' | 'spymaster' | 'spectator';
  myTeam: Team;
  /** 게임에 참가하는 전체 인원(나 포함, 관전이면 봇 수) */
  players: number;
  /** 우리 팀 봇 실력 (관전이면 빨강 팀) */
  allyLevel: BotLevel;
  /** 상대 팀 봇 실력 = 난이도 (관전이면 파랑 팀) */
  enemyLevel: BotLevel;
  botSpeed: BotSpeed;
}

export const SOLO_PLAYERS = {
  'cge2015-standard': { min: 4, max: 8, default: 4 },
  'cge2015-coop': { min: 2, max: 6, default: 3 },
} as const;
