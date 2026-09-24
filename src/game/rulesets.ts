// Ruleset 경계: 규칙 프로필별 준비 조건·유효 행동 범위.
// 기본판 규칙 값은 CLASSIC 안에 고정한다. 사용자가 설정 화면에서 바꿀 수 없다.

import type { RosterEntry, RulesetId, Team } from './types.ts';

/** 2015 기본판 고정값 (룰북 p.2~3) */
export const CLASSIC = Object.freeze({
  rows: 5,
  cols: 5,
  startingTeamAgents: 9, // 8 요원 + 이중 요원
  secondTeamAgents: 8,
  bystanders: 7,
  assassins: 1,
  /** 힌트 숫자 입력 범위. 0 과 무제한은 특수 힌트(p.7). */
  maxClueNumber: 9,
});

export const CLASSIC_CELLS = CLASSIC.rows * CLASSIC.cols;

export interface RulesetInfo {
  id: RulesetId;
  title: string;
  summary: string;
  rulebook: string;
  /** 잘못된 힌트 신고·벌칙(p.5)을 지원하는가. 상대 스파이마스터가 있어야 한다. */
  supportsDispute: boolean;
}

export const RULESETS: Record<RulesetId, RulesetInfo> = {
  'cge2015-standard': {
    id: 'cge2015-standard',
    title: '표준 대전',
    summary: '4명 이상. 두 팀이 각각 스파이마스터 1명과 추측자 1명 이상으로 겨룹니다.',
    rulebook: '룰북 p.2~7',
    supportsDispute: true,
  },
  'cge2015-coop': {
    id: 'cge2015-coop',
    title: '소인원 협력 (가상 상대)',
    summary: '2명 이상이 한 팀이 되어 가상 상대와 겨룹니다. 스파이마스터가 상대 차례마다 상대 요원 1장을 덮습니다.',
    rulebook: '룰북 p.8 "Two-Player Game"',
    supportsDispute: false,
  },
  'cge2015-shared-operative': {
    id: 'cge2015-shared-operative',
    title: '3인 공용 추측자',
    summary: '두 스파이마스터가 겨루고, 한 명의 추측자가 양쪽 팀을 위해 추측합니다.',
    rulebook: '룰북 p.8 "Three-Player Game"',
    supportsDispute: true,
  },
};

export const RULESET_IDS = Object.keys(RULESETS) as RulesetId[];

/** 대기실 자리. 팀이 null 인 추측자는 공용 추측자(3인 변형)다. */
export interface Seat {
  memberId: string;
  team: Team | null;
  role: 'spymaster' | 'operative' | 'spectator';
}

export type RosterCheck =
  | { ok: true; roster: RosterEntry[]; coopTeam: Team | null }
  | { ok: false; problems: string[] };

const teamName = (t: Team) => (t === 'red' ? '빨강' : '파랑');

export function validateRoster(rulesetId: RulesetId, seats: Seat[]): RosterCheck {
  const players = seats.filter((s) => s.role !== 'spectator');
  const problems: string[] = [];
  const sm = (t: Team) => players.filter((s) => s.team === t && s.role === 'spymaster');
  const ops = (t: Team) => players.filter((s) => s.team === t && s.role === 'operative');
  const shared = players.filter((s) => s.team === null && s.role === 'operative');
  const teamlessSpymaster = players.filter((s) => s.team === null && s.role === 'spymaster');
  if (teamlessSpymaster.length) problems.push('스파이마스터는 팀을 골라야 합니다.');

  let coopTeam: Team | null = null;

  if (rulesetId === 'cge2015-standard') {
    for (const t of ['red', 'blue'] as Team[]) {
      if (sm(t).length !== 1) problems.push(`${teamName(t)} 팀 스파이마스터가 정확히 1명이어야 합니다 (지금 ${sm(t).length}명).`);
      if (ops(t).length < 1) problems.push(`${teamName(t)} 팀 추측자가 1명 이상 필요합니다.`);
    }
    if (shared.length) problems.push('표준 대전에서는 모든 추측자가 팀을 골라야 합니다.');
  } else if (rulesetId === 'cge2015-coop') {
    const active = (['red', 'blue'] as Team[]).filter((t) => sm(t).length + ops(t).length > 0);
    if (active.length !== 1) {
      problems.push('협력 변형은 한 팀에만 참가자가 있어야 합니다.');
    } else {
      const t = active[0] as Team;
      coopTeam = t;
      if (sm(t).length !== 1) problems.push('스파이마스터가 정확히 1명이어야 합니다.');
      if (ops(t).length < 1) problems.push('추측자가 1명 이상 필요합니다.');
    }
    if (shared.length) problems.push('협력 변형에서는 추측자도 같은 팀을 골라야 합니다.');
  } else {
    for (const t of ['red', 'blue'] as Team[]) {
      if (sm(t).length !== 1) problems.push(`${teamName(t)} 팀 스파이마스터가 정확히 1명이어야 합니다.`);
      if (ops(t).length) problems.push('3인 변형에서는 팀 추측자 대신 공용 추측자 1명을 둡니다.');
    }
    if (shared.length !== 1) problems.push(`공용 추측자가 정확히 1명이어야 합니다 (지금 ${shared.length}명).`);
  }

  if (problems.length) return { ok: false, problems: [...new Set(problems)] };
  const roster: RosterEntry[] = players.map((s) => ({
    memberId: s.memberId,
    team: s.team,
    role: s.role === 'spymaster' ? 'spymaster' : s.team === null ? 'sharedOperative' : 'operative',
  }));
  return { ok: true, roster, coopTeam };
}
