import { useState } from 'react';
import { api, ApiError, parseInvite } from '../api.ts';
import { recentRooms, rememberRoom, savedNickname, saveNickname } from '../recent.ts';
import { useManifest } from '../theme.ts';
import { RECOVERY_KEY } from './Class.tsx';
import { stashClassInvite } from './ClassJoin.tsx';
import { SoloDialog } from './SoloSetup.tsx';
import { Backdrop, Emblem, Modal, navigate } from '../ui.tsx';

export function Home() {
  const manifest = useManifest();
  const [dialog, setDialog] = useState<'none' | 'create' | 'join' | 'class' | 'solo'>('none');
  const recent = recentRooms();

  return (
    <main className="home">
      <Backdrop desktop="title-desktop" mobile="title-mobile" manifest={manifest} />
      <div className="home-center">
        <Emblem size={64} />
        <h1 className="title">코드네임</h1>
        <p className="subtitle">한 단어와 숫자로 우리 편 요원을 찾아라</p>
        <div className="home-actions">
          <button type="button" className="btn btn-primary btn-lg" onClick={() => setDialog('create')}>
            새 방 만들기
          </button>
          <button type="button" className="btn btn-lg" onClick={() => setDialog('join')}>
            초대 링크로 입장
          </button>
        </div>
        <div className="home-solo">
          <button type="button" className="btn btn-lg btn-solo" onClick={() => setDialog('solo')}>
            🤖 혼자서 플레이
          </button>
          <span className="muted small">봇과 바로 한 판 — 인원·난이도를 고르세요</span>
        </div>
        <div className="home-class">
          <span className="muted small">수업에서 쓰나요?</span>
          <button type="button" className="btn btn-small" onClick={() => setDialog('class')}>
            수업 만들기 (선생님)
          </button>
        </div>
        <p className="home-intro">
          두 팀의 스파이마스터가 한 단어짜리 힌트와 숫자를 주면, 팀원들이 5×5 단어판에서 자기 팀 요원을 찾습니다. 시민은 턴을 끝내고, 암살자를 건드리면 바로 집니다.
          회원가입 없이 닉네임만 정하고, 각자 휴대폰이나 컴퓨터로 같은 방에 들어오면 됩니다.
        </p>
        <nav className="home-links">
          <a
            href="/rules"
            onClick={(e) => {
              e.preventDefault();
              navigate('/rules');
            }}
          >
            규칙 도움말
          </a>
        </nav>
        {recent.length > 0 && (
          <section className="recent" aria-label="최근 들어간 방">
            <h2>최근 들어간 방</h2>
            <ul>
              {recent.map((r) => (
                <li key={r.roomId}>
                  <button type="button" className="link-btn" onClick={() => navigate(`/r/${r.roomId}`)}>
                    {r.nickname}(으)로 들어간 방 · {new Date(r.at).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}
        <p className="disclaimer">
          Codenames는 Czech Games Edition의 보드게임입니다(게임 디자인 Vlaada Chvátil). 이 웹앱은 내부·교육·친목 모임용 비공식 구현이며 공식 제품이 아닙니다.
        </p>
      </div>
      {dialog === 'create' && <CreateDialog onClose={() => setDialog('none')} />}
      {dialog === 'join' && <JoinDialog onClose={() => setDialog('none')} />}
      {dialog === 'class' && <CreateClassDialog onClose={() => setDialog('none')} />}
      {dialog === 'solo' && <SoloDialog onClose={() => setDialog('none')} />}
    </main>
  );
}

function CreateDialog({ onClose }: { onClose: () => void }) {
  const [nick, setNick] = useState(savedNickname());
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  return (
    <Modal title="새 방 만들기" onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          setBusy(true);
          setErr('');
          api.createRoom(nick).then(
            (r) => {
              saveNickname(nick);
              rememberRoom(r.roomId, nick);
              navigate(`/r/${r.roomId}`);
            },
            (x: unknown) => {
              setBusy(false);
              setErr(x instanceof ApiError ? x.message : '방을 만들지 못했습니다.');
            },
          );
        }}
      >
        <label className="field">
          <span>닉네임 (다른 참가자에게 보이는 이름)</span>
          <input value={nick} onChange={(e) => setNick(e.target.value)} maxLength={16} required autoComplete="nickname" data-autofocus />
        </label>
        <p className="muted small">방을 만든 사람이 방장이 됩니다. 방장은 초대·잠금·강퇴를 관리하지만, 스파이마스터가 아니면 정답을 볼 수 없습니다.</p>
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
            {busy ? '만드는 중…' : '방 만들기'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function CreateClassDialog({ onClose }: { onClose: () => void }) {
  const [name, setName] = useState('');
  const [cap, setCap] = useState(40);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  return (
    <Modal title="수업 만들기 (선생님)" onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          setBusy(true);
          setErr('');
          api.createClass(name, cap).then(
            (r) => {
              try {
                sessionStorage.setItem(RECOVERY_KEY(r.classId), r.recoveryKey);
              } catch {
                /* 저장 못 하면 복구 키를 보여 주지 못한다 */
              }
              navigate(`/c/${r.classId}`);
            },
            (x: unknown) => {
              setBusy(false);
              setErr(x instanceof ApiError ? x.message : '수업을 만들지 못했습니다.');
            },
          );
        }}
      >
        <label className="field">
          <span>클래스 이름</span>
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={30} placeholder="예: 3학년 2반 국어" required data-autofocus />
        </label>
        <label className="field">
          <span>학생 정원 (교사 제외, 이 서버 최대 60명)</span>
          <input type="number" min={1} max={60} value={cap} onChange={(e) => setCap(Number(e.target.value))} />
        </label>
        <p className="muted small">
          계정 가입은 없습니다. 이 브라우저가 선생님 자리가 됩니다. 만들고 나면 학생 초대 링크·QR과, 다른 기기에서 이어서 관리할 때 쓰는 복구 키를 한 번 보여 줍니다. 방은 선생님이 지정한 학생
          방장이 만들고, 학생은 참가 신청 → 방장 승인으로 들어갑니다. 선생님은 봇만으로 된 시뮬레이션 방을 만들어 시범을 보일 수도 있습니다.
        </p>
        {err && (
          <p className="error-text" role="alert">
            {err}
          </p>
        )}
        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose}>
            취소
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy || !name.trim()}>
            {busy ? '만드는 중…' : '수업 만들기'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function JoinDialog({ onClose }: { onClose: () => void }) {
  const [text, setText] = useState('');
  const [err, setErr] = useState('');
  return (
    <Modal title="초대 링크로 입장" onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const inv = parseInvite(text);
          if (inv && text.includes('/c/join')) {
            // 수업(클래스) 초대 링크
            stashClassInvite(`${inv.roomId}.${inv.token}`);
            navigate('/c/join');
            return;
          }
          if (!inv) {
            setErr('초대 링크 형식이 아닙니다. 방장에게 받은 링크 전체를 붙여 넣으세요.');
            return;
          }
          try {
            sessionStorage.setItem('codename.invite', `${inv.roomId}.${inv.token}`);
          } catch {
            /* 무시 */
          }
          (window as unknown as { __invite?: string }).__invite = `${inv.roomId}.${inv.token}`;
          navigate('/join');
        }}
      >
        <label className="field">
          <span>초대 링크</span>
          <input value={text} onChange={(e) => setText(e.target.value)} placeholder="https://…/join#…" required data-autofocus />
        </label>
        {err && (
          <p className="error-text" role="alert">
            {err}
          </p>
        )}
        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose}>
            취소
          </button>
          <button type="submit" className="btn btn-primary">
            다음
          </button>
        </div>
      </form>
    </Modal>
  );
}
