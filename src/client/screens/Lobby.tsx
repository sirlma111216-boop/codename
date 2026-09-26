import { useMemo, useState } from 'react';
import { RULESETS, RULESET_IDS, validateRoster } from '../../game/rulesets.ts';
import { TIMER_CHOICES } from '../../shared/constants.ts';
import type { MemberView, RoomView, Team } from '../../shared/view.ts';
import { inviteLink } from '../api.ts';
import type { RoomConnection } from '../connection.ts';
import { TEAM_MARK, TEAM_NAME } from '../labels.ts';
import { useManifest } from '../theme.ts';
import { Backdrop, copyText, Emblem, Modal, SoundToggle, TeamTag, navigate, useToast } from '../ui.tsx';
import { BotBadge, BotPanel, BotSpeedSetting } from './Bots.tsx';
import type { ClassSend } from './Class.tsx';
import { Chat } from './Chat.tsx';
import { ClassRoomLobby } from './ClassRoomLobby.tsx';
import type { SendFn } from './Room.tsx';
import { QrCode } from './Qr.tsx';
import { RulesContent } from './Rules.tsx';

export function Lobby({ room, send, conn, classSend }: { room: RoomView; send: SendFn; conn: RoomConnection; classSend: ClassSend }) {
  if (room.classMode) return <ClassRoomLobby room={room} send={send} conn={conn} classSend={classSend} />;
  return <StandaloneLobby room={room} send={send} conn={conn} />;
}

function StandaloneLobby({ room, send, conn }: { room: RoomView; send: SendFn; conn: RoomConnection }) {
  const manifest = useManifest();
  const toast = useToast();
  const [help, setHelp] = useState(false);
  const [qr, setQr] = useState(false);
  const me = room.members.find((m) => m.id === room.you.memberId);
  const isHost = room.you.isHost;
  const ruleset = room.settings.rulesetId;
  const link = inviteLink(room.roomId, room.inviteToken);

  const readiness = useMemo(
    () => validateRoster(ruleset, room.members.filter((m) => !m.detached).map((m) => ({ memberId: m.id, team: m.team, role: m.role }))),
    [room.members, ruleset],
  );
  const pack = room.packs.find((p) => p.packId === room.settings.packId);
  const canStart = readiness.ok && !!pack?.playable && room.botProblems.length === 0;
  const solo = room.solo;
  const hasBots = room.members.some((m) => m.bot);

  const seat = (team: Team | null, role: 'spymaster' | 'operative' | 'spectator') => void send({ type: 'setSeat', team, role });
  const members = (team: Team | null, role?: string) => room.members.filter((m) => m.team === team && (!role || m.role === role));

  return (
    <main className="lobby">
      <Backdrop desktop="lobby" manifest={manifest} dim={0.25} />
      <header className="topbar">
        <div className="topbar-left">
          <Emblem size={36} />
          <div>
            <h1 className="topbar-title">{solo ? '혼자서 플레이' : '작전 대기실'}</h1>
            <p className="muted small">
              {me?.nickname} · {solo ? '봇과 함께' : isHost ? '방장' : '참가자'}
              {room.locked && !solo && ' · 🔒 잠김'}
            </p>
          </div>
        </div>
        <div className="topbar-right">
          {!solo && (
            <button type="button" className="btn btn-small" onClick={() => void copyText(link).then((ok) => toast(ok ? '초대 링크를 복사했습니다.' : '복사하지 못했습니다. 링크를 길게 눌러 복사하세요.'))}>
              초대 링크 복사
            </button>
          )}
          {!solo && (
            <button type="button" className="btn btn-small" onClick={() => setQr(true)}>
              QR 크게 보기
            </button>
          )}
          <button type="button" className="icon-btn" onClick={() => setHelp(true)} aria-label="규칙 도움말" title="규칙 도움말">
            ?
          </button>
          <SoundToggle />
          <button type="button" className="icon-btn" onClick={() => navigate('/')} aria-label="처음 화면" title="처음 화면 (방에서 나가지 않습니다)">
            ⌂
          </button>
        </div>
      </header>

      <div className="lobby-grid">
        {solo ? (
          <section className="panel invite-panel" aria-label="혼자서 플레이">
            <h2>혼자서 플레이</h2>
            <p className="small">이 방은 나와 봇만 씁니다. 다른 사람은 들어올 수 없습니다. 자리·봇·규칙을 바꾼 뒤 게임 시작을 누르세요.</p>
            <p className="muted small">방은 {room.ttlHours}시간 동안 아무 활동이 없으면 자동으로 정리됩니다. 화면을 닫으면 봇도 쉽니다.</p>
          </section>
        ) : (
          <section className="panel invite-panel" aria-label="초대">
            <h2>초대</h2>
            <p className="muted small">이 링크를 받은 사람만 들어올 수 있습니다. 공개 방 목록은 없습니다. 사람이 모자라면 아래에서 봇을 넣을 수 있습니다.</p>
            <div className="invite-qr">
              <button type="button" className="qr-thumb" onClick={() => setQr(true)} aria-label="초대 QR 코드 크게 보기">
                <QrCode text={link} size={132} label="게임방 초대 QR 코드" />
              </button>
              <p className="small">휴대폰 카메라로 QR 을 찍으면 바로 들어올 수 있습니다. 닉네임만 입력하면 됩니다.</p>
            </div>
            <input className="invite-input" readOnly value={link} onFocus={(e) => e.currentTarget.select()} aria-label="초대 링크" />
            <p className="muted small">방은 {room.ttlHours}시간 동안 아무 활동이 없으면 자동으로 정리됩니다.</p>
          </section>
        )}

        <section className="teams" aria-label="팀과 역할">
          {(['red', 'blue'] as Team[]).map((t) => (
            <div key={t} className={`panel team-panel team-panel-${t}`}>
              <h2>
                <TeamTag team={t} />
              </h2>
              <SeatList title="스파이마스터" people={members(t, 'spymaster')} youId={room.you.memberId} />
              {ruleset !== 'cge2015-shared-operative' && <SeatList title="추측자" people={members(t, 'operative')} youId={room.you.memberId} />}
              <div className="seat-actions">
                <button type="button" className={`btn btn-small btn-${t}`} onClick={() => seat(t, 'spymaster')} aria-pressed={me?.team === t && me.role === 'spymaster'}>
                  {TEAM_MARK[t]} 스파이마스터 하기
                </button>
                {ruleset !== 'cge2015-shared-operative' && (
                  <button type="button" className={`btn btn-small btn-${t}`} onClick={() => seat(t, 'operative')} aria-pressed={me?.team === t && me.role === 'operative'}>
                    {TEAM_MARK[t]} 추측자 하기
                  </button>
                )}
              </div>
              {ruleset === 'cge2015-coop' && <p className="muted small">협력 변형: 한 팀에만 앉으세요. 다른 팀은 가상 상대입니다.</p>}
            </div>
          ))}
          <div className="panel team-panel team-panel-neutral">
            <h2>{ruleset === 'cge2015-shared-operative' ? '공용 추측자 · 관전' : '관전'}</h2>
            {ruleset === 'cge2015-shared-operative' && <SeatList title="공용 추측자" people={members(null, 'operative')} youId={room.you.memberId} />}
            <SeatList title="관전" people={room.members.filter((m) => m.role === 'spectator')} youId={room.you.memberId} />
            <div className="seat-actions">
              {ruleset === 'cge2015-shared-operative' && (
                <button type="button" className="btn btn-small" onClick={() => seat(null, 'operative')} aria-pressed={me?.team === null && me.role === 'operative'}>
                  공용 추측자 하기
                </button>
              )}
              <button type="button" className="btn btn-small" onClick={() => seat(null, 'spectator')} aria-pressed={me?.role === 'spectator'}>
                관전하기
              </button>
            </div>
          </div>
        </section>

        <section className="panel settings-panel" aria-label="게임 설정">
          <h2>규칙 프로필</h2>
          <fieldset className="choice-list" disabled={!isHost}>
            <legend className="sr-only">규칙 프로필</legend>
            {RULESET_IDS.map((id) => (
              <label key={id} className={`choice ${ruleset === id ? 'choice-on' : ''}`}>
                <input type="radio" name="ruleset" checked={ruleset === id} onChange={() => void send({ type: 'setSettings', rulesetId: id })} />
                <span>
                  <strong>{RULESETS[id].title}</strong> <span className="muted small">{RULESETS[id].rulebook}</span>
                  <br />
                  <span className="small">{RULESETS[id].summary}</span>
                </span>
              </label>
            ))}
          </fieldset>

          <h2>단어 팩</h2>
          <fieldset className="choice-list" disabled={!isHost}>
            <legend className="sr-only">단어 팩</legend>
            {room.packs.map((p) => (
              <label key={p.packId} className={`choice ${room.settings.packId === p.packId ? 'choice-on' : ''} ${p.playable ? '' : 'choice-off'}`}>
                <input
                  type="radio"
                  name="pack"
                  checked={room.settings.packId === p.packId}
                  // 검증되지 않은 정식판은 고를 수 없게 표시한다 (직접 입력은 단어를 넣으려면 골라야 하므로 열어 둔다)
                  disabled={p.kind === 'official' && !p.playable}
                  onChange={() => void send({ type: 'setSettings', packId: p.packId })}
                />
                <span>
                  <strong>{p.title}</strong> <span className={`badge ${p.kind === 'official' ? 'badge-warn' : ''}`}>{p.status}</span>
                  <br />
                  <span className="small">키: {p.keyLabel}</span>
                  {p.reason && (
                    <>
                      <br />
                      <span className="small warn-text">{p.reason}</span>
                    </>
                  )}
                </span>
              </label>
            ))}
          </fieldset>
          {room.settings.packId === 'custom' && <CustomWords room={room} send={send} isHost={isHost} />}

          <div className="settings-row">
            <label className="field inline">
              <span>다음 판 준비</span>
              <select value={room.settings.replayMode} disabled={!isHost} onChange={(e) => void send({ type: 'setSettings', replayMode: e.target.value as 'fresh' | 'flip' })}>
                <option value="fresh">새 카드 25장</option>
                <option value="flip">같은 25장 뒤집기 (룰북 p.5)</option>
              </select>
            </label>
            <label className="field inline">
              <span>모래시계 (운영 설정)</span>
              <select value={room.settings.timerSeconds} disabled={!isHost} onChange={(e) => void send({ type: 'setSettings', timerSeconds: Number(e.target.value) })}>
                {TIMER_CHOICES.map((s) => (
                  <option key={s} value={s}>
                    {s}초
                  </option>
                ))}
              </select>
            </label>
            {(hasBots || solo) && <BotSpeedSetting room={room} send={send} disabled={!isHost} />}
          </div>
          <p className="muted small">모래시계는 결정을 부탁하는 알림일 뿐이며, 시간이 다 돼도 자동으로 턴이 넘어가거나 지지 않습니다. 길이는 원작 규정이 아닌 운영 설정입니다.</p>
          {!isHost && <p className="muted small">설정은 방장이 바꿉니다.</p>}
        </section>

        <section className="panel ready-panel" aria-label="시작 준비">
          <h2>시작 준비</h2>
          {readiness.ok ? <p className="ok-text">역할이 모두 준비되었습니다.</p> : (
            <ul className="problems">
              {readiness.problems.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          )}
          {pack && !pack.playable && <p className="warn-text small">{pack.reason}</p>}
          {room.botProblems.map((p) => (
            <p key={p} className="warn-text small">
              {p}
            </p>
          ))}
          {pack && pack.kind !== 'official' && pack.playable && (
            <p className="muted small">이 팩은 비공식 단어이고, 정체 배치는 원본 키 카드가 아닌 무작위 배치(9/8/7/1)입니다.</p>
          )}
          {isHost ? (
            <button type="button" className="btn btn-primary btn-lg" disabled={!canStart} onClick={() => void send({ type: 'startGame' })}>
              게임 시작
            </button>
          ) : (
            <p className="muted">방장이 게임을 시작하면 자동으로 넘어갑니다.</p>
          )}
        </section>

        {isHost && <BotPanel room={room} send={send} />}
        {isHost && !solo && <HostTools room={room} send={send} conn={conn} />}

        {!solo && (
          <section className="panel chat-panel" aria-label="대기실 채팅">
            <h2>대기실 채팅</h2>
            <Chat room={room} send={send} canSend placeholder="모두에게 보내기" />
          </section>
        )}
      </div>
      {help && (
        <Modal title="규칙 도움말" onClose={() => setHelp(false)} wide>
          <RulesContent />
        </Modal>
      )}
      {qr && (
        <Modal title="게임방 초대" onClose={() => setQr(false)} wide>
          <div className="qr-box">
            <QrCode text={link} size={320} label="게임방 초대 QR 코드" />
            <p className="invite-text">{link}</p>
            <p className="muted small">휴대폰 카메라(또는 카카오톡 QR 스캔)로 찍고 닉네임만 입력하면 됩니다. 방장이 ‘초대 링크 새로 만들기’를 하면 이 QR 은 더 이상 쓸 수 없습니다.</p>
          </div>
        </Modal>
      )}
    </main>
  );
}

function SeatList({ title, people, youId }: { title: string; people: MemberView[]; youId: string }) {
  return (
    <div className="seat-list">
      <h3>{title}</h3>
      {people.length === 0 ? (
        <p className="muted small">비어 있음</p>
      ) : (
        <ul>
          {people.map((m) => (
            <li key={m.id} className={m.online ? '' : 'offline'}>
              <span className={`dot ${m.online ? 'dot-on' : 'dot-off'}`} aria-hidden="true" />
              {m.nickname}
              {m.id === youId && <span className="muted small"> (나)</span>}
              {m.isHost && <span className="badge">방장</span>}
              <BotBadge m={m} />
              <span className="sr-only">{m.online ? '접속 중' : '접속 끊김'}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function CustomWords({ room, send, isHost }: { room: RoomView; send: SendFn; isHost: boolean }) {
  const [text, setText] = useState(room.customWords.join('\n'));
  return (
    <div className="custom-words">
      <label className="field">
        <span>직접 입력한 단어 ({room.customWords.length}개 저장됨 · 25개 이상 필요 · 한 줄에 하나 또는 쉼표로 구분)</span>
        <textarea rows={5} value={text} disabled={!isHost} onChange={(e) => setText(e.target.value)} placeholder="예: 광합성, 뿌리, 줄기 …" />
      </label>
      {isHost && (
        <button type="button" className="btn btn-small" onClick={() => void send({ type: 'setCustomWords', words: text.split(/[\n,]/) }, '단어를 저장했습니다.')}>
          단어 저장
        </button>
      )}
      <p className="muted small">같은 단어는 한 번만 저장됩니다. 비공식 단어이며, 앞뒤 면이 없는 한 면 카드로 씁니다.</p>
    </div>
  );
}

function HostTools({ room, send, conn }: { room: RoomView; send: SendFn; conn: RoomConnection }) {
  const [confirmClose, setConfirmClose] = useState(false);
  void conn;
  const others = room.members.filter((m) => m.id !== room.you.memberId && !m.bot);
  return (
    <section className="panel host-panel" aria-label="방장 관리">
      <h2>방장 관리</h2>
      <div className="host-row">
        <button type="button" className="btn btn-small" onClick={() => void send({ type: 'lock', locked: !room.locked }, room.locked ? '방 잠금을 풀었습니다.' : '방을 잠갔습니다. 새 참가자가 들어올 수 없습니다.')}>
          {room.locked ? '🔓 잠금 풀기' : '🔒 방 잠그기'}
        </button>
        <button type="button" className="btn btn-small" onClick={() => void send({ type: 'rotateInvite' }, '초대 링크를 새로 만들었습니다. 이전 링크는 더 이상 쓸 수 없습니다.')}>
          초대 링크 새로 만들기
        </button>
        <button type="button" className="btn btn-small btn-danger" onClick={() => setConfirmClose(true)}>
          방 닫기
        </button>
      </div>
      {others.length > 0 && (
        <ul className="host-members">
          {others.map((m) => (
            <li key={m.id}>
              <span>
                <span className={`dot ${m.online ? 'dot-on' : 'dot-off'}`} aria-hidden="true" /> {m.nickname}
                {m.team && <span className="muted small"> · {TEAM_NAME[m.team]}</span>}
              </span>
              <span className="host-actions">
                <button type="button" className="btn btn-tiny" onClick={() => void send({ type: 'transferHost', memberId: m.id }, `${m.nickname}님에게 방장을 넘겼습니다.`)}>
                  방장 넘기기
                </button>
                <button type="button" className="btn btn-tiny btn-danger" onClick={() => void send({ type: 'kick', memberId: m.id }, `${m.nickname}님을 내보냈습니다.`)}>
                  강퇴
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}
      <ReassignTool room={room} send={send} />
      {confirmClose && (
        <Modal title="방을 닫을까요?" onClose={() => setConfirmClose(false)}>
          <p>모든 참가자의 연결이 끊기고, 방의 저장 데이터와 초대 링크가 삭제됩니다. 되돌릴 수 없습니다.</p>
          <div className="modal-actions">
            <button type="button" className="btn" onClick={() => setConfirmClose(false)} data-autofocus>
              취소
            </button>
            <button type="button" className="btn btn-danger" onClick={() => void send({ type: 'closeRoom' })}>
              방 닫기
            </button>
          </div>
        </Modal>
      )}
    </section>
  );
}

/** 쿠키를 잃은 참가자: 새로 들어온 세션을 기존 자리로 옮긴다 (방장 승인) */
export function ReassignTool({ room, send }: { room: RoomView; send: SendFn }) {
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const candidatesTo = room.members.filter((m) => m.detached || !m.online || (!!m.bot && !!room.game));
  const candidatesFrom = room.members.filter((m) => m.online && !m.detached && !m.bot && m.id !== room.you.memberId);
  if (!candidatesTo.length || !candidatesFrom.length) return null;
  return (
    <details className="reassign">
      <summary>자리 재지정 (브라우저를 바꾼 참가자)</summary>
      <p className="muted small">쿠키를 잃어 새로 들어온 참가자를 원래 자리로 옮깁니다. 이미 정답을 본 사람은 추측자 자리로 옮길 수 없습니다.</p>
      <div className="settings-row">
        <label className="field inline">
          <span>새로 들어온 사람</span>
          <select value={from} onChange={(e) => setFrom(e.target.value)}>
            <option value="">선택</option>
            {candidatesFrom.map((m) => (
              <option key={m.id} value={m.id}>
                {m.nickname}
              </option>
            ))}
          </select>
        </label>
        <label className="field inline">
          <span>원래 자리</span>
          <select value={to} onChange={(e) => setTo(e.target.value)}>
            <option value="">선택</option>
            {candidatesTo.map((m) => (
              <option key={m.id} value={m.id}>
                {m.nickname}
                {m.bot ? ' (봇 자리)' : m.detached ? ' (연결 없음)' : ' (오프라인)'}
              </option>
            ))}
          </select>
        </label>
        <button type="button" className="btn btn-small" disabled={!from || !to} onClick={() => void send({ type: 'reassignSeat', fromMemberId: from, toMemberId: to }, '자리를 옮겼습니다.')}>
          옮기기
        </button>
      </div>
    </details>
  );
}
