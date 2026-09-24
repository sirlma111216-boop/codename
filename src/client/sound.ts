// 짧은 합성 효과음 (오디오 파일·무단 음악 없음). 사용자 동작 뒤에만 재생되고 음소거할 수 있다.
// 소리는 공개가 서버에서 확정된 뒤에만 울린다 — 공개 전 단서가 되지 않는다.

const KEY = 'codename.sound';
let ctx: AudioContext | null = null;
let muted = readMuted();

function readMuted(): boolean {
  try {
    return localStorage.getItem(KEY) === 'off';
  } catch {
    return false;
  }
}

export function isMuted(): boolean {
  return muted;
}

export function setMuted(v: boolean) {
  muted = v;
  try {
    localStorage.setItem(KEY, v ? 'off' : 'on');
  } catch {
    /* 저장 못 해도 동작한다 */
  }
}

/** 첫 클릭/키 입력 때 호출: 브라우저 자동재생 정책 때문에 사용자 동작 뒤에 AudioContext 를 연다 */
export function unlockAudio() {
  if (ctx || typeof AudioContext === 'undefined') return;
  try {
    ctx = new AudioContext();
  } catch {
    ctx = null;
  }
}

function tone(freq: number, start: number, dur: number, type: OscillatorType = 'sine', gain = 0.07) {
  if (!ctx) return;
  const t0 = ctx.currentTime + start;
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t0);
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(gain, t0 + 0.015);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  osc.connect(g).connect(ctx.destination);
  osc.start(t0);
  osc.stop(t0 + dur + 0.05);
}

export type Sfx = 'revealAgent' | 'revealWrong' | 'revealAssassin' | 'turn' | 'clue' | 'win' | 'lose' | 'timer';

export function play(s: Sfx) {
  if (muted || !ctx) return;
  if (ctx.state === 'suspended') void ctx.resume();
  switch (s) {
    case 'revealAgent':
      tone(660, 0, 0.12, 'triangle');
      tone(880, 0.08, 0.16, 'triangle');
      break;
    case 'revealWrong':
      tone(330, 0, 0.18, 'sine');
      tone(262, 0.1, 0.22, 'sine');
      break;
    case 'revealAssassin':
      tone(110, 0, 0.6, 'sawtooth', 0.05);
      tone(82, 0.15, 0.7, 'sine', 0.08);
      break;
    case 'turn':
      tone(523, 0, 0.1, 'sine', 0.05);
      tone(784, 0.09, 0.14, 'sine', 0.05);
      break;
    case 'clue':
      tone(988, 0, 0.08, 'square', 0.025);
      break;
    case 'win':
      [523, 659, 784, 1047].forEach((f, i) => tone(f, i * 0.11, 0.25, 'triangle'));
      break;
    case 'lose':
      [392, 330, 262].forEach((f, i) => tone(f, i * 0.16, 0.3, 'sine'));
      break;
    case 'timer':
      tone(1200, 0, 0.12, 'square', 0.03);
      tone(1200, 0.2, 0.12, 'square', 0.03);
      break;
  }
}
