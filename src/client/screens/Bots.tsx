// 봇 표시와 관리 도구. 독립 방은 방장이 방 명령으로, 학급 방은 좌석을 정하는 클래스에 보낸다.

import { useState } from 'react';
import { BOT_LEVEL_NAME, BOT_LEVELS, BOT_SPEED_NAME, BOT_SPEEDS, BOT_TASK_TEXT, MAX_BOTS_PER_ROOM, type BotLevel } from '../../shared/bots.ts';
import type { MemberView, RoomView, Team } from '../../shared/view.ts';
import { TEAM_NAME } from '../labels.ts';
import type { ClassSend } from './Class.tsx';
import type { SendFn } from './Room.tsx';

export function BotBadge({ m }: { m: MemberView }) {
  if (!m.bot) return null;
  return (
    <span className="badge badge-bot" title={`봇 · 실력 ${BOT_LEVEL_NAME[m.bot.level]}`}>
      🤖 {BOT_LEVEL_NAME[m.bot.level]}
    </span>
  );
}

/** 지금 생각 중인 봇 (게임 화면 안내) */
export function botActivityText(room: RoomView): string | null {
  const a = room.botActivity;
  if (!a) return null;
  const who = room.members.find((m) => m.id === a.memberId)?.nickname ?? '봇';
  return `🤖 ${who} — ${BOT_TASK_TEXT[a.kind]}…`;
}

type SeatValue = `${Team}:spymaster` | `${Team}:operative` | 'null:operative' | 'null:spectator';

function seatOptions(room: RoomView): { v: SeatValue; text: string }[] {
  const rs = room.classMode ? 'cge2015-standard' : room.settings.rulesetId;
  const out: { v: SeatValue; text: string }[] = [];
  for (const t of ['red', 'blue'] as Team[]) {
    out.push({ v: `${t}:spymaster`, text: `${TEAM_NAME[t]} 스파이마스터` });
    if (rs !== 'cge2015-shared-operative') out.push({ v: `${t}:operative`, text: `${TEAM_NAME[t]} 추측자` });
  }
  if (rs === 'cge2015-shared-operative') out.push({ v: 'null:operative', text: '공용 추측자' });
  if (!room.classMode) out.push({ v: 'null:spectator', text: '관전' });
  return out;
}

/** 봇 한 명의 자리 바꾸기·빼기 (대기실, 방장·선생님) */
export function BotSeatControl({ m, room, send, onRemove }: { m: MemberView; room: RoomView; send: SendFn; onRemove: () => void }) {
  const cur = `${m.team ?? 'null'}:${m.role}` as SeatValue;
  return (
    <span className="bot-controls">
      <select
        value={cur}
        aria-label={`${m.nickname} 자리`}
        onChange={(e) => {
          const [team, role] = e.target.value.split(':') as [string, 'spymaster' | 'operative' | 'spectator'];
          void send({ type: 'setBotSeat', memberId: m.id, team: team === 'null' ? null : (team as Team), role });
        }}
      >
        {seatOptions(room).map((o) => (
          <option key={o.v} value={o.v}>
            {o.text}
          </option>
        ))}
      </select>
      <button type="button" className="btn btn-tiny" onClick={onRemove} aria-label={`${m.nickname} 빼기`} title="봇 빼기">
        ✕
      </button>
    </span>
  );
}

/** 대기실의 봇 패널: 봇 목록(자리·빼기) + 넣기 */
export function BotPanel({ room, send, classSend }: { room: RoomView; send: SendFn; classSend?: ClassSend }) {
  const [level, setLevel] = useState<BotLevel>('normal');
  const [count, setCount] = useState(1);
  const bots = room.members.filter((m) => m.bot);
  const cm = room.classMode;
  const people = room.members.filter((m) => !m.detached).length;
  const free = cm ? Math.max(0, cm.capacity - people) : Math.max(0, MAX_BOTS_PER_ROOM - bots.length);
  const counts: number[] = [];
  for (let i = 1; i <= Math.min(free, cm ? 8 : 1); i++) counts.push(i);
  const remove = (m: MemberView) => {
    if (cm) void classSend?.({ type: 'removeBot', roomId: room.roomId, botId: m.id }, `${m.nickname}을(를) 뺐습니다.`);
    else void send({ type: 'removeBot', memberId: m.id });
  };
  const add = () => {
    if (cm) void classSend?.({ type: 'addBots', roomId: room.roomId, count, level }, `봇 ${count}명을 넣었습니다.`);
    else void send({ type: 'addBot', level });
  };
  return (
    <section className="panel bot-panel" aria-label="봇 참가자">
      <h2>🤖 봇 참가자</h2>
      <p className="muted small">
        봇은 사람과 같은 규칙으로 움직입니다. 봇 스파이마스터만 정답을 보고, 봇 추측자는 힌트와 공개된 카드만 봅니다. 사람 추측자가 있는 팀에서는 봇이 카드를 고르지 않고
        해석만 채팅으로 남깁니다.
      </p>
      {bots.length > 0 && (
        <ul className="bot-list">
          {bots.map((m) => (
            <li key={m.id}>
              <span>
                {m.nickname} <span className="muted small">{BOT_LEVEL_NAME[m.bot!.level]}</span>
              </span>
              <BotSeatControl m={m} room={room} send={send} onRemove={() => remove(m)} />
            </li>
          ))}
        </ul>
      )}
      {free > 0 ? (
        <div className="action-row">
          <label className="field inline">
            <span>실력</span>
            <select value={level} onChange={(e) => setLevel(e.target.value as BotLevel)}>
              {BOT_LEVELS.map((l) => (
                <option key={l} value={l}>
                  {BOT_LEVEL_NAME[l]}
                </option>
              ))}
            </select>
          </label>
          {cm && (
            <label className="field inline">
              <span>몇 명</span>
              <select value={Math.min(count, free)} onChange={(e) => setCount(Number(e.target.value))}>
                {counts.map((n) => (
                  <option key={n} value={n}>
                    {n}명
                  </option>
                ))}
              </select>
            </label>
          )}
          <button type="button" className="btn btn-small" onClick={add}>
            봇 넣기
          </button>
        </div>
      ) : (
        <p className="muted small">{cm ? '정원이 찼습니다. 봇을 넣으려면 정원을 늘리거나 자리를 비우세요.' : `봇은 한 방에 ${MAX_BOTS_PER_ROOM}명까지입니다.`}</p>
      )}
      {cm && <p className="muted small">학급 방의 봇은 클래스 좌석을 씁니다(정원에 포함, 학생 수에는 포함 안 됨).</p>}
    </section>
  );
}

/** 봇 속도 설정 (방장) */
export function BotSpeedSetting({ room, send, disabled }: { room: RoomView; send: SendFn; disabled: boolean }) {
  return (
    <label className="field inline">
      <span>봇 속도</span>
      <select value={room.settings.botSpeed} disabled={disabled} onChange={(e) => void send({ type: 'setSettings', botSpeed: e.target.value as RoomView['settings']['botSpeed'] })}>
        {BOT_SPEEDS.map((s) => (
          <option key={s} value={s}>
            {BOT_SPEED_NAME[s]}
          </option>
        ))}
      </select>
    </label>
  );
}
