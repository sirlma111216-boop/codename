// 학급 모드: 교사 대시보드와 학생 클래스 화면.
// 교사 클래스 생성 → 학생 입장 → 교사가 방장 지정 → 방장이 게임방 생성 → 학생 참가 신청 →
// 방장 승인 → 방 안에서 팀·역할·준비 → 각 방 독립 진행 → 결과 → 클래스 복귀.
// 클래스 화면에는 방의 공개 요약만 있다. 단어판·정답·힌트·방 안 토론은 각 게임방 화면에서만 보인다.

import qrcode from 'qrcode-generator';
import { useCallback, useEffect, useMemo, useReducer, useState } from 'react';
import type { ClassCommand } from '../../shared/class-protocol.ts';
import type { ClassMemberView, ClassNoticeKind, ClassRoomView, ClassView } from '../../shared/classroom.ts';
import { ANNOUNCE_MAX } from '../../shared/constants.ts';
import { BOT_LEVEL_NAME, BOT_LEVELS, type BotLevel } from '../../shared/bots.ts';
import { api, ApiError, classInviteLink } from '../api.ts';
import { ClassConnection, type EndReason } from '../connection.ts';
import { TEAM_NAME } from '../labels.ts';
import { useManifest } from '../theme.ts';
import { Backdrop, ConnectionOverlay, copyText, Emblem, Modal, navigate, SoundToggle, useToast } from '../ui.tsx';

type Status = 'checking' | 'teacher' | 'member' | 'notMember' | 'gone' | 'banned' | 'ended' | 'noSession' | 'network';
export type ClassSend = (cmd: ClassCommand, okText?: string) => Promise<boolean>;

export const RECOVERY_KEY = (classId: string) => `codename.recovery.${classId}`;

const STATUS_TEXT: Record<ClassRoomView['status'], string> = { waiting: '대기 중', playing: '게임 중', finished: '게임 끝', closed: '닫힘' };

function noticeText(kind: ClassNoticeKind, roomName: string): string {
  const r = `‘${roomName}’`;
  switch (kind) {
    case 'rejected':
      return `${r} 방장이 신청을 거절했습니다. 다른 방을 골라 보세요.`;
    case 'roomFull':
      return `${r} 방이 가득 찼습니다. 다른 방을 골라 보세요.`;
    case 'removed':
      return `${r} 방에서 나오게 되었습니다. 다른 방을 골라 보세요.`;
    case 'roomClosed':
      return `${r} 방이 닫혔습니다. 다른 방을 골라 보세요.`;
    case 'moved':
      return `선생님이 ${r} 방으로 옮겼습니다.`;
    case 'roomStarted':
      return `${r} 방은 게임을 시작했습니다. 다음 게임을 기다리거나 다른 방을 고르세요.`;
    case 'hostRevoked':
      return '방장 지정이 해제되었습니다.';
    case 'hostAssigned':
      return roomName ? `${r} 방의 관리권을 받았습니다.` : '선생님이 방장으로 지정했습니다. ‘게임방 만들기’를 할 수 있습니다.';
  }
}

const END_TEXT: Partial<Record<EndReason, string>> = {
  kicked: '선생님이 이 클래스에서 내보냈습니다.',
  classEnded: '수업이 끝났습니다. 수고했어요!',
  gone: '클래스가 없거나 정리되었습니다.',
  replaced: '이 자리는 선생님 승인으로 다른 브라우저에 넘어갔습니다.',
  protocol: '앱이 새 버전으로 바뀌었습니다. 새로고침해 주세요.',
  noSession: '브라우저 쿠키(세션)가 없어졌습니다. 선생님께 받은 링크로 다시 들어온 뒤 자리 재지정을 부탁하세요.',
  notMember: '이 브라우저는 이 클래스의 참가자가 아닙니다.',
  banned: '이 클래스에서 내보내졌습니다.',
};

export function ClassPage({ classId }: { classId: string }) {
  const [status, setStatus] = useState<Status>('checking');
  const check = useCallback(() => {
    api.classStatus(classId).then(
      (s) => setStatus(s.status),
      (e: unknown) => setStatus(e instanceof ApiError && e.code === 'noSession' ? 'noSession' : 'network'),
    );
  }, [classId]);
  useEffect(check, [check]);

  if (status === 'checking') return <div className="center-page">클래스를 확인하는 중…</div>;
  if (status === 'teacher' || status === 'member') return <ConnectedClass classId={classId} />;
  if (status === 'notMember') return <NotMember classId={classId} onRecovered={check} />;
  const text =
    status === 'ended'
      ? '수업이 끝났습니다.'
      : status === 'banned'
        ? '이 클래스에서 내보내졌습니다.'
        : status === 'network'
          ? '서버에 연결하지 못했습니다.'
          : status === 'noSession'
            ? END_TEXT.noSession
            : '클래스가 없거나 정리되었습니다.';
  return (
    <div className="center-page">
      <div className="panel narrow">
        <p>{text}</p>
        <button type="button" className="btn" onClick={() => navigate('/')}>
          처음 화면으로
        </button>
      </div>
    </div>
  );
}

/** 초대 없이 온 경우: 학생은 초대 링크로, 선생님은 복구 키로 */
function NotMember({ classId, onRecovered }: { classId: string; onRecovered: () => void }) {
  const [key, setKey] = useState('');
  const [err, setErr] = useState('');
  return (
    <div className="center-page">
      <div className="panel narrow">
        <Emblem />
        <p>이 브라우저는 이 클래스에 들어와 있지 않습니다. 학생은 선생님이 보여 준 초대 링크(QR)로 들어오세요.</p>
        <details>
          <summary>선생님이신가요? (다른 기기·브라우저에서 이어서 관리)</summary>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              api.recoverTeacher(classId, key).then(onRecovered, (x: unknown) => setErr(x instanceof ApiError ? x.message : '복구하지 못했습니다.'));
            }}
          >
            <label className="field">
              <span>교사 복구 키 (클래스를 만들 때 한 번 보여 준 키)</span>
              <input value={key} onChange={(e) => setKey(e.target.value)} autoComplete="off" />
            </label>
            {err && <p className="error-text">{err}</p>}
            <button type="submit" className="btn btn-small" disabled={!key.trim()}>
              선생님으로 이어서 하기
            </button>
          </form>
        </details>
        <button type="button" className="btn" onClick={() => navigate('/')}>
          처음 화면으로
        </button>
      </div>
    </div>
  );
}

export function useClassConnection(classId: string | null) {
  const [conn, setConn] = useState<ClassConnection | null>(null);
  const [, force] = useReducer((x: number) => x + 1, 0);
  useEffect(() => {
    if (!classId) {
      setConn(null);
      return;
    }
    const c = new ClassConnection(classId);
    setConn(c);
    const un = c.subscribe(force);
    return () => {
      un();
      c.dispose();
    };
  }, [classId]);
  return conn;
}

function ConnectedClass({ classId }: { classId: string }) {
  const conn = useClassConnection(classId);
  const toast = useToast();
  const send: ClassSend = useCallback(
    async (cmd, okText) => {
      if (!conn) return false;
      const ack = await conn.send(cmd);
      if (!ack.ok) {
        toast(ack.message ?? '처리하지 못했습니다.', 'error');
        return false;
      }
      if (okText) toast(okText);
      return true;
    },
    [conn, toast],
  );
  useEffect(() => {
    if (conn?.lastError) {
      toast(conn.lastError, 'error');
      conn.lastError = null;
    }
  });

  if (!conn) return <div className="center-page">연결하는 중…</div>;
  if (conn.status === 'ended') {
    return (
      <div className="center-page">
        <div className="panel narrow">
          <p>{END_TEXT[conn.endReason ?? 'gone'] ?? '연결이 끝났습니다.'}</p>
          <button type="button" className="btn" onClick={() => (conn.endReason === 'protocol' ? location.reload() : navigate('/'))}>
            {conn.endReason === 'protocol' ? '새로고침' : '처음 화면으로'}
          </button>
        </div>
      </div>
    );
  }
  const view = conn.view;
  if (!view) return <ConnectionOverlay conn={conn} fullPage />;
  return (
    <>
      {view.you.role === 'teacher' ? <TeacherDashboard view={view} send={send} /> : <StudentClass view={view} send={send} />}
      <ConnectionOverlay conn={conn} />
    </>
  );
}

// ================================================================== 교사

function QrCode({ text, size = 240 }: { text: string; size?: number }) {
  const path = useMemo(() => {
    const qr = qrcode(0, 'M');
    qr.addData(text);
    qr.make();
    const n = qr.getModuleCount();
    let d = '';
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (qr.isDark(y, x)) d += `M${x + 4},${y + 4}h1v1h-1z`;
    return { d, n };
  }, [text]);
  return (
    <svg className="qr" width={size} height={size} viewBox={`0 0 ${path.n + 8} ${path.n + 8}`} role="img" aria-label="수업 초대 QR 코드" shapeRendering="crispEdges">
      <rect width="100%" height="100%" fill="#fff" />
      <path d={path.d} fill="#000" />
    </svg>
  );
}

function TeacherDashboard({ view, send }: { view: ClassView; send: ClassSend }) {
  const manifest = useManifest();
  const toast = useToast();
  const link = classInviteLink(view.classId, view.inviteToken ?? '');
  const [qr, setQr] = useState(false);
  const [confirmEnd, setConfirmEnd] = useState(false);
  const [recovery, setRecovery] = useState<string | null>(() => {
    try {
      return sessionStorage.getItem(RECOVERY_KEY(view.classId));
    } catch {
      return null;
    }
  });
  const [text, setText] = useState('');
  const members = view.members ?? [];
  const suggestions = useMemo(() => suggestLayouts(view.counts.total, view.settings.roomCapMin, view.settings.roomCapMax), [view.counts.total, view.settings.roomCapMin, view.settings.roomCapMax]);
  const roomName = (id: string | null) => (id ? (view.rooms.find((r) => r.id === id)?.name ?? '닫힌 방') : '');
  const waitingRooms = view.rooms.filter((r) => r.status === 'waiting');
  const ended = view.ended;

  return (
    <main className="classroom teacher">
      <Backdrop desktop="lobby" manifest={manifest} dim={0.35} />
      <header className="topbar">
        <div className="topbar-left">
          <Emblem size={36} />
          <div>
            <h1 className="topbar-title">{view.name}</h1>
            <p className="muted small">선생님 화면 · 학급 모드{ended ? ' · 수업 종료됨' : ''}</p>
          </div>
        </div>
        {!ended && (
          <div className="topbar-right">
            <button type="button" className="btn btn-small" onClick={() => void copyText(link).then((ok) => toast(ok ? '수업 초대 링크를 복사했습니다.' : '복사하지 못했습니다.'))}>
              초대 링크 복사
            </button>
            <button type="button" className="btn btn-small" onClick={() => setQr(true)}>
              QR 크게 보기
            </button>
            <button type="button" className="btn btn-small" aria-pressed={view.locked} onClick={() => void send({ type: 'lockJoin', locked: !view.locked }, view.locked ? '새 입장을 다시 받습니다.' : '새 입장을 잠갔습니다.')}>
              {view.locked ? '🔒 입장 잠김' : '🔓 입장 열림'}
            </button>
            <SoundToggle />
            <button type="button" className="btn btn-small btn-danger" onClick={() => setConfirmEnd(true)}>
              수업 종료
            </button>
          </div>
        )}
      </header>

      <div className="class-grid">
        {ended && (
          <section className="panel span-all">
            <h2>수업이 끝났습니다</h2>
            <p className="muted small">모든 방이 닫혔고, 진행 중이던 게임은 ‘수업 종료로 중단’(승패 없음)으로 기록되었습니다. 기록은 {view.ttlHours}시간 뒤 자동으로 지워집니다.</p>
          </section>
        )}
        {recovery && (
          <section className="panel span-all recovery" aria-label="교사 복구 키">
            <h2>교사 복구 키 — 지금 적어 두세요</h2>
            <p>
              <code className="recovery-key">{recovery}</code>
            </p>
            <p className="muted small">다른 기기나 브라우저에서 이 수업을 이어서 관리할 때만 씁니다. 이 화면을 벗어나면 다시 보여 주지 않으며, 서버에는 해시만 저장됩니다. 학생 초대 링크와는 다릅니다.</p>
            <button
              type="button"
              className="btn btn-small"
              onClick={() => {
                try {
                  sessionStorage.removeItem(RECOVERY_KEY(view.classId));
                } catch {
                  /* 무시 */
                }
                setRecovery(null);
              }}
            >
              적어 두었습니다
            </button>
          </section>
        )}

        <section className="panel stats span-all" aria-label="현황">
          <div className="stat">
            <span className="stat-num">
              {view.counts.total}
              <small>/{view.settings.capacity}</small>
            </span>
            <span className="stat-label">입장한 학생</span>
          </div>
          <div className="stat">
            <span className="stat-num">{view.counts.online}</span>
            <span className="stat-label">접속 중</span>
          </div>
          <div className={`stat ${view.counts.unassigned ? 'stat-warn' : ''}`}>
            <span className="stat-num">{view.counts.unassigned}</span>
            <span className="stat-label">미배정</span>
          </div>
          <div className="stat">
            <span className="stat-num">
              {view.counts.rooms}
              <small>/{view.settings.maxRooms}</small>
            </span>
            <span className="stat-label">게임방</span>
          </div>
          <div className="stat-wide">
            {!ended && (
              <>
                <p className="small">
                  <strong>배치 예시</strong> (운영 예시이며 원작 규정이 아닙니다): {suggestions.join(' · ') || '학생이 들어오면 보여 줍니다'}
                </p>
                <p className="muted small">한 방은 두 팀입니다. 방장도 좌석 하나를 씁니다. 원작 인원 표기는 4–8+ 이며, 방 정원 4~8명은 이 앱의 운영 설정입니다.</p>
              </>
            )}
          </div>
        </section>

        {!ended && (view.helpRequests?.length ?? 0) > 0 && (
          <section className="panel help-panel span-all" aria-label="도움 요청" role="status">
            <h2>🙋 도움 요청</h2>
            <ul className="plain-list">
              {view.helpRequests!.map((h) => (
                <li key={h.memberId}>
                  <strong>{h.nickname}</strong> {h.roomName ? `· ${h.roomName}` : '· 미배정'} · {new Date(h.at).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })}
                  <button type="button" className="btn btn-tiny" onClick={() => void send({ type: 'dismissHelp', memberId: h.memberId })}>
                    확인
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}

        <section className="panel rooms-panel" aria-label="게임방">
          <h2>게임방</h2>
          {!ended && <SimRoomForm view={view} send={send} />}
          {view.rooms.length === 0 ? (
            <p className="muted">아직 방이 없습니다. 아래 학생 목록에서 ‘방장 지정’을 하면, 그 학생이 게임방을 만들 수 있습니다.</p>
          ) : (
            <div className="room-cards">
              {view.rooms.map((r) => (
                <TeacherRoomCard key={r.id} room={r} send={send} ended={ended} />
              ))}
            </div>
          )}
        </section>

        <section className="panel side-panel" aria-label="공지와 설정">
          {!ended && (
            <>
              <h2>공지</h2>
              <form
                className="chat-form"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (!text.trim()) return;
                  void send({ type: 'announce', text }, '공지를 보냈습니다.').then((ok) => ok && setText(''));
                }}
              >
                <input value={text} onChange={(e) => setText(e.target.value)} maxLength={ANNOUNCE_MAX} placeholder="모두에게 보낼 운영 공지" aria-label="공지 내용" />
                <button type="submit" className="btn btn-small">
                  보내기
                </button>
              </form>
              <p className="muted small">게임 중인 학생에게도 보입니다. 운영 안내용이며 힌트를 보내는 데 쓰지 않습니다.</p>
            </>
          )}
          <ul className="plain-list announce-list">
            {view.announcements
              .slice()
              .reverse()
              .map((a) => (
                <li key={a.id}>
                  <span className="muted small">{new Date(a.at).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })}</span> {a.text}
                </li>
              ))}
          </ul>
          {!ended && <ClassSettings view={view} send={send} />}
        </section>

        <section className="panel students-panel span-all" aria-label="학생 목록">
          <h2>
            학생 {members.length}명 <span className="muted small">· 미배정 {view.counts.unassigned}명</span>
          </h2>
          {members.length === 0 ? (
            <p className="muted">학생이 초대 링크로 들어오면 여기에 보입니다.</p>
          ) : (
            <div className="table-wrap">
              <table className="students">
                <thead>
                  <tr>
                    <th scope="col">학생</th>
                    <th scope="col">상태</th>
                    <th scope="col">방장</th>
                    <th scope="col">이동 (대기 중)</th>
                    <th scope="col">관리</th>
                  </tr>
                </thead>
                <tbody>
                  {members.map((m) => (
                    <StudentRow key={m.id} m={m} view={view} send={send} roomName={roomName} waitingRooms={waitingRooms} ended={ended} />
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {!ended && <ReassignMember members={members} send={send} />}
        </section>
      </div>

      {qr && (
        <Modal title="수업 초대" onClose={() => setQr(false)} wide>
          <div className="qr-box">
            <QrCode text={link} size={320} />
            <p className="qr-name">{view.name}</p>
            <p className="invite-text">{link}</p>
            <p className="muted small">학생은 휴대폰 카메라로 QR 을 찍거나 링크를 열고 닉네임만 입력하면 됩니다.</p>
          </div>
        </Modal>
      )}
      {confirmEnd && (
        <Modal title="수업을 끝낼까요?" onClose={() => setConfirmEnd(false)}>
          <p>모든 게임방이 닫히고 학생 연결이 끊깁니다. 진행 중인 게임은 ‘수업 종료로 중단’으로 기록되며 승패를 매기지 않습니다. 초대 링크도 더 이상 쓸 수 없습니다.</p>
          <div className="modal-actions">
            <button type="button" className="btn" onClick={() => setConfirmEnd(false)} data-autofocus>
              취소
            </button>
            <button
              type="button"
              className="btn btn-danger"
              onClick={() => {
                setConfirmEnd(false);
                void send({ type: 'endClass' }, '수업을 끝냈습니다.');
              }}
            >
              수업 종료
            </button>
          </div>
        </Modal>
      )}
    </main>
  );
}

/** 선생님: 봇으로 채운 시뮬레이션 방 (시범·리허설용). 선생님이 방장 역할을 하고 공개 관전으로 진행한다. */
function SimRoomForm({ view, send }: { view: ClassView; send: ClassSend }) {
  const s = view.settings;
  const [name, setName] = useState('시뮬레이션');
  const [cap, setCap] = useState(Math.max(s.roomCapMin, 4));
  const [level, setLevel] = useState<BotLevel>('normal');
  const [fill, setFill] = useState(true);
  const caps: number[] = [];
  for (let n = s.roomCapMin; n <= s.roomCapMax; n++) caps.push(n);
  return (
    <details className="sim-room">
      <summary>🤖 시뮬레이션 방 만들기 (봇으로 채운 시범 게임)</summary>
      <p className="muted small">
        학생 없이 봇만으로 게임을 돌려 보거나(시범·리허설), 빈자리를 봇으로 채운 방을 만듭니다. 학생 방장이 없는 방은 선생님이 방장 역할(시작·중단)을 합니다. 참가자가 모두 봇이면
        ‘정답 보며 관전’으로 봇의 의도를 함께 볼 수 있습니다. 봇은 학생 수에 들어가지 않습니다.
      </p>
      <form
        className="settings-row"
        onSubmit={(e) => {
          e.preventDefault();
          void send({ type: 'createRoom', name, capacity: cap, ...(fill ? { bots: { count: cap, level } } : {}) }, '시뮬레이션 방을 만들었습니다. 방 카드의 ‘들어가서 진행’을 누르세요.');
        }}
      >
        <label className="field inline grow">
          <span>방 이름</span>
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={20} required />
        </label>
        <label className="field inline">
          <span>정원</span>
          <select value={cap} onChange={(e) => setCap(Number(e.target.value))}>
            {caps.map((n) => (
              <option key={n} value={n}>
                {n}명
              </option>
            ))}
          </select>
        </label>
        <label className="field inline">
          <span>봇 실력</span>
          <select value={level} onChange={(e) => setLevel(e.target.value as BotLevel)}>
            {BOT_LEVELS.map((l) => (
              <option key={l} value={l}>
                {BOT_LEVEL_NAME[l]}
              </option>
            ))}
          </select>
        </label>
        <label className="toggle">
          <input type="checkbox" checked={fill} onChange={(e) => setFill(e.target.checked)} /> 모든 자리를 봇으로
        </label>
        <button type="submit" className="btn btn-small btn-primary" disabled={view.rooms.length >= view.settings.maxRooms}>
          만들기
        </button>
      </form>
    </details>
  );
}

/** 대기 중인 방에 봇 넣기 (그 방의 방장·선생님) */
function ClassBotAdder({ room, send }: { room: ClassRoomView; send: ClassSend }) {
  const free = room.capacity - room.seatCount;
  const [count, setCount] = useState(1);
  const [level, setLevel] = useState<BotLevel>('normal');
  if (room.status !== 'waiting' || free <= 0) return null;
  const counts: number[] = [];
  for (let n = 1; n <= free; n++) counts.push(n);
  return (
    <span className="host-actions bot-adder">
      <select value={Math.min(count, free)} onChange={(e) => setCount(Number(e.target.value))} aria-label={`${room.name} 봇 수`}>
        {counts.map((n) => (
          <option key={n} value={n}>
            봇 {n}명
          </option>
        ))}
      </select>
      <select value={level} onChange={(e) => setLevel(e.target.value as BotLevel)} aria-label={`${room.name} 봇 실력`}>
        {BOT_LEVELS.map((l) => (
          <option key={l} value={l}>
            {BOT_LEVEL_NAME[l]}
          </option>
        ))}
      </select>
      <button type="button" className="btn btn-tiny" onClick={() => void send({ type: 'addBots', roomId: room.id, count: Math.min(count, free), level }, `봇 ${Math.min(count, free)}명을 넣었습니다.`)}>
        🤖 넣기
      </button>
    </span>
  );
}

/** 좌석 칩: 봇이면 표시하고, 대기 중이면 뺄 수 있다 */
function SeatChip({ room, s, send, canManage }: { room: ClassRoomView; s: NonNullable<ClassRoomView['seats']>[number]; send: ClassSend; canManage: boolean }) {
  return (
    <li className={s.online ? '' : 'offline'}>
      <span className={`dot ${s.online ? 'dot-on' : 'dot-off'}`} aria-hidden="true" />
      {s.bot && <span aria-hidden="true">🤖 </span>}
      {s.nickname}
      {s.memberId === room.hostMemberId ? ' (방장)' : ''}
      {s.bot && canManage && room.status === 'waiting' && (
        <button type="button" className="btn btn-tiny" aria-label={`${s.nickname} 빼기`} title="봇 빼기" onClick={() => void send({ type: 'removeBot', roomId: room.id, botId: s.memberId })}>
          ✕
        </button>
      )}
    </li>
  );
}

function suggestLayouts(students: number, min: number, max: number): string[] {
  const out: string[] = [];
  for (let size = max; size >= min; size--) {
    const rooms = Math.ceil(students / size);
    if (rooms < 1) continue;
    const base = Math.floor(students / rooms);
    const extra = students % rooms;
    if (base < min) continue;
    const desc = extra === 0 ? `${base}명 × ${rooms}방` : `${base + 1}명 ${extra}방 + ${base}명 ${rooms - extra}방`;
    if (!out.includes(desc)) out.push(desc);
  }
  return out.slice(0, 3);
}

function summaryText(r: ClassRoomView): string {
  const s = r.summary;
  if (!s) return r.status === 'waiting' ? '준비 중' : '';
  if (s.endReason === 'classEnded') return '수업 종료로 중단 (승패 없음)';
  if (s.phase === 'lobby') return '대기실';
  if (s.phase === 'finished') {
    if (!s.winner) return '게임 중단';
    return `${TEAM_NAME[s.winner]} 팀 승리${s.endReason === 'assassin' ? ' (암살자)' : ''}`;
  }
  const rem = s.remaining ? `남은 요원 빨강 ${s.remaining.red} · 파랑 ${s.remaining.blue}` : '';
  return `${s.turnTeam ? `${TEAM_NAME[s.turnTeam]} 차례` : ''} · ${rem} · 힌트 ${s.clueCount}개`;
}

function TeacherRoomCard({ room, send, ended }: { room: ClassRoomView; send: ClassSend; ended: boolean }) {
  const [host, setHost] = useState('');
  const [confirm, setConfirm] = useState(false);
  const seats = room.seats ?? [];
  return (
    <article className={`room-card room-${room.status}`} aria-label={`${room.name} 방`}>
      <header className="room-card-head">
        <h3>{room.name}</h3>
        <span className={`badge status-${room.status}`}>{STATUS_TEXT[room.status]}</span>
      </header>
      <p className="small">
        방장 {room.hostNickname ?? (room.seatCount > 0 && room.botCount === room.seatCount ? '선생님 (봇만 있는 방)' : <span className="warn-text">없음 — 선생님이 방장 역할</span>)} · {room.seatCount}/
        {room.capacity}명{room.botCount > 0 && ` (봇 ${room.botCount})`}
        {room.status === 'waiting' && ` · 준비 ${room.readyCount ?? 0}/${room.seatCount}`}
        {room.synced === false && <span className="muted"> · 방에 반영 중…</span>}
      </p>
      <p className="small room-summary">{summaryText(room)}</p>
      <ul className="seat-chips">
        {seats.map((s) => (
          <SeatChip key={s.memberId} room={room} s={s} send={send} canManage={!ended} />
        ))}
      </ul>
      {(room.requests?.length ?? 0) > 0 && <p className="muted small">참가 신청 {room.requests!.length}명 대기 (방장이 승인)</p>}
      {!ended && room.status !== 'closed' && (
        <div className="room-card-actions">
          <button type="button" className="btn btn-tiny" onClick={() => navigate(`/r/${room.id}`)}>
            {room.hostMemberId ? '공개 관전' : '들어가서 진행'}
          </button>
          <ClassBotAdder room={room} send={send} />
          <select value={host} onChange={(e) => setHost(e.target.value)} aria-label={`${room.name} 새 방장`}>
            <option value="">관리권 넘기기…</option>
            {seats
              .filter((s) => s.memberId !== room.hostMemberId && !s.bot)
              .map((s) => (
                <option key={s.memberId} value={s.memberId}>
                  {s.nickname}
                </option>
              ))}
          </select>
          <button type="button" className="btn btn-tiny" disabled={!host} onClick={() => void send({ type: 'setRoomHost', roomId: room.id, memberId: host }, '관리권을 넘겼습니다.').then(() => setHost(''))}>
            넘기기
          </button>
          <button type="button" className="btn btn-tiny btn-danger" onClick={() => setConfirm(true)}>
            방 닫기
          </button>
        </div>
      )}
      {confirm && (
        <Modal title={`‘${room.name}’ 방을 닫을까요?`} onClose={() => setConfirm(false)}>
          <p>{room.status === 'playing' ? '진행 중인 게임이 승패 없이 중단되고, ' : ''}앉아 있던 학생은 미배정으로 돌아갑니다.</p>
          <div className="modal-actions">
            <button type="button" className="btn" onClick={() => setConfirm(false)} data-autofocus>
              취소
            </button>
            <button
              type="button"
              className="btn btn-danger"
              onClick={() => {
                setConfirm(false);
                void send({ type: 'closeRoom', roomId: room.id }, '방을 닫았습니다.');
              }}
            >
              방 닫기
            </button>
          </div>
        </Modal>
      )}
    </article>
  );
}

function StudentRow({
  m,
  view,
  send,
  roomName,
  waitingRooms,
  ended,
}: {
  m: ClassMemberView;
  view: ClassView;
  send: ClassSend;
  roomName: (id: string | null) => string;
  waitingRooms: ClassRoomView[];
  ended: boolean;
}) {
  const [to, setTo] = useState('');
  const hostOf = view.rooms.find((r) => r.hostMemberId === m.id);
  const status = m.assignment ? `배정: ${roomName(m.assignment)}${hostOf ? ' (방장)' : ''}` : m.request ? `신청: ${roomName(m.request)}` : '미배정';
  return (
    <tr className={m.online ? '' : 'offline'}>
      <th scope="row">
        <span className={`dot ${m.online ? 'dot-on' : 'dot-off'}`} aria-hidden="true" /> {m.nickname}
        {m.detached && <span className="badge">연결 없음</span>}
        <span className="sr-only">{m.online ? '접속 중' : '접속 끊김'}</span>
      </th>
      <td>{status}</td>
      <td>
        {!ended && (
          <button
            type="button"
            className={`btn btn-tiny ${m.designated ? 'btn-on' : ''}`}
            aria-pressed={m.designated}
            onClick={() => void send(m.designated ? { type: 'revokeHost', memberId: m.id } : { type: 'designateHost', memberId: m.id }, m.designated ? `${m.nickname} 방장 지정을 해제했습니다.` : `${m.nickname}을(를) 방장으로 지정했습니다.`)}
          >
            {m.designated ? '방장 ✓' : '방장 지정'}
          </button>
        )}
      </td>
      <td>
        {!ended && (
          <span className="host-actions">
            <select value={to} onChange={(e) => setTo(e.target.value)} aria-label={`${m.nickname} 옮길 곳`}>
              <option value="">옮길 곳…</option>
              {m.assignment && <option value="__none">미배정으로</option>}
              {waitingRooms
                .filter((r) => r.id !== m.assignment && r.seatCount < r.capacity)
                .map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name} ({r.seatCount}/{r.capacity})
                  </option>
                ))}
            </select>
            <button
              type="button"
              className="btn btn-tiny"
              disabled={!to}
              onClick={() => void send({ type: 'moveStudent', memberId: m.id, toRoomId: to === '__none' ? null : to }, '옮겼습니다.').then(() => setTo(''))}
            >
              이동
            </button>
          </span>
        )}
      </td>
      <td>
        {!ended && (
          <button type="button" className="btn btn-tiny btn-danger" onClick={() => void send({ type: 'kickMember', memberId: m.id }, `${m.nickname}을(를) 내보냈습니다.`)}>
            내보내기
          </button>
        )}
      </td>
    </tr>
  );
}

function ReassignMember({ members, send }: { members: ClassMemberView[]; send: ClassSend }) {
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const froms = members.filter((m) => m.online && !m.assignment && !m.detached);
  const tos = members.filter((m) => m.detached || !m.online);
  if (!froms.length || !tos.length) return null;
  return (
    <details className="reassign">
      <summary>자리 재지정 (브라우저를 바꿔 새로 들어온 학생)</summary>
      <p className="muted small">쿠키를 잃어 새 이름으로 들어온 학생을 원래 자리(방·팀·역할)로 옮깁니다. 이미 정답을 본 학생이 추측자 자리로 옮겨지는 일은 게임방이 막습니다.</p>
      <div className="settings-row">
        <label className="field inline">
          <span>새로 들어온 학생</span>
          <select value={from} onChange={(e) => setFrom(e.target.value)}>
            <option value="">선택</option>
            {froms.map((m) => (
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
            {tos.map((m) => (
              <option key={m.id} value={m.id}>
                {m.nickname}
              </option>
            ))}
          </select>
        </label>
        <button type="button" className="btn btn-small" disabled={!from || !to} onClick={() => void send({ type: 'reassignMember', fromMemberId: from, toMemberId: to }, '자리를 옮겼습니다.')}>
          옮기기
        </button>
      </div>
    </details>
  );
}

function ClassSettings({ view, send }: { view: ClassView; send: ClassSend }) {
  const s = view.settings;
  const [cap, setCap] = useState(s.capacity);
  const range = [4, 5, 6, 7, 8];
  return (
    <details className="class-settings">
      <summary>수업 설정</summary>
      <div className="settings-row">
        <label className="field inline">
          <span>학생 정원 (최대 {s.maxCapacity})</span>
          <input type="number" min={1} max={s.maxCapacity} value={cap} onChange={(e) => setCap(Number(e.target.value))} />
        </label>
        <button type="button" className="btn btn-small" onClick={() => void send({ type: 'setSettings', capacity: cap }, '정원을 바꿨습니다.')}>
          저장
        </button>
      </div>
      <div className="settings-row">
        {(
          [
            ['roomCapMin', '방 최소'],
            ['roomCapDefault', '방 기본'],
            ['roomCapMax', '방 최대'],
          ] as const
        ).map(([k, label]) => (
          <label key={k} className="field inline">
            <span>{label}</span>
            <select value={s[k]} onChange={(e) => void send({ type: 'setSettings', [k]: Number(e.target.value) } as ClassCommand)}>
              {range.map((n) => (
                <option key={n} value={n}>
                  {n}명
                </option>
              ))}
            </select>
          </label>
        ))}
      </div>
      <p className="muted small">방장은 이 범위 안에서 방 정원을 고릅니다. 학급 모드는 표준 대전으로 진행하며, 4명 미만 방을 소인원 변형으로 바꾸지 않습니다.</p>
      <button
        type="button"
        className="btn btn-tiny"
        onClick={() => void send({ type: 'rotateInvite' }, '초대 링크를 새로 만들었습니다. 이전 링크는 쓸 수 없습니다.')}
      >
        초대 링크 새로 만들기
      </button>
    </details>
  );
}

// ================================================================== 학생

function StudentClass({ view, send }: { view: ClassView; send: ClassSend }) {
  const manifest = useManifest();
  const me = view.you;
  const assignedId = me.assignment?.roomId;
  const requestedId = me.request?.roomId;
  const assigned = assignedId ? view.rooms.find((r) => r.id === assignedId) : undefined;
  const requested = requestedId ? view.rooms.find((r) => r.id === requestedId) : undefined;
  const owned = me.ownsRoomId ? view.rooms.find((r) => r.id === me.ownsRoomId) : undefined;
  const latest = view.announcements.at(-1);

  return (
    <main className="classroom student">
      <Backdrop desktop="lobby" manifest={manifest} dim={0.35} />
      <header className="topbar">
        <div className="topbar-left">
          <Emblem size={36} />
          <div>
            <h1 className="topbar-title">{view.name}</h1>
            <p className="muted small">
              {me.nickname}
              {me.designated ? ' · 방장' : ''}
            </p>
          </div>
        </div>
        <div className="topbar-right">
          <button type="button" className="btn btn-small" disabled={me.helpPending} onClick={() => void send({ type: 'help' }, '선생님께 도움을 요청했습니다.')}>
            {me.helpPending ? '🙋 요청함' : '🙋 선생님 도움 요청'}
          </button>
          <SoundToggle />
        </div>
      </header>

      <div className="class-student">
        {latest && (
          <section className="announce-banner" role="status" aria-live="polite">
            📢 {latest.text}
          </section>
        )}
        {me.notice && (
          <section className="panel notice-card" role="status">
            <p>{noticeText(me.notice.kind, me.notice.roomName)}</p>
            <button type="button" className="btn btn-tiny" onClick={() => void send({ type: 'dismissNotice' })}>
              확인
            </button>
          </section>
        )}

        <section className="panel my-status" aria-label="내 상태">
          <h2>내 자리</h2>
          {assigned ? (
            <>
              <p>
                <strong>{assigned.name}</strong> 방에 배정되었습니다 · {assigned.seatCount}/{assigned.capacity}명 · {STATUS_TEXT[assigned.status]}
              </p>
              <div className="action-row">
                <button type="button" className="btn btn-primary btn-lg" disabled={!me.assignment?.synced} onClick={() => navigate(`/r/${assigned.id}`)}>
                  {me.assignment?.synced ? '입장하기' : '입장 준비 중…'}
                </button>
                {!owned && assigned.status !== 'playing' && (
                  <button type="button" className="btn" onClick={() => void send({ type: 'leaveRoom' }, '방에서 나왔습니다.')}>
                    방 나가기
                  </button>
                )}
              </div>
            </>
          ) : requested ? (
            <>
              <p>
                <strong>{requested.name}</strong> 방에 참가 신청했습니다. 방장의 승인을 기다리는 중…
              </p>
              <button type="button" className="btn" onClick={() => void send({ type: 'cancelRequest' }, '신청을 취소했습니다.')}>
                신청 취소
              </button>
            </>
          ) : (
            <p className="muted">아직 방이 없습니다. {me.designated ? '게임방을 만들거나 ' : ''}아래 방 목록에서 참가 신청하세요.</p>
          )}
        </section>

        {me.designated && !owned && !assigned && <CreateRoom view={view} send={send} />}
        {owned && <HostPanel room={owned} send={send} />}

        <section className="panel" aria-label="방 목록">
          <h2>게임방</h2>
          {view.rooms.length === 0 ? (
            <p className="muted">아직 열린 방이 없습니다. 방장이 방을 만들면 여기에 보입니다.</p>
          ) : (
            <ul className="room-list">
              {view.rooms.map((r) => {
                const full = r.seatCount >= r.capacity;
                const mine = r.id === assigned?.id;
                const pending = r.id === requested?.id;
                return (
                  <li key={r.id} className={`room-row room-${r.status}`}>
                    <div>
                      <strong>{r.name}</strong> <span className={`badge status-${r.status}`}>{STATUS_TEXT[r.status]}</span>
                      <br />
                      <span className="small muted">
                        방장 {r.hostNickname ?? '선생님'} · {r.seatCount}/{r.capacity}명{r.botCount > 0 ? ` (봇 ${r.botCount})` : ''}
                      </span>
                    </div>
                    {mine ? (
                      <span className="small ok-text">내 방</span>
                    ) : pending ? (
                      <span className="small">신청함</span>
                    ) : (
                      <button type="button" className="btn btn-small" disabled={!!assigned || full || r.status !== 'waiting'} onClick={() => void send({ type: 'requestJoin', roomId: r.id }, `‘${r.name}’에 참가 신청했습니다.`)}>
                        {r.status !== 'waiting' ? '게임 중' : full ? '가득 참' : '참가 신청'}
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
          {assigned && <p className="muted small">한 번에 한 방에만 있을 수 있습니다. 다른 방에 가려면 먼저 방에서 나오세요.</p>}
        </section>
      </div>
    </main>
  );
}

function CreateRoom({ view, send }: { view: ClassView; send: ClassSend }) {
  const s = view.settings;
  const [name, setName] = useState(`${view.you.nickname}의 방`);
  const [cap, setCap] = useState(s.roomCapDefault);
  const options = [];
  for (let n = s.roomCapMin; n <= s.roomCapMax; n++) options.push(n);
  return (
    <section className="panel host-create" aria-label="게임방 만들기">
      <h2>게임방 만들기</h2>
      <p className="muted small">선생님이 방장으로 지정했습니다. 방장도 좌석 하나를 씁니다(정원에 포함). 한 방은 두 팀이며, 방장이 자동으로 스파이마스터가 되지는 않습니다.</p>
      <form
        className="settings-row"
        onSubmit={(e) => {
          e.preventDefault();
          void send({ type: 'createRoom', name, capacity: cap }, '게임방을 만들었습니다.');
        }}
      >
        <label className="field inline grow">
          <span>방 이름</span>
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={20} required />
        </label>
        <label className="field inline">
          <span>정원</span>
          <select value={cap} onChange={(e) => setCap(Number(e.target.value))}>
            {options.map((n) => (
              <option key={n} value={n}>
                {n}명 ({Math.ceil(n / 2)} 대 {Math.floor(n / 2)})
              </option>
            ))}
          </select>
        </label>
        <button type="submit" className="btn btn-primary">
          만들기
        </button>
      </form>
    </section>
  );
}

function HostPanel({ room, send }: { room: ClassRoomView; send: ClassSend }) {
  const v = room.rosterVersion ?? 0;
  const full = room.seatCount >= room.capacity;
  const [confirmClose, setConfirmClose] = useState(false);
  const caps = [4, 5, 6, 7, 8].filter((n) => n >= room.seatCount);
  return (
    <section className="panel host-panel" aria-label="내 방 관리">
      <h2>
        내 방 관리 · {room.name} <span className={`badge status-${room.status}`}>{STATUS_TEXT[room.status]}</span>
      </h2>
      <p className="small">
        {room.seatCount}/{room.capacity}명 {full ? '· 정원이 찼습니다' : `· ${room.capacity - room.seatCount}자리 남음`}
      </p>
      <ul className="seat-chips">
        {(room.seats ?? []).map((s) =>
          s.bot ? (
            <SeatChip key={s.memberId} room={room} s={s} send={send} canManage />
          ) : (
            <li key={s.memberId}>
              <span className={`dot ${s.online ? 'dot-on' : 'dot-off'}`} aria-hidden="true" />
              {s.nickname}
              {s.memberId === room.hostMemberId ? ' (방장)' : ''}
              {room.status === 'waiting' && s.memberId !== room.hostMemberId && (
                <button type="button" className="btn btn-tiny" onClick={() => void send({ type: 'removeFromRoom', roomId: room.id, memberId: s.memberId, expectedRosterVersion: v })}>
                  내보내기
                </button>
              )}
            </li>
          ),
        )}
      </ul>
      {room.status === 'waiting' && room.seatCount < room.capacity && (
        <p className="small">
          사람이 모자라면 봇으로 채울 수 있습니다: <ClassBotAdder room={room} send={send} />
        </p>
      )}
      <h3>참가 신청 {room.requests?.length ?? 0}명</h3>
      {(room.requests?.length ?? 0) === 0 ? (
        <p className="muted small">신청한 학생이 없습니다.</p>
      ) : (
        <ul className="plain-list">
          {room.requests!.map((q) => (
            <li key={q.memberId}>
              <strong>{q.nickname}</strong>
              <span className="host-actions">
                <button type="button" className="btn btn-tiny btn-primary" disabled={full || room.status !== 'waiting'} onClick={() => void send({ type: 'approve', roomId: room.id, memberId: q.memberId, expectedRosterVersion: v }, `${q.nickname} 승인`)}>
                  승인
                </button>
                <button type="button" className="btn btn-tiny" onClick={() => void send({ type: 'reject', roomId: room.id, memberId: q.memberId })}>
                  거절
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}
      <div className="action-row">
        <button type="button" className="btn btn-primary" disabled={room.synced === false} onClick={() => navigate(`/r/${room.id}`)}>
          {room.synced === false ? '방 준비 중…' : '내 방 입장'}
        </button>
        {room.status === 'waiting' && (
          <label className="field inline">
            <span>정원</span>
            <select value={room.capacity} onChange={(e) => void send({ type: 'setRoomCapacity', roomId: room.id, capacity: Number(e.target.value), expectedRosterVersion: v })}>
              {caps.map((n) => (
                <option key={n} value={n}>
                  {n}명
                </option>
              ))}
            </select>
          </label>
        )}
        {room.status !== 'playing' && (
          <button type="button" className="btn btn-danger btn-small" onClick={() => setConfirmClose(true)}>
            방 닫기
          </button>
        )}
      </div>
      <p className="muted small">정원이 모두 차고, 모두 접속해 팀·역할을 고르고 ‘준비 완료’를 눌러야 게임을 시작할 수 있습니다. 시작하면 명단이 잠깁니다.</p>
      {confirmClose && (
        <Modal title="방을 닫을까요?" onClose={() => setConfirmClose(false)}>
          <p>앉아 있던 학생은 미배정으로 돌아갑니다.</p>
          <div className="modal-actions">
            <button type="button" className="btn" onClick={() => setConfirmClose(false)} data-autofocus>
              취소
            </button>
            <button
              type="button"
              className="btn btn-danger"
              onClick={() => {
                setConfirmClose(false);
                void send({ type: 'closeRoom', roomId: room.id }, '방을 닫았습니다.');
              }}
            >
              방 닫기
            </button>
          </div>
        </Modal>
      )}
    </section>
  );
}
