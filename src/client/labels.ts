import type { ClueNumber, EndReason, GameView, Identity, LogEntry, MemberView, Team } from '../shared/view.ts';

export const TEAM_NAME: Record<Team, string> = { red: '빨강', blue: '파랑' };
/** 색 외 구분 수단: 팀 기호 (추가 능력을 뜻하지 않는다) */
export const TEAM_MARK: Record<Team, string> = { red: '◆', blue: '●' };

export const IDENTITY_NAME: Record<Identity, string> = {
  red: '빨강 요원',
  blue: '파랑 요원',
  bystander: '시민',
  assassin: '암살자',
};

export const IDENTITY_SHORT: Record<Identity, string> = { red: '빨강', blue: '파랑', bystander: '시민', assassin: '암살' };
export const IDENTITY_MARK: Record<Identity, string> = { red: '◆', blue: '●', bystander: '○', assassin: '✕' };

export const COLS = ['A', 'B', 'C', 'D', 'E'];
export function coord(index: number): string {
  return `${COLS[index % 5]}${Math.floor(index / 5) + 1}`;
}

export function clueNumberText(n: ClueNumber): string {
  return n === 'unlimited' ? '무제한' : String(n);
}

export function endText(g: GameView): { title: string; detail: string } {
  const w = g.winner;
  const reason: EndReason | null = g.endReason;
  if (reason === 'aborted') return { title: '게임 중단', detail: '방장이 게임을 중단했습니다. 승패는 기록하지 않습니다.' };
  if (g.coopTeam) {
    if (reason === 'allAgentsFound' && w === g.coopTeam) return { title: '임무 성공', detail: `우리 팀 요원을 모두 찾았습니다. 점수: ${g.coopScore ?? 0}점 (상대 더미에 남은 요원 수, 룰북 p.8)` };
    if (reason === 'assassin') return { title: '임무 실패', detail: '암살자와 접촉했습니다. 협력 변형에서는 점수가 없습니다.' };
    return { title: '임무 실패', detail: '상대 요원이 모두 덮였습니다. 협력 변형에서는 점수가 없습니다.' };
  }
  if (!w) return { title: '게임 종료', detail: '' };
  const loser = w === 'red' ? 'blue' : 'red';
  if (reason === 'assassin') return { title: `${TEAM_NAME[w]} 팀 승리`, detail: `${TEAM_NAME[loser]} 팀이 암살자와 접촉했습니다.` };
  return { title: `${TEAM_NAME[w]} 팀 승리`, detail: `${TEAM_NAME[w]} 팀 요원이 모두 덮였습니다.` };
}

export function logText(e: LogEntry, members: MemberView[]): string {
  void members;
  switch (e.kind) {
    case 'start':
      return `게임 시작 — ${TEAM_NAME[e.startingTeam]} 팀 선공`;
    case 'clue':
      return `${TEAM_NAME[e.team]} 힌트: “${e.word}” ${clueNumberText(e.number)}`;
    case 'reveal': {
      const who = e.by === 'penalty' ? '벌칙 공개' : e.by === 'simulated' ? '가상 상대가 덮음' : e.team ? `${TEAM_NAME[e.team]} 추측` : '추측';
      return `${who}: ${coord(e.index)} “${e.word}” → ${IDENTITY_NAME[e.identity]}`;
    }
    case 'turnEnd': {
      const why = { stopped: '추측 종료', wrongGuess: '빗나감', maxGuesses: '최대 추측 수 도달', invalidClue: '잘못된 힌트로 판정' }[e.reason];
      return `${TEAM_NAME[e.team]} 차례 끝 (${why})`;
    }
    case 'dispute': {
      const o = { opened: '힌트 이의 신고 — 판정 중', upheld: '두 스파이마스터가 잘못된 힌트로 판정', rejected: '상대 스파이마스터가 유효로 판정 — 계속', disagreement: '판정 의견 불일치 — 벌칙 없이 계속', withdrawn: '신고 철회' }[e.outcome];
      return o;
    }
    case 'penaltySkipped':
      return `${TEAM_NAME[e.team]} 스파이마스터가 벌칙 공개를 건너뜀`;
    case 'spymasterReplaced':
      return `${TEAM_NAME[e.team]} 스파이마스터 교체 (방장 승인)`;
    case 'finish':
      return e.reason === 'aborted' ? '게임 중단' : e.winner ? `게임 종료 — ${TEAM_NAME[e.winner]} 팀 ${e.reason === 'coopEnemyComplete' ? '(가상 상대) ' : ''}승리` : '게임 종료';
  }
}

export function nicknameOf(members: MemberView[], id: string): string {
  return members.find((m) => m.id === id)?.nickname ?? '떠난 참가자';
}

export const PHASE_TEXT: Record<GameView['phase'], string> = {
  awaitingClue: '힌트를 기다리는 중',
  guessing: '추측 중',
  clueDispute: '힌트 판정 중',
  penaltyResolution: '벌칙 처리 중',
  simulatedOpponentTurn: '가상 상대 차례',
  finished: '게임 종료',
};
