import { useEffect, useState } from 'react';
import { api, ApiError, parseInvite } from '../api.ts';
import { rememberRoom, savedNickname, saveNickname } from '../recent.ts';
import { useManifest } from '../theme.ts';
import { Backdrop, Emblem, navigate } from '../ui.tsx';

function pendingInvite(): { roomId: string; token: string } | null {
  let raw: string | null = null;
  try {
    raw = sessionStorage.getItem('codename.invite');
  } catch {
    /* 무시 */
  }
  raw ??= (window as unknown as { __invite?: string }).__invite ?? null;
  return raw ? parseInvite(raw) : null;
}

function clearInvite() {
  try {
    sessionStorage.removeItem('codename.invite');
  } catch {
    /* 무시 */
  }
  delete (window as unknown as { __invite?: string }).__invite;
}

export function Join() {
  const manifest = useManifest();
  const [invite] = useState(pendingInvite);
  const [nick, setNick] = useState(savedNickname());
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    if (!invite) {
      setChecking(false);
      return;
    }
    // 이미 이 방의 참가자라면 바로 들어간다 (새로고침·링크 재클릭)
    api.status(invite.roomId).then(
      (s) => {
        if (s.status === 'member') {
          clearInvite();
          navigate(`/r/${invite.roomId}`, true);
        } else if (s.status === 'gone') {
          setErr('방이 없거나 정리되었습니다. 방장에게 새 방을 만들어 달라고 하세요.');
          setChecking(false);
        } else if (s.status === 'banned') {
          setErr('이 방에서 강퇴되어 다시 들어갈 수 없습니다.');
          setChecking(false);
        } else setChecking(false);
      },
      () => setChecking(false),
    );
  }, [invite]);

  return (
    <main className="home">
      <Backdrop desktop="title-desktop" mobile="title-mobile" manifest={manifest} dim={0.35} />
      <div className="home-center">
        <form
          className="panel narrow"
          onSubmit={(e) => {
            e.preventDefault();
            if (!invite) return;
            setBusy(true);
            setErr('');
            api.join(invite.roomId, invite.token, nick).then(
              () => {
                saveNickname(nick);
                rememberRoom(invite.roomId, nick);
                clearInvite();
                navigate(`/r/${invite.roomId}`, true);
              },
              (x: unknown) => {
                setBusy(false);
                setErr(x instanceof ApiError ? x.message : '입장하지 못했습니다.');
              },
            );
          }}
        >
          <Emblem />
          <h1 className="panel-title">작전 대기실 입장</h1>
          {!invite ? (
            <>
              <p>초대 링크를 찾지 못했습니다. 방장에게 받은 링크를 다시 열어 주세요.</p>
              <button type="button" className="btn" onClick={() => navigate('/')}>
                처음 화면으로
              </button>
            </>
          ) : (
            <>
              <label className="field">
                <span>닉네임</span>
                <input value={nick} onChange={(e) => setNick(e.target.value)} maxLength={16} required autoComplete="nickname" disabled={checking} data-autofocus />
              </label>
              <p className="muted small">닉네임은 표시 이름일 뿐 로그인이 아닙니다. 이 브라우저의 쿠키로 다시 들어올 수 있습니다.</p>
              {err && (
                <p className="error-text" role="alert">
                  {err}
                </p>
              )}
              <button type="submit" className="btn btn-primary" disabled={busy || checking || !nick.trim()}>
                {busy ? '들어가는 중…' : '입장'}
              </button>
            </>
          )}
        </form>
      </div>
    </main>
  );
}
