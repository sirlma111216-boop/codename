// 학급 방의 대기실: 참가자는 클래스가 정한다(초대·강퇴 없음). 여기서는 팀·역할을 고르고 ‘준비 완료’를 누른다.
// 시작 조건: 정원 충족, 전원 접속·준비, 두 팀 인원 차이 1명 이하, 팀마다 스파이마스터 1명·추측자 1명 이상.

import { useState } from 'react';
import { TIMER_CHOICES } from '../../shared/constants.ts';
import type { MemberView, RoomView, Team } from '../../shared/view.ts';
import type { RoomConnection } from '../connection.ts';
import { TEAM_MARK } from '../labels.ts';
import { useManifest } from '../theme.ts';
import { Backdrop, Emblem, Modal, navigate, SoundToggle, TeamTag } from '../ui.tsx';
import { BotBadge, BotPanel, BotSpeedSetting } from './Bots.tsx';
import type { ClassSend } from './Class.tsx';
import { Chat } from './Chat.tsx';
import type { SendFn } from './Room.tsx';
import { RulesContent } from './Rules.tsx';

export function ClassRoomLobby({ room, send, classSend }: { room: RoomView; send: SendFn; conn: RoomConnection; classSend: ClassSend }) {
  const manifest = useManifest();
  const cm = room.classMode!;
  const me = room.members.find((m) => m.id === room.you.memberId);
  const isHost = room.you.isHost;
  const teacher = cm.isTeacher;
  const [help, setHelp] = useState(false);
  const people = room.members.filter((m) => !m.detached);
  const host = room.members.find((m) => m.isHost);
  const teacherHost = teacher && isHost;
  const hasBots = room.members.some((m) => m.bot);
  const pack = room.packs.find((p) => p.packId === room.settings.packId);
  const problems = cm.startProblems;
  const canStart = problems.length === 0 && !!pack?.playable;
  const team = (t: Team) => people.filter((m) => m.team === t);
  const unseated = people.filter((m) => !m.team || m.role === 'spectator');

  return (
    <main className="lobby class-lobby">
      <Backdrop desktop="lobby" manifest={manifest} dim={0.3} />
      <header className="topbar">
        <div className="topbar-left">
          <Emblem size={36} />
          <div>
            <h1 className="topbar-title">{cm.roomName}</h1>
            <p className="muted small">
              {cm.className} · {teacher ? (teacherHost ? '선생님 (방장 역할 · 공개 관전)' : '선생님 (공개 관전)') : `${me?.nickname ?? ''}${isHost ? ' · 방장' : ''}`} · 정원 {cm.capacity}명
            </p>
          </div>
        </div>
        <div className="topbar-right">
          <button type="button" className="btn btn-small" onClick={() => navigate(`/c/${cm.classId}`)}>
            ← 클래스로
          </button>
          <button type="button" className="icon-btn" onClick={() => setHelp(true)} aria-label="규칙 도움말" title="규칙 도움말">
            ?
          </button>
          <SoundToggle />
        </div>
      </header>

      <div className="lobby-grid">
        <section className="panel span-all" aria-label="안내">
          <p className="small">
            참가자는 클래스에서 승인된 {people.length}/{cm.capacity}명입니다{hasBots ? ` (봇 ${room.members.filter((m) => m.bot).length}명 포함)` : ''}. 방장{' '}
            {host?.nickname ?? (room.hostId === 'teacher' ? '선생님' : '(없음 — 선생님이 넘겨 줄 때까지 기다리세요)')}. 방장이 자동으로 스파이마스터가 되지는 않습니다. 모두 팀과 역할을 고르고{' '}
            <strong>준비 완료</strong>를 누르면 방장이 시작할 수 있습니다. 봇은 늘 준비되어 있습니다.
          </p>
        </section>

        <section className="teams" aria-label="팀과 역할">
          {(['red', 'blue'] as Team[]).map((t) => (
            <div key={t} className={`panel team-panel team-panel-${t}`}>
              <h2>
                <TeamTag team={t} /> <span className="muted small">{team(t).length}명</span>
              </h2>
              <PeopleList people={team(t)} youId={room.you.memberId} />
              {!teacher && me && (
                <div className="seat-actions">
                  <button type="button" className={`btn btn-small btn-${t}`} aria-pressed={me.team === t && me.role === 'spymaster'} onClick={() => void send({ type: 'setSeat', team: t, role: 'spymaster' })}>
                    {TEAM_MARK[t]} 스파이마스터
                  </button>
                  <button type="button" className={`btn btn-small btn-${t}`} aria-pressed={me.team === t && me.role === 'operative'} onClick={() => void send({ type: 'setSeat', team: t, role: 'operative' })}>
                    {TEAM_MARK[t]} 추측자
                  </button>
                </div>
              )}
            </div>
          ))}
          <div className="panel team-panel team-panel-neutral">
            <h2>아직 고르지 않음</h2>
            <PeopleList people={unseated} youId={room.you.memberId} />
            {!teacher && me && (
              <div className="seat-actions">
                <button
                  type="button"
                  className={`btn btn-lg ${me.ready ? 'btn-on' : 'btn-primary'}`}
                  aria-pressed={me.ready}
                  disabled={!me.team || me.role === 'spectator'}
                  onClick={() => void send({ type: 'setReady', ready: !me.ready })}
                >
                  {me.ready ? '✓ 준비 완료 (누르면 취소)' : '준비 완료'}
                </button>
              </div>
            )}
          </div>
        </section>

        <section className="panel ready-panel" aria-label="시작 준비">
          <h2>시작 준비</h2>
          {problems.length === 0 ? (
            <p className="ok-text">모두 준비되었습니다.</p>
          ) : (
            <ul className="problems">
              {problems.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          )}
          {pack && !pack.playable && <p className="warn-text small">{pack.reason}</p>}
          {isHost ? (
            <div className="action-row">
              <button type="button" className="btn" onClick={() => void send({ type: 'autoBalance' }, '두 팀으로 고르게 나눴습니다. 각자 확인하고 준비 완료를 눌러 주세요.')}>
                팀 고르게 나누기
              </button>
              <button type="button" className="btn btn-primary btn-lg" disabled={!canStart} onClick={() => void send({ type: 'startGame' })}>
                게임 시작
              </button>
            </div>
          ) : (
            <p className="muted">방장이 시작하면 자동으로 넘어갑니다.</p>
          )}
          <p className="muted small">시작하는 순간 명단이 잠겨, 게임 중에는 새 학생이 들어오지 않습니다.</p>
        </section>

        <section className="panel settings-panel" aria-label="게임 설정">
          <h2>게임 설정</h2>
          <p className="small">표준 대전 (룰북 p.2~7) — 학급 모드는 표준 대전으로 진행합니다.</p>
          <fieldset className="choice-list" disabled={!isHost}>
            <legend className="small muted">단어 팩</legend>
            {room.packs
              .filter((p) => p.kind !== 'custom')
              .map((p) => (
                <label key={p.packId} className={`choice ${room.settings.packId === p.packId ? 'choice-on' : ''} ${p.playable ? '' : 'choice-off'}`}>
                  <input type="radio" name="pack" checked={room.settings.packId === p.packId} disabled={!p.playable} onChange={() => void send({ type: 'setSettings', packId: p.packId })} />
                  <span>
                    <strong>{p.title}</strong> <span className={`badge ${p.kind === 'official' ? 'badge-warn' : ''}`}>{p.status}</span>
                    <br />
                    <span className="small">키: {p.keyLabel}</span>
                  </span>
                </label>
              ))}
          </fieldset>
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
            {hasBots && <BotSpeedSetting room={room} send={send} disabled={!isHost} />}
          </div>
        </section>

        {isHost && <BotPanel room={room} send={send} classSend={classSend} />}

        <section className="panel chat-panel" aria-label="방 채팅">
          <h2>방 채팅</h2>
          <Chat room={room} send={send} canSend={!teacher} placeholder="이 방 사람들에게" disabledText="관전 중인 선생님은 채팅을 보내지 않습니다." />
        </section>
      </div>
      {help && (
        <Modal title="규칙 도움말" onClose={() => setHelp(false)} wide>
          <RulesContent />
        </Modal>
      )}
    </main>
  );
}

function PeopleList({ people, youId }: { people: MemberView[]; youId: string }) {
  if (!people.length) return <p className="muted small">비어 있음</p>;
  return (
    <ul className="seat-list-plain">
      {people.map((m) => (
        <li key={m.id} className={m.online ? '' : 'offline'}>
          <span className={`dot ${m.online ? 'dot-on' : 'dot-off'}`} aria-hidden="true" />
          {m.nickname}
          {m.id === youId && <span className="muted small"> (나)</span>}
          {m.isHost && <span className="badge">방장</span>}
          <BotBadge m={m} />
          {m.role === 'spymaster' && m.team && <span className="badge">스파이마스터</span>}
          <span className={`ready-mark ${m.ready ? 'is-ready' : ''}`}>{m.ready ? '✓ 준비' : '대기'}</span>
          <span className="sr-only">{m.online ? '접속 중' : '접속 끊김'}</span>
        </li>
      ))}
    </ul>
  );
}
