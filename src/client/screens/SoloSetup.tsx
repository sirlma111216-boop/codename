// 혼자서 플레이: 클래스·방·다른 참가자 없이 봇과 한 판. 설정을 고르면 서버가 봇으로 자리를 채우고 바로 시작한다.

import { useState } from 'react';
import { BOT_LEVEL_HINT, BOT_LEVEL_NAME, BOT_LEVELS, BOT_SPEED_NAME, BOT_SPEEDS, SOLO_PLAYERS, type BotLevel, type SoloConfig } from '../../shared/bots.ts';
import type { Team } from '../../shared/view.ts';
import { api, ApiError } from '../api.ts';
import { TEAM_MARK, TEAM_NAME } from '../labels.ts';
import { savedNickname, saveNickname } from '../recent.ts';
import { Modal, navigate } from '../ui.tsx';

const PREF_KEY = 'codename.solo';

function loadPrefs(): SoloConfig {
  const base: SoloConfig = { rulesetId: 'cge2015-standard', myRole: 'operative', myTeam: 'red', players: 4, allyLevel: 'normal', enemyLevel: 'normal', botSpeed: 'normal' };
  try {
    const raw = localStorage.getItem(PREF_KEY);
    if (raw) return { ...base, ...(JSON.parse(raw) as Partial<SoloConfig>) };
  } catch {
    /* 저장된 설정이 없거나 읽을 수 없음 */
  }
  return base;
}

/** 이 설정으로 누가 어디에 앉는지 (서버의 createSoloRoom 과 같은 규칙) */
function lineup(c: SoloConfig): { team: Team; people: string[] }[] {
  const coop = c.rulesetId === 'cge2015-coop';
  const other: Team = c.myTeam === 'red' ? 'blue' : 'red';
  const side = (size: number, human: SoloConfig['myRole'] | null) => {
    const out: string[] = [];
    if (human === 'spymaster') out.push('나 (스파이마스터)');
    else out.push('봇 스파이마스터');
    if (human === 'operative') out.push('나 (추측자)');
    const bots = size - out.length;
    if (bots > 0) out.push(`봇 추측자 ${bots}`);
    return out;
  };
  const me = c.myRole === 'spectator' ? null : c.myRole;
  if (coop) return [{ team: c.myTeam, people: side(c.players, me) }];
  if (!me) {
    return [
      { team: 'red', people: side(Math.ceil(c.players / 2), null) },
      { team: 'blue', people: side(Math.floor(c.players / 2), null) },
    ];
  }
  return [
    { team: c.myTeam, people: side(Math.ceil(c.players / 2), me) },
    { team: other, people: side(Math.floor(c.players / 2), null) },
  ];
}

function Seg<T extends string | number>({ name, value, options, onChange, label }: { name: string; value: T; options: { v: T; text: string }[]; onChange: (v: T) => void; label: string }) {
  return (
    <fieldset className="seg">
      <legend>{label}</legend>
      <div className="seg-row">
        {options.map((o) => (
          <label key={String(o.v)} className={`seg-item ${value === o.v ? 'seg-on' : ''}`}>
            <input type="radio" name={name} checked={value === o.v} onChange={() => onChange(o.v)} />
            <span>{o.text}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

export function SoloDialog({ onClose }: { onClose: () => void }) {
  const [nick, setNick] = useState(savedNickname() || '나');
  const [cfg, setCfg] = useState<SoloConfig>(loadPrefs);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const set = (patch: Partial<SoloConfig>) =>
    setCfg((c) => {
      const next = { ...c, ...patch };
      const lim = SOLO_PLAYERS[next.rulesetId];
      next.players = Math.max(lim.min, Math.min(lim.max, next.players));
      return next;
    });
  const coop = cfg.rulesetId === 'cge2015-coop';
  const watching = cfg.myRole === 'spectator';
  const lim = SOLO_PLAYERS[cfg.rulesetId];
  const counts: number[] = [];
  for (let i = lim.min; i <= lim.max; i++) counts.push(i);
  const levelOpts = BOT_LEVELS.map((l) => ({ v: l, text: BOT_LEVEL_NAME[l] }));

  return (
    <Modal title="혼자서 플레이" onClose={onClose} wide>
      <form
        className="solo-form"
        onSubmit={(e) => {
          e.preventDefault();
          setBusy(true);
          setErr('');
          try {
            localStorage.setItem(PREF_KEY, JSON.stringify(cfg));
          } catch {
            /* 설정 기억은 편의 기능 */
          }
          api.createSolo(nick, cfg).then(
            (r) => {
              saveNickname(nick);
              navigate(`/r/${r.roomId}`);
            },
            (x: unknown) => {
              setBusy(false);
              setErr(x instanceof ApiError ? x.message : '게임을 만들지 못했습니다.');
            },
          );
        }}
      >
        <p className="muted small">초대할 사람 없이 봇과 합니다. 봇도 사람과 같은 규칙으로 서버가 판정하며, 봇 추측자는 정답을 보지 못합니다.</p>
        <div className="solo-grid">
          <label className="field">
            <span>닉네임</span>
            <input value={nick} onChange={(e) => setNick(e.target.value)} maxLength={16} required autoComplete="nickname" />
          </label>
          <Seg
            name="solo-rules"
            label="규칙"
            value={cfg.rulesetId}
            options={[
              { v: 'cge2015-standard', text: '표준 대전 (두 팀)' },
              { v: 'cge2015-coop', text: '협력 (가상 상대)' },
            ]}
            onChange={(v) => set({ rulesetId: v, players: SOLO_PLAYERS[v].default })}
          />
          <Seg
            name="solo-role"
            label="내 역할"
            value={cfg.myRole}
            options={[
              { v: 'operative', text: '추측자 (봇이 힌트)' },
              { v: 'spymaster', text: '스파이마스터 (봇이 추측)' },
              { v: 'spectator', text: '관전만 (봇끼리)' },
            ]}
            onChange={(v) => set({ myRole: v })}
          />
          {!watching && (
            <Seg
              name="solo-team"
              label="내 팀"
              value={cfg.myTeam}
              options={(['red', 'blue'] as Team[]).map((t) => ({ v: t, text: `${TEAM_MARK[t]} ${TEAM_NAME[t]}` }))}
              onChange={(v) => set({ myTeam: v })}
            />
          )}
          <label className="field">
            <span>{watching ? '봇 수' : '게임 인원 (나 포함)'}</span>
            <select value={cfg.players} onChange={(e) => set({ players: Number(e.target.value) })}>
              {counts.map((n) => (
                <option key={n} value={n}>
                  {n}명
                </option>
              ))}
            </select>
          </label>
          {coop ? (
            <Seg name="solo-ally" label="봇 실력" value={cfg.allyLevel} options={levelOpts} onChange={(v: BotLevel) => set({ allyLevel: v })} />
          ) : (
            <>
              <Seg name="solo-enemy" label={watching ? `${TEAM_NAME.blue} 팀 봇 실력` : '난이도 (상대 팀 봇 실력)'} value={cfg.enemyLevel} options={levelOpts} onChange={(v: BotLevel) => set({ enemyLevel: v })} />
              <Seg name="solo-ally" label={watching ? `${TEAM_NAME.red} 팀 봇 실력` : '우리 팀 봇 실력'} value={cfg.allyLevel} options={levelOpts} onChange={(v: BotLevel) => set({ allyLevel: v })} />
            </>
          )}
          <Seg name="solo-speed" label="봇 속도" value={cfg.botSpeed} options={BOT_SPEEDS.map((s) => ({ v: s, text: BOT_SPEED_NAME[s] }))} onChange={(v) => set({ botSpeed: v })} />
        </div>

        <div className="solo-summary" aria-label="자리 배치">
          {lineup(cfg).map((side) => (
            <p key={side.team} className={`solo-side solo-side-${side.team}`}>
              <strong>
                {TEAM_MARK[side.team]} {TEAM_NAME[side.team]}
              </strong>{' '}
              {side.people.join(' · ')}
            </p>
          ))}
          {coop && <p className="muted small">상대 팀은 가상 상대입니다. 우리 팀 차례가 끝날 때마다 스파이마스터가 상대 요원 1장을 덮습니다 (룰북 p.8).</p>}
          <ul className="muted small level-hints">
            {BOT_LEVELS.map((l) => (
              <li key={l}>
                <strong>{BOT_LEVEL_NAME[l]}</strong>: {BOT_LEVEL_HINT[l]}
              </li>
            ))}
          </ul>
        </div>

        {err && (
          <p className="error-text" role="alert">
            {err}
          </p>
        )}
        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose}>
            취소
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy || !nick.trim()}>
            {busy ? '준비하는 중…' : '시작'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
