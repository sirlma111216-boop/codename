import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import { parseInvite } from './api.ts';
import { unlockAudio } from './sound.ts';
import './styles.css';

// 초대 토큰은 URL fragment(#)로 받아 즉시 주소창에서 지운다 (기록·공유 화면 노출 최소화).
if (location.pathname === '/join' && location.hash.length > 1) {
  const inv = parseInvite(location.hash);
  if (inv) {
    try {
      sessionStorage.setItem('codename.invite', `${inv.roomId}.${inv.token}`);
    } catch {
      /* 저장 못 하면 아래에서 한 번 더 파싱한다 */
    }
  }
  (window as unknown as { __invite?: string }).__invite = location.hash.slice(1);
  history.replaceState(null, '', '/join');
}

// 효과음은 사용자 동작 뒤에만 켤 수 있다.
const unlock = () => {
  unlockAudio();
  window.removeEventListener('pointerdown', unlock);
  window.removeEventListener('keydown', unlock);
};
window.addEventListener('pointerdown', unlock);
window.addEventListener('keydown', unlock);

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
