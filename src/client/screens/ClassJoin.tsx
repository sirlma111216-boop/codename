import { useEffect, useState } from 'react';
import { api, ApiError, parseInvite } from '../api.ts';
import { savedNickname, saveNickname } from '../recent.ts';
import { useManifest } from '../theme.ts';
import { Backdrop, Emblem, navigate } from '../ui.tsx';

const KEY = 'codename.classInvite';

function pendingClassInvite(): { roomId: string; token: string } | null {
  let raw: string | null = null;
  try {
    raw = sessionStorage.getItem(KEY);
  } catch {
    /* 무시 */
  }
  raw ??= (window as unknown as { __classInvite?: string }).__classInvite ?? null;
  return raw ? parseInvite(raw) : null;
}

export function stashClassInvite(raw: string) {
  try {
    sessionStorage.setItem(KEY, raw);
  } catch {
    /* 무시 */
  }
  (window as unknown as { __classInvite?: string }).__classInvite = raw;
}

function clear() {
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    /* 무시 */
  }
  delete (window as unknown as { __classInvite?: string }).__classInvite;
}

/** 학생: 클래스 초대 링크 → 닉네임 → 클래스 대기실 */
export function ClassJoin() {
  const manifest = useManifest();
  const [invite] = useState(pendingClassInvite);
  const classId = invite?.roomId ?? '';
  const [nick, setNick] = useState(savedNickname());
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    if (!invite) {
      setChecking(false);
      return;
    }
    api.classStatus(classId).then(
      (s) => {
        if (s.status === 'member' || s.status === 'teacher') {
          clear();
          navigate(`/c/${classId}`, true);
          return;
        }
        if (s.status === 'gone') setErr('클래스가 없거나 정리되었습니다.');
        if (s.status === 'ended') setErr('수업이 끝났습니다.');
        if (s.status === 'banned') setErr('이 클래스에서 내보내졌습니다.');
        setChecking(false);
      },
      () => setChecking(false),
    );
  }, [invite, classId]);

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
            api.joinClass(classId, invite.token, nick).then(
              () => {
                saveNickname(nick);
                clear();
                navigate(`/c/${classId}`, true);
              },
              (x: unknown) => {
                setBusy(false);
                setErr(x instanceof ApiError ? x.message : '입장하지 못했습니다.');
              },
            );
          }}
        >
          <Emblem />
          <h1 className="panel-title">수업 입장</h1>
          {!invite ? (
            <>
              <p>수업 초대 링크를 찾지 못했습니다. 선생님이 보여 준 링크나 QR 코드를 다시 열어 주세요.</p>
              <button type="button" className="btn" onClick={() => navigate('/')}>
                처음 화면으로
              </button>
            </>
          ) : (
            <>
              <label className="field">
                <span>닉네임 (친구들에게 보이는 이름)</span>
                <input value={nick} onChange={(e) => setNick(e.target.value)} maxLength={16} required autoComplete="nickname" disabled={checking} data-autofocus />
              </label>
              <p className="muted small">로그인은 없습니다. 이 브라우저로 다시 들어오면 같은 자리로 돌아옵니다.</p>
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
