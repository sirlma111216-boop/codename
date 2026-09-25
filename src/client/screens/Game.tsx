import { useEffect, useMemo, useRef, useState } from 'react';
import { RULESETS } from '../../game/rulesets.ts';
import type { Command } from '../../shared/protocol.ts';
import type { CardView, ClueNumber, GameView, RoomView, Team } from '../../shared/view.ts';
import type { RoomConnection } from '../connection.ts';
import { clueNumberText, coord, endText, logText, nicknameOf, PHASE_TEXT, TEAM_MARK, TEAM_NAME } from '../labels.ts';
import { play } from '../sound.ts';
import { imageUrl, preloadCovers, useManifest } from '../theme.ts';
import { Backdrop, Emblem, Modal, SoundToggle, TeamTag, navigate, useAnnounce, useToast } from '../ui.tsx';
import { Board } from './Board.tsx';
import { BotBadge, botActivityText } from './Bots.tsx';
import { Chat } from './Chat.tsx';
import { ReassignTool } from './Lobby.tsx';
import type { SendFn } from './Room.tsx';
import { RulesContent } from './Rules.tsx';

const other = (t: Team): Team => (t === 'red' ? 'blue' : 'red');

export function GameScreen({ room, conn, send }: { room: RoomView; conn: RoomConnection; send: SendFn }) {
  const game = room.game as GameView;
  const manifest = useManifest();
  const announce = useAnnounce();
  const [selected, setSelected] = useState<number | null>(null);
  const [confirm, setConfirm] = useState<number | null>(null);
  const [tab, setTab] = useState<'log' | 'chat' | 'people'>('log');
  const [help, setHelp] = useState(false);
  const [zoom, setZoom] = useState(false);
  const [showKey, setShowKey] = useState(true);
  const [briefing, setBriefing] = useState(false);

  const me = game.me;
  const myTeam = me.team;
  const isSpymaster = me.role === 'spymaster';
  const isGuesser = me.role === 'sharedOperative' || me.role === 'operative';
  const myTurnAsGuesser = game.phase === 'guessing' && (me.role === 'sharedOperative' || (me.role === 'operative' && myTeam === game.turnTeam));
  const myTurnAsSpymaster = game.phase === 'awaitingClue' && isSpymaster && myTeam === game.turnTeam;
  const penaltyMine = game.phase === 'penaltyResolution' && isSpymaster && game.penalty?.team === myTeam;
  const simulateMine = game.phase === 'simulatedOpponentTurn' && isSpymaster && game.coopTeam === myTeam;
  const inRoster = game.roster.some((r) => r.memberId === room.you.memberId);
  const info = RULESETS[game.rulesetId];
  // 참가자가 모두 봇인 게임을 ‘정답 보기’로 관전 중 (서버가 key 를 보낼 때만)
  const watchingKey = !isSpymaster && !inRoster && game.me.canSeeKey && game.phase !== 'finished';

  // ---- 새 게임: 덮개 그림 전부 미리 받기 + 짧은 브리핑 (한 번)
  useEffect(() => {
    preloadCovers(manifest);
  }, [manifest, game.gameId]);
  useEffect(() => {
    const k = `codename.briefed.${game.gameId}`;
    let seenBrief = false;
    try {
      seenBrief = sessionStorage.getItem(k) === '1';
      sessionStorage.setItem(k, '1');
    } catch {
      /* 무시 */
    }
    if (!seenBrief && game.phase !== 'finished' && game.clues.length === 0) setBriefing(true);
  }, [game.gameId, game.phase, game.clues.length]);

  // ---- 서버가 확정한 변화만 소리·낭독으로 알린다
  const lastSeq = useRef<{ gameId: string; seq: number } | null>(null);
  useEffect(() => {
    const top = game.log.at(-1)?.seq ?? 0;
    if (!lastSeq.current || lastSeq.current.gameId !== game.gameId) {
      lastSeq.current = { gameId: game.gameId, seq: top };
      return;
    }
    const fresh = game.log.filter((e) => e.seq > (lastSeq.current?.seq ?? 0));
    lastSeq.current.seq = top;
    for (const e of fresh) {
      if (e.kind === 'reveal') play(e.identity === 'assassin' ? 'revealAssassin' : e.team && e.identity === e.team ? 'revealAgent' : 'revealWrong');
      if (e.kind === 'clue') play('clue');
      if (e.kind === 'turnEnd') play('turn');
      if (e.kind === 'finish') {
        const good = game.coopTeam ? e.winner === game.coopTeam && e.reason === 'allAgentsFound' : myTeam ? e.winner === myTeam : true;
        play(good ? 'win' : 'lose');
      }
    }
    if (fresh.length) announce(fresh.map((e) => logText(e, room.members)).join('. '));
  }, [game.log, game.gameId, game.coopTeam, myTeam, announce, room.members]);

  // 차례가 바뀌거나 카드가 공개되면 로컬 선택을 지운다
  useEffect(() => {
    setSelected(null);
    setConfirm(null);
  }, [game.revision]);

  const selectable = (c: CardView): boolean => {
    if (myTurnAsGuesser) return true;
    if (penaltyMine) return c.key === myTeam;
    if (simulateMine) return !!game.coopTeam && c.key === other(game.coopTeam);
    return false;
  };

  const act: ActFn = (action, okText) => send({ type: 'game', action }, okText);

  const onActivate = (index: number) => {
    if (myTurnAsGuesser) setConfirm(index);
    else if (penaltyMine) setConfirm(index);
    else if (simulateMine) setConfirm(index);
  };

  const confirmCard = confirm !== null ? game.cards[confirm] : null;
  const turnLabel = game.phase === 'simulatedOpponentTurn' ? '가상 상대 차례' : `${TEAM_NAME[game.turnTeam]} 팀 차례`;

  const roleText =
    me.role === 'spymaster' && myTeam
      ? `${TEAM_NAME[myTeam]} 팀 스파이마스터`
      : me.role === 'operative' && myTeam
        ? `${TEAM_NAME[myTeam]} 팀 추측자`
        : me.role === 'sharedOperative'
          ? '공용 추측자 (양 팀)'
          : room.classMode?.isTeacher
            ? '선생님 (공개 관전)'
            : room.solo
              ? '관전 (봇끼리 게임)'
              : '관전자';

  const finished = game.phase === 'finished';

  return (
    <main className={`game team-turn-${game.turnTeam} ${finished ? 'game-finished' : ''}`}>
      <Backdrop desktop="board-desktop" mobile="board-mobile" manifest={manifest} />
      <header className="topbar game-topbar">
        <div className="topbar-left">
          <Emblem size={32} />
          <div>
            <p className="topbar-title">
              {myTeam ? <TeamTag team={myTeam} /> : null} {me.role === 'spymaster' ? '스파이마스터' : me.role === 'operative' ? '추측자' : roleText}
            </p>
            <p className="muted small">
              {room.classMode ? `${room.classMode.className} · ${room.classMode.roomName} · ` : ''}
              {info.title} · {game.content.packTitle}
              {game.content.keySource === 'randomLayout' && ' · 무작위 배치'}
            </p>
          </div>
        </div>
        <div className="scoreboard" aria-label="남은 요원">
          {(['red', 'blue'] as Team[]).map((t) => (
            <div key={t} className={`score score-${t} ${game.turnTeam === t && !finished ? 'score-active' : ''}`}>
              <span className="score-mark" aria-hidden="true">
                {TEAM_MARK[t]}
              </span>
              <span className="score-num">{game.remaining[t]}</span>
              <span className="score-label">
                {TEAM_NAME[t]} 남은 요원{game.coopTeam && game.coopTeam !== t ? ' (가상 상대)' : ''}
              </span>
            </div>
          ))}
        </div>
        <div className="topbar-right">
          {room.classMode && (
            <button type="button" className="btn btn-small" onClick={() => navigate(`/c/${room.classMode!.classId}`)}>
              ← 클래스로
            </button>
          )}
          <TimerButton room={room} conn={conn} send={send} canUse={inRoster && !finished} />
          <button type="button" className="icon-btn" onClick={() => setZoom(true)} aria-label="확대 보기" title="확대 보기">
            🔍
          </button>
          <button type="button" className="icon-btn" onClick={() => setHelp(true)} aria-label="규칙 도움말" title="규칙 도움말">
            ?
          </button>
          <SoundToggle />
        </div>
      </header>

      <section className={`cluebar cluebar-${game.currentClue?.team ?? game.turnTeam}`} aria-live="polite">
        {finished ? (
          <strong>{endText(game).title}</strong>
        ) : game.currentClue ? (
          <>
            <span className="clue-team">
              <TeamTag team={game.currentClue.team} suffix="힌트" />
            </span>
            <span className="clue-word">{game.currentClue.word}</span>
            <span className="clue-num">{clueNumberText(game.currentClue.number)}</span>
            <span className="clue-guesses">
              추측 {game.guessesMade}
              {game.guessLimit !== null ? ` / 최대 ${game.guessLimit}` : ' (상한 없음)'}
            </span>
          </>
        ) : (
          <span>
            <strong>{turnLabel}</strong> · {PHASE_TEXT[game.phase]}
            {game.phase === 'awaitingClue' && (room.botActivity?.kind === 'clue' ? ` — ${botActivityText(room)}` : ` — ${TEAM_NAME[game.turnTeam]} 스파이마스터가 힌트를 생각하는 중`)}
          </span>
        )}
      </section>

      <div className="game-main">
        <div className="board-area">
          <Board
            game={game}
            manifest={manifest}
            showKey={(isSpymaster || watchingKey) && showKey}
            selectable={selectable}
            selected={selected}
            onSelect={(i) => setSelected(i)}
            onActivate={onActivate}
          />
          <ActionArea
            game={game}
            room={room}
            send={send}
            act={act}
            selected={selected}
            setConfirm={setConfirm}
            myTurnAsGuesser={myTurnAsGuesser}
            myTurnAsSpymaster={myTurnAsSpymaster}
            penaltyMine={penaltyMine}
            simulateMine={simulateMine}
            isSpymaster={isSpymaster}
            isGuesser={isGuesser}
            showKey={showKey}
            setShowKey={setShowKey}
            watchingKey={watchingKey}
          />
        </div>

        <aside className="side">
          <div className="tabs" role="tablist" aria-label="게임 정보">
            {(
              [
                ['log', '기록'],
                ['chat', '토론'],
                ['people', '참가자'],
              ] as const
            ).map(([id, label]) => (
              <button key={id} type="button" role="tab" aria-selected={tab === id} className={`tab ${tab === id ? 'tab-on' : ''}`} onClick={() => setTab(id)}>
                {label}
                {id === 'chat' && room.chat.length > 0 && tab !== 'chat' && <span className="tab-dot" aria-hidden="true" />}
              </button>
            ))}
          </div>
          <div className="tab-panel" role="tabpanel">
            {tab === 'log' && <GameLog game={game} room={room} />}
            {tab === 'chat' && (
              <>
                <p className="muted small">
                  추측자 토론 채널 — 양 팀 모두에게 공개됩니다(탁상 대화와 같음). 게임 중 스파이마스터와 관전자는 보낼 수 없습니다.
                  {room.members.some((m) => m.bot) && ' 봇 추측자가 힌트를 어떻게 읽었는지도 여기에 남깁니다.'}
                </p>
                <Chat
                  room={room}
                  send={send}
                  canSend={finished || isGuesser}
                  placeholder="추측자 토론 (양 팀 공개)"
                  disabledText={isSpymaster ? '스파이마스터는 게임 중 자유 채팅을 쓸 수 없습니다. 공식 힌트와 판정 기능만 씁니다.' : '관전자는 게임 중 읽기만 할 수 있습니다.'}
                />
              </>
            )}
            {tab === 'people' && <People room={room} game={game} send={send} act={act} />}
          </div>
        </aside>
      </div>

      {finished && <FinishPanel game={game} room={room} send={send} />}

      {confirm !== null && confirmCard && (
        <Modal title={myTurnAsGuesser ? '이 카드로 확정할까요?' : penaltyMine ? '이 카드를 벌칙으로 덮을까요?' : '가상 상대의 요원으로 덮을까요?'} onClose={() => setConfirm(null)}>
          <p className="confirm-word">
            <span className="muted">{coord(confirmCard.index)}</span> {confirmCard.word}
          </p>
          {myTurnAsGuesser && <p className="muted small">확정하면 서버가 정체를 공개합니다. 되돌릴 수 없습니다.</p>}
          <div className="modal-actions">
            <button type="button" className="btn" onClick={() => setConfirm(null)}>
              취소
            </button>
            <button
              type="button"
              className="btn btn-primary"
              data-autofocus
              onClick={() => {
                const index = confirmCard.index;
                setConfirm(null);
                if (myTurnAsGuesser) void act({ type: 'guess', index });
                else if (penaltyMine) void act({ type: 'penaltyCover', index });
                else if (simulateMine) void act({ type: 'simulatedCover', index });
              }}
            >
              확정
            </button>
          </div>
        </Modal>
      )}

      {zoom && (
        <Modal title="확대 보기" onClose={() => setZoom(false)} wide>
          <Board
            game={game}
            manifest={manifest}
            showKey={(isSpymaster || watchingKey) && showKey}
            selectable={selectable}
            selected={selected}
            onSelect={(i) => setSelected(i)}
            onActivate={(i) => {
              setZoom(false);
              onActivate(i);
            }}
            large
          />
          <p className="muted small">카드를 한 번 누르면 선택, 한 번 더 누르면 확정 창이 열립니다.</p>
        </Modal>
      )}

      {help && (
        <Modal title="규칙 도움말" onClose={() => setHelp(false)} wide>
          <RulesContent />
        </Modal>
      )}

      {briefing && <Briefing game={game} roleText={roleText} onClose={() => setBriefing(false)} />}
      {conn.status !== 'open' && <div className="sr-only">연결이 끊겨 있습니다</div>}
    </main>
  );
}

type ActFn = (action: Extract<Command, { type: 'game' }>['action'], okText?: string) => Promise<boolean>;

function ActionArea(p: {
  game: GameView;
  room: RoomView;
  send: SendFn;
  act: ActFn;
  selected: number | null;
  setConfirm: (i: number | null) => void;
  myTurnAsGuesser: boolean;
  myTurnAsSpymaster: boolean;
  penaltyMine: boolean;
  simulateMine: boolean;
  isSpymaster: boolean;
  isGuesser: boolean;
  showKey: boolean;
  setShowKey: (v: boolean) => void;
  watchingKey: boolean;
}) {
  const { game, act, room } = p;
  const botText = botActivityText(room);
  const allBots = game.roster.length > 0 && game.roster.every((r) => room.members.find((m) => m.id === r.memberId)?.bot);
  const info = RULESETS[game.rulesetId];
  const inRoster = game.roster.some((r) => r.memberId === room.you.memberId);
  const sel = p.selected !== null ? game.cards[p.selected] : null;

  if (game.phase === 'finished') return null;

  return (
    <div className="actions">
      {game.phase === 'clueDispute' && <DisputePanel game={game} room={room} act={act} />}

      {game.phase === 'penaltyResolution' && game.penalty && (
        <div className="action-box">
          {p.penaltyMine ? (
            <>
              <p>
                <strong>잘못된 힌트 벌칙</strong> — 다음 힌트 전에 우리 팀 요원 카드 1장을 골라 덮을 수 있습니다(선택, 룰북 p.5).
              </p>
              <div className="action-row">
                <button type="button" className="btn btn-primary" disabled={!sel} onClick={() => sel && p.setConfirm(sel.index)}>
                  {sel ? `${coord(sel.index)} “${sel.word}” 덮기` : '카드를 고르세요'}
                </button>
                <button type="button" className="btn" onClick={() => void act({ type: 'penaltyCover', index: null })}>
                  건너뛰기
                </button>
              </div>
            </>
          ) : (
            <p>
              <TeamTag team={game.penalty.team} /> 스파이마스터가 벌칙으로 자기 팀 요원 1장을 덮을지 정하는 중입니다.
            </p>
          )}
        </div>
      )}

      {game.phase === 'simulatedOpponentTurn' && (
        <div className="action-box">
          {p.simulateMine ? (
            <>
              <p>
                <strong>가상 상대의 차례</strong> — 상대 팀 요원 카드 1장을 골라 덮으세요 (룰북 p.8). 어느 카드를 덮을지는 스파이마스터가 정합니다.
              </p>
              <button type="button" className="btn btn-primary" disabled={!sel} onClick={() => sel && p.setConfirm(sel.index)}>
                {sel ? `${coord(sel.index)} “${sel.word}” 덮기` : '상대 요원 카드를 고르세요'}
              </button>
            </>
          ) : (
            <p>가상 상대의 차례입니다. 스파이마스터가 상대 요원 1장을 덮는 중입니다.</p>
          )}
        </div>
      )}

      {p.myTurnAsSpymaster && <ClueForm game={game} act={act} />}

      {game.phase === 'awaitingClue' && !p.myTurnAsSpymaster && (
        <div className="action-box subtle">
          <p>
            <TeamTag team={game.turnTeam} /> 스파이마스터가 힌트를 생각하는 중입니다.
          </p>
          {botText && <p className="bot-activity">{botText}</p>}
        </div>
      )}

      {game.phase === 'guessing' && (
        <div className="action-box">
          {p.myTurnAsGuesser ? (
            <>
              <p>
                카드를 한 번 눌러 선택하고, <strong>확정</strong>하면 공개됩니다. 팀원과 토론한 뒤 누구든 먼저 확정한 카드가 반영됩니다.
              </p>
              <div className="action-row">
                <button type="button" className="btn btn-primary" disabled={!sel} onClick={() => sel && p.setConfirm(sel.index)}>
                  {sel ? `${coord(sel.index)} “${sel.word}” 확정…` : '카드를 고르세요'}
                </button>
                <button type="button" className="btn" disabled={game.guessesMade < 1} onClick={() => void act({ type: 'endTurn' })} title={game.guessesMade < 1 ? '최소 한 번은 추측해야 합니다' : ''}>
                  추측 끝내기
                </button>
              </div>
              {game.guessesMade < 1 && <p className="muted small">최소 한 번은 추측해야 턴을 끝낼 수 있습니다.</p>}
            </>
          ) : (
            <p>
              <TeamTag team={game.turnTeam} /> 추측자가 고르는 중입니다.
            </p>
          )}
          {botText && <p className="bot-activity">{botText}</p>}
          {info.supportsDispute && inRoster && (
            <button type="button" className="btn btn-ghost btn-small" onClick={() => void act({ type: 'reportInvalidClue' }, '신고했습니다. 두 스파이마스터가 판정하는 동안 카드 공개가 멈춥니다.')}>
              이 힌트에 이의 신고
            </button>
          )}
        </div>
      )}

      {allBots && !inRoster && (
        <div className="spy-tools watch-tools">
          {room.you.isHost ? (
            <label className="toggle">
              <input type="checkbox" checked={room.watchKey} onChange={(e) => void p.send({ type: 'setWatchKey', on: e.target.checked })} /> 정답 보며 관전 (참가자가 모두 봇인 게임만) — 봇
              스파이마스터가 노린 단어도 기록에 보입니다
            </label>
          ) : (
            room.watchKey && <p className="muted small">방장이 ‘정답 보며 관전’을 켰습니다.</p>
          )}
          {p.watchingKey && (
            <label className="toggle">
              <input type="checkbox" checked={p.showKey} onChange={(e) => p.setShowKey(e.target.checked)} /> 판에 키 표시
            </label>
          )}
        </div>
      )}

      {p.isSpymaster && (
        <div className="spy-tools">
          <label className="toggle">
            <input type="checkbox" checked={p.showKey} onChange={(e) => p.setShowKey(e.target.checked)} /> 판에 키 표시 (주변 사람이 화면을 볼 때는 끄세요)
          </label>
          {info.supportsDispute && <SpyQueries game={game} act={act} />}
        </div>
      )}
    </div>
  );
}

function ClueForm({ game, act }: { game: GameView; act: ActFn }) {
  const [word, setWord] = useState('');
  const [num, setNum] = useState<ClueNumber>(1);
  const [ask, setAsk] = useState(false);
  const trimmed = word.trim();
  const visible = game.cards.filter((c) => !c.revealed).map((c) => c.word);
  const norm = (s: string) => s.normalize('NFC').trim().toLocaleLowerCase('ko');
  const exact = visible.find((w) => norm(w) === norm(trimmed));
  const overlaps = trimmed.length >= 1 ? visible.filter((w) => norm(w) !== norm(trimmed) && (norm(w).includes(norm(trimmed)) || norm(trimmed).includes(norm(w)))) : [];
  const hasSpace = /\s/.test(trimmed);

  return (
    <form
      className="action-box clue-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (!trimmed || exact) return;
        setAsk(true);
      }}
    >
      <p>
        <strong>힌트를 주세요</strong> — 단어 하나와 숫자 하나. 제출 뒤에는 고칠 수 없습니다.
      </p>
      <div className="action-row">
        <label className="field inline grow">
          <span>힌트 단어</span>
          <input value={word} onChange={(e) => setWord(e.target.value)} maxLength={30} autoComplete="off" required />
        </label>
        <label className="field inline">
          <span>숫자</span>
          <select value={String(num)} onChange={(e) => setNum(e.target.value === 'unlimited' ? 'unlimited' : Number(e.target.value))}>
            {[1, 2, 3, 4, 5, 6, 7, 8, 9, 0].map((n) => (
              <option key={n} value={n}>
                {n}
                {n === 0 ? ' (관련 단어 없음)' : ''}
              </option>
            ))}
            <option value="unlimited">무제한</option>
          </select>
        </label>
        <button type="submit" className="btn btn-primary" disabled={!trimmed || !!exact}>
          제출…
        </button>
      </div>
      {exact && <p className="error-text small">판에 보이는 단어 “{exact}”는 힌트로 쓸 수 없습니다 (룰북 p.4).</p>}
      {!exact && overlaps.length > 0 && (
        <p className="warn-text small">
          판의 “{overlaps.slice(0, 3).join('”, “')}”와 글자가 겹칩니다. 같은 단어의 다른 형태나 합성어의 일부라면 쓸 수 없습니다(p.6). 확실하지 않으면 상대 스파이마스터에게 조용히 물어보세요.
        </p>
      )}
      {hasSpace && <p className="muted small">띄어쓰기가 있습니다. 고유명사·합성어를 한 단어로 칠지는 모임에서 미리 정한 대로 하세요 (p.7).</p>}
      {ask && (
        <Modal title="힌트를 제출할까요?" onClose={() => setAsk(false)}>
          <p className="confirm-word">
            {trimmed} <span className="muted">· {clueNumberText(num)}</span>
          </p>
          <p className="muted small">제출하면 모두에게 공개되고, 고칠 수 없습니다.</p>
          <div className="modal-actions">
            <button type="button" className="btn" onClick={() => setAsk(false)}>
              취소
            </button>
            <button
              type="button"
              className="btn btn-primary"
              data-autofocus
              onClick={() => {
                setAsk(false);
                void act({ type: 'giveClue', word: trimmed, number: num }).then((ok) => ok && setWord(''));
              }}
            >
              제출
            </button>
          </div>
        </Modal>
      )}
    </form>
  );
}

function SpyQueries({ game, act }: { game: GameView; act: ActFn }) {
  const [draft, setDraft] = useState('');
  const myTeam = game.me.team;
  const qs = game.spyQueries ?? [];
  return (
    <details className="spy-queries">
      <summary>
        상대 스파이마스터에게 조용히 묻기 {qs.some((q) => q.from !== myTeam && !q.answer) && <span className="badge badge-warn">답할 문의 있음</span>}
      </summary>
      <p className="muted small">두 스파이마스터에게만 보입니다. 추측자에게는 보내지지 않습니다. 상대가 허용하면 유효한 힌트로 봅니다 (룰북 p.6).</p>
      <form
        className="action-row"
        onSubmit={(e) => {
          e.preventDefault();
          if (!draft.trim()) return;
          void act({ type: 'spyQuery', draft: draft.trim() }).then((ok) => ok && setDraft(''));
        }}
      >
        <input value={draft} onChange={(e) => setDraft(e.target.value)} maxLength={30} placeholder="이 힌트 괜찮을까요?" aria-label="문의할 힌트 초안" />
        <button type="submit" className="btn btn-small">
          묻기
        </button>
      </form>
      <ul className="query-list">
        {qs
          .slice()
          .reverse()
          .map((q) => (
            <li key={q.id}>
              <span>
                <TeamTag team={q.from} suffix="" /> “{q.draft}” —{' '}
                {q.answer === 'allow' ? <span className="ok-text">허용</span> : q.answer === 'disallow' ? <span className="error-text">안 됨</span> : <span className="muted">답 기다리는 중</span>}
              </span>
              {q.from !== myTeam && !q.answer && (
                <span className="host-actions">
                  <button type="button" className="btn btn-tiny" onClick={() => void act({ type: 'spyQueryAnswer', queryId: q.id, answer: 'allow' })}>
                    허용
                  </button>
                  <button type="button" className="btn btn-tiny" onClick={() => void act({ type: 'spyQueryAnswer', queryId: q.id, answer: 'disallow' })}>
                    안 됨
                  </button>
                </span>
              )}
            </li>
          ))}
      </ul>
    </details>
  );
}

function DisputePanel({ game, room, act }: { game: GameView; room: RoomView; act: ActFn }) {
  const d = game.dispute;
  if (!d) return null;
  const clue = game.clues.find((c) => c.id === d.clueId);
  const me = game.me;
  const isSm = me.role === 'spymaster' && me.team;
  const vote = (t: Team) => (d.votes[t] === 'invalid' ? '잘못됨' : d.votes[t] === 'valid' ? '유효' : '판정 전');
  return (
    <div className="action-box dispute">
      <p>
        <strong>힌트 이의 신고 판정 중</strong> — {nicknameOf(room.members, d.reportedBy)}님이 “{clue?.word}”에 이의를 제기했습니다. 판정이 끝날 때까지 카드 공개가 멈춥니다.
      </p>
      <p className="small">
        두 스파이마스터가 모두 ‘잘못됨’이면 턴이 끝나고 상대 스파이마스터가 자기 요원 1장을 덮을 수 있습니다. 상대 스파이마스터가 ‘유효’라고 하면 그대로 계속합니다. 의견이 갈리면 앱은 벌칙을 적용하지 않습니다.
      </p>
      <p className="small">
        <TeamTag team="red" suffix="스파이마스터" />: {vote('red')} · <TeamTag team="blue" suffix="스파이마스터" />: {vote('blue')}
      </p>
      <div className="action-row">
        {isSm && (
          <>
            <button type="button" className="btn btn-danger" onClick={() => void act({ type: 'voteDispute', verdict: 'invalid' })}>
              잘못된 힌트다
            </button>
            <button type="button" className="btn" onClick={() => void act({ type: 'voteDispute', verdict: 'valid' })}>
              유효한 힌트다
            </button>
          </>
        )}
        {d.reportedBy === room.you.memberId && (
          <button type="button" className="btn btn-ghost" onClick={() => void act({ type: 'withdrawDispute' })}>
            신고 철회
          </button>
        )}
      </div>
    </div>
  );
}

function GameLog({ game, room }: { game: GameView; room: RoomView }) {
  const ref = useRef<HTMLOListElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [game.log.length]);
  return (
    <div className="log">
      <h3 className="sr-only">진행 기록</h3>
      <ol ref={ref} className="log-list">
        {game.log.map((e) => (
          <li key={e.seq} className={`log-${e.kind} ${'team' in e && e.team ? `log-team-${e.team}` : ''}`}>
            {logText(e, room.members)}
          </li>
        ))}
      </ol>
      {game.clues.length > 0 && (
        <details open={room.botIntents.length > 0}>
          <summary>지난 힌트 {game.clues.length}개</summary>
          <ul className="clue-history">
            {game.clues.map((c) => {
              const intent = room.botIntents.find((x) => x.clueId === c.id);
              return (
                <li key={c.id}>
                  <TeamTag team={c.team} suffix="" /> {c.word} · {clueNumberText(c.number)}
                  {intent && <span className="bot-intent"> — 🤖 노린 단어: {intent.words.join(', ') || '(없음)'}</span>}
                </li>
              );
            })}
          </ul>
          {room.botIntents.length > 0 && <p className="muted small">봇 스파이마스터가 이 힌트로 가리키려 한 단어입니다. 게임이 끝났거나, 모두 봇인 게임을 정답 보기로 관전할 때만 보입니다.</p>}
        </details>
      )}
    </div>
  );
}

function People({ room, game, send, act }: { room: RoomView; game: GameView; send: SendFn; act: ActFn }) {
  const isHost = room.you.isHost;
  const [confirmAbort, setConfirmAbort] = useState(false);
  const roleOf = (id: string) => game.roster.find((r) => r.memberId === id);
  const candidates = (t: Team) => game.roster.filter((r) => r.role === 'operative' && r.team === t && !game.sawKey.includes(r.memberId));
  const [rep, setRep] = useState<{ team: Team; id: string } | null>(null);
  return (
    <div className="people">
      <ul className="people-list">
        {room.members.map((m) => {
          const r = roleOf(m.id);
          return (
            <li key={m.id} className={m.online ? '' : 'offline'}>
              <span className={`dot ${m.online ? 'dot-on' : 'dot-off'}`} aria-hidden="true" />
              <span>{m.nickname}</span>
              <BotBadge m={m} />
              <span className="muted small">
                {r ? (r.role === 'spymaster' ? `${TEAM_NAME[r.team as Team]} 스파이마스터` : r.role === 'sharedOperative' ? '공용 추측자' : `${TEAM_NAME[r.team as Team]} 추측자`) : '관전'}
                {m.isHost && ' · 방장'}
                {m.detached && ' · 연결 없음'}
                {!m.online && !m.detached && ' · 오프라인'}
              </span>
              {isHost && !room.classMode && !room.solo && !m.bot && m.id !== room.you.memberId && (
                <button type="button" className="btn btn-tiny btn-danger" onClick={() => void send({ type: 'kick', memberId: m.id }, `${m.nickname}님을 내보냈습니다.`)}>
                  강퇴
                </button>
              )}
            </li>
          );
        })}
      </ul>
      {room.hostOfflineSince && <p className="muted small">방장 연결이 끊겼습니다. {room.hostGraceSeconds}초가 지나면 관리 권한만 다른 참가자에게 넘어갑니다(게임 역할은 그대로).</p>}
      {isHost && game.phase !== 'finished' && (
        <div className="host-game-tools">
          <h3>방장 관리</h3>
          <details>
            <summary>스파이마스터 교체 승인</summary>
            <p className="muted small">정답을 아직 보지 않은 같은 팀 추측자만 승격할 수 있습니다. 전임 스파이마스터는 관전자로 남고, 같은 게임에서 추측자가 될 수 없습니다.</p>
            {(['red', 'blue'] as Team[]).map((t) => (
              <div key={t} className="action-row">
                <TeamTag team={t} />
                <select value={rep?.team === t ? rep.id : ''} onChange={(e) => setRep({ team: t, id: e.target.value })} aria-label={`${TEAM_NAME[t]} 팀 새 스파이마스터`}>
                  <option value="">추측자 선택</option>
                  {candidates(t).map((c) => (
                    <option key={c.memberId} value={c.memberId}>
                      {nicknameOf(room.members, c.memberId)}
                    </option>
                  ))}
                </select>
                <button type="button" className="btn btn-tiny" disabled={rep?.team !== t || !rep.id} onClick={() => rep && void act({ type: 'replaceSpymaster', team: t, newMemberId: rep.id }, '스파이마스터를 교체했습니다.')}>
                  승인
                </button>
              </div>
            ))}
          </details>
          {!room.classMode && !room.solo && <ReassignTool room={room} send={send} />}
          {room.classMode && <p className="muted small">학급 방의 참가자 관리(강퇴·자리 재지정)는 선생님이 클래스 화면에서 합니다.</p>}
          <button type="button" className="btn btn-small btn-danger" onClick={() => setConfirmAbort(true)}>
            게임 중단
          </button>
          {confirmAbort && (
            <Modal title="게임을 중단할까요?" onClose={() => setConfirmAbort(false)}>
              <p>승패 없이 게임을 끝내고 전체 정체를 공개합니다.</p>
              <div className="modal-actions">
                <button type="button" className="btn" onClick={() => setConfirmAbort(false)} data-autofocus>
                  취소
                </button>
                <button
                  type="button"
                  className="btn btn-danger"
                  onClick={() => {
                    setConfirmAbort(false);
                    void act({ type: 'abort' });
                  }}
                >
                  중단
                </button>
              </div>
            </Modal>
          )}
        </div>
      )}
      <button type="button" className="btn btn-ghost btn-small" onClick={() => navigate('/')}>
        처음 화면으로 (방에 남아 있음)
      </button>
    </div>
  );
}

function FinishPanel({ game, room, send }: { game: GameView; room: RoomView; send: SendFn }) {
  const m = useManifest();
  const { title, detail } = endText(game);
  const bgName = game.endReason === 'assassin' || game.endReason === 'coopEnemyComplete' || game.endReason === 'aborted' ? 'mission-ended' : game.winner === 'red' ? 'victory-red' : 'victory-blue';
  const bg = imageUrl(m, bgName);
  const [open, setOpen] = useState(true);
  const tone = game.winner ?? 'none';
  if (!open)
    return (
      <div className="finish-mini">
        <button type="button" className="btn btn-primary" onClick={() => setOpen(true)}>
          결과 보기
        </button>
      </div>
    );
  return (
    <section className={`finish finish-${tone}`} aria-label="게임 결과">
      {bg && <img className="finish-bg" src={bg} alt="" aria-hidden="true" decoding="async" />}
      <div className="finish-body">
        <h2 className="finish-title">{title}</h2>
        <p>{detail}</p>
        <p className="muted small">판에 모든 정체가 공개되었습니다. 기록 탭에서 진행 과정을 볼 수 있습니다.</p>
        <div className="action-row center">
          {room.you.isHost && !room.classMode ? (
            <>
              <button type="button" className="btn btn-primary btn-lg" onClick={() => void send({ type: 'rematch' })}>
                {room.solo ? '다시 하기 (새 카드 25장)' : '같은 구성으로 다시 하기'}
              </button>
              <button type="button" className="btn" onClick={() => void send({ type: 'backToLobby' })}>
                {room.solo ? '설정 바꾸기' : '대기실로'}
              </button>
              {room.solo && (
                <button type="button" className="btn" onClick={() => navigate('/')}>
                  처음 화면으로
                </button>
              )}
            </>
          ) : room.you.isHost ? (
            <button type="button" className="btn btn-primary btn-lg" onClick={() => void send({ type: 'backToLobby' })}>
              대기실로 (같은 구성으로 재경기 준비)
            </button>
          ) : (
            <p>방장이 대기실로 돌아가면 다음 게임을 준비할 수 있습니다{room.classMode ? ' (역할은 다시 고를 수 있습니다)' : ''}.</p>
          )}
          {room.classMode && (
            <button type="button" className="btn" onClick={() => navigate(`/c/${room.classMode!.classId}`)}>
              클래스로 돌아가기
            </button>
          )}
          <button type="button" className="btn" onClick={() => setOpen(false)}>
            판 보기
          </button>
        </div>
      </div>
    </section>
  );
}

function Briefing({ game, roleText, onClose }: { game: GameView; roleText: string; onClose: () => void }) {
  useEffect(() => {
    const t = window.setTimeout(onClose, 6000);
    return () => window.clearTimeout(t);
  }, [onClose]);
  const second = other(game.startingTeam);
  return (
    <Modal title="작전 브리핑" onClose={onClose}>
      <div className={`briefing briefing-${game.startingTeam}`}>
        <p>
          <TeamTag team={game.startingTeam} /> 선공 — 요원 9명 (이중 요원 포함)
        </p>
        <p>
          <TeamTag team={second} /> — 요원 8명
        </p>
        <p className="muted small">시민 7명 · 암살자 1명{game.coopTeam ? ' · 소인원 협력 변형 (가상 상대)' : ''}</p>
        <p className="briefing-role">당신은: {roleText}</p>
        {game.content.kind !== 'official' && <p className="muted small">비공식 단어 · 무작위 배치 (원본 키 카드 아님)</p>}
        <button type="button" className="btn btn-primary" onClick={onClose} data-autofocus>
          시작
        </button>
      </div>
    </Modal>
  );
}

function TimerButton({ room, conn, send, canUse }: { room: RoomView; conn: RoomConnection; send: SendFn; canUse: boolean }) {
  const [, tick] = useState(0);
  const timer = room.timer;
  const toast = useToast();
  const rang = useRef<number | null>(null);
  useEffect(() => {
    if (!timer) return;
    const id = window.setInterval(() => tick((x) => x + 1), 500);
    return () => window.clearInterval(id);
  }, [timer]);
  const left = timer ? Math.max(0, Math.ceil((timer.endsAt - conn.serverNow()) / 1000)) : 0;
  useEffect(() => {
    if (timer && left === 0 && rang.current !== timer.endsAt) {
      rang.current = timer.endsAt;
      play('timer');
      toast('모래시계가 다 됐습니다 — 결정을 부탁해요. (자동으로 넘어가지 않습니다)');
    }
  }, [timer, left, toast]);
  const label = useMemo(() => (timer ? (left > 0 ? `⏳ ${left}초` : '⌛ 끝') : `⏳ ${room.settings.timerSeconds}초`), [timer, left, room.settings.timerSeconds]);
  return (
    <button
      type="button"
      className={`btn btn-small timer ${timer && left === 0 ? 'timer-done' : ''}`}
      disabled={!canUse}
      onClick={() => void send(timer ? { type: 'timerCancel' } : { type: 'timerStart' })}
      title={timer ? '모래시계 멈추기' : `모래시계 뒤집기 (${room.settings.timerSeconds}초, 운영 설정)`}
      aria-label={timer ? `모래시계 ${left}초 남음. 누르면 멈춤` : `모래시계 뒤집기, ${room.settings.timerSeconds}초`}
    >
      {label}
    </button>
  );
}

