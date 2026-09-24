import { useEffect, useState } from 'react';
import { api, ApiError } from './api.ts';
import { Home } from './screens/Home.tsx';
import { Join } from './screens/Join.tsx';
import { RoomScreen } from './screens/Room.tsx';
import { RulesPage } from './screens/Rules.tsx';
import { AnnounceProvider, Emblem, ToastProvider, usePath } from './ui.tsx';

type Gate = { state: 'loading' } | { state: 'ready' } | { state: 'password' } | { state: 'error'; message: string };

export function App() {
  const path = usePath();
  const [gate, setGate] = useState<Gate>({ state: 'loading' });

  useEffect(() => {
    // 첫 방문: 서버가 익명 세션 쿠키를 만든다. 회원가입·로그인은 없다.
    api
      .session()
      .then((s) => setGate(s.needsPassword && !s.admitted ? { state: 'password' } : { state: 'ready' }))
      .catch((e: unknown) => setGate({ state: 'error', message: e instanceof ApiError ? e.message : '서버에 연결하지 못했습니다.' }));
  }, []);

  let body;
  if (gate.state === 'loading') body = <div className="center-page">불러오는 중…</div>;
  else if (gate.state === 'error')
    body = (
      <div className="center-page">
        <p>{gate.message}</p>
        <button type="button" className="btn" onClick={() => location.reload()}>
          다시 시도
        </button>
      </div>
    );
  else if (gate.state === 'password') body = <PasswordGate onOk={() => setGate({ state: 'ready' })} />;
  else {
    const room = path.match(/^\/r\/([A-Za-z0-9_-]{22})$/);
    if (room) body = <RoomScreen key={room[1]} roomId={room[1] as string} />;
    else if (path === '/join') body = <Join />;
    else if (path === '/rules') body = <RulesPage />;
    else body = <Home />;
  }

  return (
    <ToastProvider>
      <AnnounceProvider>{body}</AnnounceProvider>
    </ToastProvider>
  );
}

/** 선택적 공용 입장 암호 (운영자가 설정한 경우에만). 참가자 계정이 아니다. */
function PasswordGate({ onOk }: { onOk: () => void }) {
  const [pw, setPw] = useState('');
  const [err, setErr] = useState('');
  return (
    <div className="center-page">
      <form
        className="panel narrow"
        onSubmit={(e) => {
          e.preventDefault();
          api.entry(pw).then(onOk, (x: unknown) => setErr(x instanceof ApiError ? x.message : '확인하지 못했습니다.'));
        }}
      >
        <Emblem />
        <h1 className="panel-title">입장 암호</h1>
        <p className="muted">이 서버는 모임 운영자가 정한 공용 입장 암호가 있어야 쓸 수 있습니다.</p>
        <label className="field">
          <span>암호</span>
          <input type="password" value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="off" required />
        </label>
        {err && (
          <p className="error-text" role="alert">
            {err}
          </p>
        )}
        <button className="btn btn-primary" type="submit">
          입장
        </button>
      </form>
    </div>
  );
}
