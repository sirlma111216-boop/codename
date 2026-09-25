// 게임 엔진의 서버 전용 상태 타입.
// 이 파일의 GameState 는 비밀 정보(미공개 정체, 키 ID, 회전, seed)를 담는다.
// 클라이언트로 보낼 때는 반드시 projection.ts 를 거친다.

export type Team = 'red' | 'blue';
export type Identity = 'red' | 'blue' | 'bystander' | 'assassin';

export const TEAMS: readonly Team[] = ['red', 'blue'];
export const otherTeam = (t: Team): Team => (t === 'red' ? 'blue' : 'red');

/**
 * 규칙 프로필. 모두 2015 CGE 영문 룰북(July 2015) 기준이다.
 *  - standard: 표준 대전 (p.2~7)
 *  - coop: 소인원 협력 변형, 가상 상대 (p.8 "Two-Player Game") — '듀엣'이 아니다
 *  - sharedOperative: 3인 경쟁 변형, 두 스파이마스터 + 공용 추측자 (p.8 "Three-Player Game")
 */
export type RulesetId = 'cge2015-standard' | 'cge2015-coop' | 'cge2015-shared-operative';
export const RULESET_VERSION = 'cge-2015-07-en.1';

export type Phase =
  | 'awaitingClue'
  | 'guessing'
  | 'clueDispute'
  | 'penaltyResolution'
  | 'simulatedOpponentTurn'
  | 'finished';

/** 0 = 관련 단어 없음(추측 상한 없음), 1~9 = 일반, 'unlimited' = 무제한 */
export type ClueNumber = number | 'unlimited';

export interface Clue {
  id: number;
  team: Team;
  word: string;
  number: ClueNumber;
  givenBy: string;
  turn: number;
  at: number;
}

export type GameRole = 'spymaster' | 'operative' | 'sharedOperative';

export interface RosterEntry {
  memberId: string;
  team: Team | null; // sharedOperative 는 팀이 없다
  role: GameRole;
}

export type EndReason =
  | 'allAgentsFound' // 한 팀의 요원이 모두 덮였다 (p.5)
  | 'assassin' // 암살자 접촉 (p.4~5)
  | 'coopEnemyComplete' // 협력 변형: 상대 요원이 모두 덮여 패배 (p.8)
  | 'aborted' // 방장이 게임을 중단했다(운영 기능, 승패 없음)
  | 'classEnded'; // 수업 종료·교사 폐쇄로 중단(운영 기능, 승패 없음)

export interface RevealInfo {
  identity: Identity;
  /** 덮개 슬롯: "red:0"~"red:7", 선공 팀의 아홉 번째는 "red:double". 그림 선택은 ThemePack 이 한다. */
  cover: string;
  by: 'guess' | 'penalty' | 'simulated';
  team: Team | null; // 누구의 차례에 공개됐는지
  order: number;
}

export interface Dispute {
  clueId: number;
  reportedBy: string;
  /** 각 팀 스파이마스터의 판정. null = 아직 응답 없음 */
  votes: Record<Team, 'invalid' | 'valid' | null>;
  at: number;
}

export interface PenaltyState {
  /** 자기 요원 1장을 덮을 수 있는 팀 (= 잘못된 힌트를 준 팀의 상대) */
  team: Team;
  clueId: number;
}

export interface SpyQuery {
  id: number;
  from: Team;
  draft: string;
  answer: 'allow' | 'disallow' | null;
  at: number;
}

export type LogEntry =
  | { seq: number; at: number; kind: 'start'; startingTeam: Team }
  | { seq: number; at: number; kind: 'clue'; team: Team; word: string; number: ClueNumber; clueId: number }
  | { seq: number; at: number; kind: 'reveal'; team: Team | null; index: number; word: string; identity: Identity; by: RevealInfo['by'] }
  | { seq: number; at: number; kind: 'turnEnd'; team: Team; reason: 'stopped' | 'wrongGuess' | 'maxGuesses' | 'invalidClue' }
  | { seq: number; at: number; kind: 'dispute'; clueId: number; outcome: 'opened' | 'upheld' | 'rejected' | 'disagreement' | 'withdrawn' }
  | { seq: number; at: number; kind: 'penaltySkipped'; team: Team }
  | { seq: number; at: number; kind: 'spymasterReplaced'; team: Team }
  | { seq: number; at: number; kind: 'finish'; winner: Team | null; reason: EndReason };

export interface SetupRecord {
  packId: string;
  editionId: string;
  contentKind: ContentKind;
  /** 선택된 실물 카드 id 와 사용 면. 서버 전용. */
  cards: { cardId: string; face: 'A' | 'B' }[];
  keySource: 'officialKey' | 'randomLayout';
  keyId: string | null;
  keyRotation: 0 | 90 | 180 | 270 | null;
  seed: string;
}

export type ContentKind = 'official' | 'unofficialOriginal' | 'custom' | 'testFixture';

export interface GameState {
  schemaVersion: 1;
  gameId: string;
  rulesetId: RulesetId;
  rulesetVersion: string;
  revision: number;
  createdAt: number;
  setup: SetupRecord;
  words: string[];
  identities: Identity[];
  revealed: (RevealInfo | null)[];
  startingTeam: Team;
  /** 협력 변형에서 사람이 맡은 팀(= 선공 팀). 다른 규칙에서는 null */
  coopTeam: Team | null;
  turnTeam: Team;
  turnNumber: number;
  phase: Phase;
  currentClue: Clue | null;
  guessesMade: number;
  clues: Clue[];
  nextClueId: number;
  dispute: Dispute | null;
  penalty: PenaltyState | null;
  spyQueries: SpyQuery[];
  nextQueryId: number;
  roster: RosterEntry[];
  /** 이번 게임에서 전체 정답(키)을 본 참가자. 같은 게임의 추측자로 전환할 수 없다. */
  sawKey: string[];
  revealCount: number;
  winner: Team | null;
  endReason: EndReason | null;
  coopScore: number | null;
  log: LogEntry[];
  nextLogSeq: number;
}

