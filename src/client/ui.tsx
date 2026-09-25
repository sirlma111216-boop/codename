import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import type { Team } from '../shared/view.ts';
import { TEAM_MARK, TEAM_NAME } from './labels.ts';
import { isMuted, setMuted, unlockAudio } from './sound.ts';
import { fallbackColor, imageUrl, useManifest, type AssetManifest } from './theme.ts';

// ------------------------------------------------------------------ 라우팅

export function navigate(to: string, replace = false) {
  if (replace) history.replaceState(null, '', to);
  else history.pushState(null, '', to);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

export function usePath(): string {
  const [path, setPath] = useState(location.pathname);
  useEffect(() => {
    const on = () => setPath(location.pathname);
    window.addEventListener('popstate', on);
    return () => window.removeEventListener('popstate', on);
  }, []);
  return path;
}

// ------------------------------------------------------------------ 알림

interface Toast {
  id: number;
  text: string;
  tone: 'info' | 'error';
}
const ToastCtx = createContext<(text: string, tone?: Toast['tone']) => void>(() => {});

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const seq = useRef(0);
  const push = useCallback((text: string, tone: Toast['tone'] = 'info') => {
    const id = ++seq.current;
    setToasts((t) => [...t.slice(-2), { id, text, tone }]);
    window.setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), tone === 'error' ? 6000 : 3500);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast toast-${t.tone}`}>
            {t.text}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

export const useToast = () => useContext(ToastCtx);

// ------------------------------------------------------------------ 화면 낭독기 안내

const AnnounceCtx = createContext<(text: string) => void>(() => {});

export function AnnounceProvider({ children }: { children: ReactNode }) {
  const [msg, setMsg] = useState('');
  const announce = useCallback((text: string) => {
    setMsg('');
    window.setTimeout(() => setMsg(text), 30);
  }, []);
  return (
    <AnnounceCtx.Provider value={announce}>
      {children}
      <div className="sr-only" aria-live="assertive" aria-atomic="true">
        {msg}
      </div>
    </AnnounceCtx.Provider>
  );
}

export const useAnnounce = () => useContext(AnnounceCtx);

// ------------------------------------------------------------------ 대화상자

export function Modal({
  title,
  children,
  onClose,
  wide,
  labelledBy,
}: {
  title: string;
  children: ReactNode;
  onClose?: () => void;
  wide?: boolean;
  labelledBy?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    const el = ref.current;
    const first = el?.querySelector<HTMLElement>('[data-autofocus], input, textarea, select, button');
    first?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && onClose) {
        e.preventDefault();
        onClose();
      }
      if (e.key === 'Tab' && el) {
        const items = [...el.querySelectorAll<HTMLElement>('button, input, textarea, select, a[href], [tabindex="0"]')].filter((x) => !x.hasAttribute('disabled'));
        if (!items.length) return;
        const firstEl = items[0] as HTMLElement;
        const lastEl = items[items.length - 1] as HTMLElement;
        if (e.shiftKey && document.activeElement === firstEl) {
          e.preventDefault();
          lastEl.focus();
        } else if (!e.shiftKey && document.activeElement === lastEl) {
          e.preventDefault();
          firstEl.focus();
        }
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      prev?.focus?.();
    };
  }, [onClose]);
  const id = labelledBy ?? `modal-${title.replace(/\s+/g, '-')}`;
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose?.()}>
      <div ref={ref} className={`modal ${wide ? 'modal-wide' : ''}`} role="dialog" aria-modal="true" aria-labelledby={id}>
        <div className="modal-head">
          <h2 id={id}>{title}</h2>
          {onClose && (
            <button type="button" className="icon-btn" onClick={onClose} aria-label="닫기">
              ✕
            </button>
          )}
        </div>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ 팀 표시 (색 + 글자 + 기호)

export function TeamTag({ team, suffix = '팀' }: { team: Team; suffix?: string }) {
  return (
    <span className={`team-tag team-${team}`}>
      <span aria-hidden="true">{TEAM_MARK[team]}</span> {TEAM_NAME[team]}
      {suffix ? ` ${suffix}` : ''}
    </span>
  );
}

// ------------------------------------------------------------------ 배경 그림 (없으면 단색)

export function Backdrop({ desktop, mobile, manifest, dim = 0 }: { desktop: string; mobile?: string; manifest: AssetManifest | null; dim?: number }) {
  const d = imageUrl(manifest, desktop);
  const m = mobile ? imageUrl(manifest, mobile) : null;
  return (
    <div className="backdrop" style={{ backgroundColor: fallbackColor(manifest, desktop) }} aria-hidden="true">
      {d && (
        <picture>
          {m && <source media="(orientation: portrait)" srcSet={m} />}
          <img src={d} alt="" decoding="async" />
        </picture>
      )}
      {dim > 0 && <div className="backdrop-dim" style={{ opacity: dim }} />}
    </div>
  );
}

export function Emblem({ size = 56 }: { size?: number }) {
  const m = useManifest();
  const url = imageUrl(m, 'app-emblem');
  if (!url) return <span className="emblem-fallback" style={{ width: size, height: size }} aria-hidden="true" />;
  return <img className="emblem" src={url} style={{ height: size, width: 'auto' }} alt="" aria-hidden="true" />;
}

// ------------------------------------------------------------------ 소리 켜고 끄기

export function SoundToggle() {
  const [muted, set] = useState(isMuted());
  return (
    <button
      type="button"
      className="icon-btn"
      aria-pressed={!muted}
      aria-label={muted ? '소리 켜기' : '소리 끄기'}
      title={muted ? '소리 켜기' : '소리 끄기'}
      onClick={() => {
        unlockAudio();
        setMuted(!muted);
        set(!muted);
      }}
    >
      {muted ? '🔇' : '🔊'}
    </button>
  );
}

/** 연결 상태 배너: 게임방·클래스 연결이 함께 쓴다 */
export function ConnectionOverlay({ conn, fullPage }: { conn: { status: string; attempt: number; reconnectNow(): void }; fullPage?: boolean }) {
  const m = useManifest();
  const img = imageUrl(m, 'reconnecting');
  if (!fullPage && conn.status === 'open') return null;
  const text =
    conn.status === 'offline'
      ? '인터넷 연결이 끊겼습니다. 연결되면 자동으로 다시 붙습니다.'
      : conn.status === 'connecting'
        ? '연결하는 중…'
        : `연결이 끊겨 다시 연결하는 중… (${conn.attempt}번째 시도)`;
  return (
    <div className={fullPage ? 'center-page' : 'conn-banner'} role="status" aria-live="polite">
      <div className="conn-box">
        {img && <img src={img} alt="" width={64} height={64} />}
        <div>
          <p>{text}</p>
          {conn.status !== 'connecting' && (
            <button type="button" className="btn btn-small" onClick={() => conn.reconnectNow()}>
              지금 다시 연결
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

export function copyText(text: string): Promise<boolean> {
  if (navigator.clipboard?.writeText) {
    return navigator.clipboard.writeText(text).then(
      () => true,
      () => false,
    );
  }
  return Promise.resolve(false);
}
