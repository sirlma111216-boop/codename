import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { CardView, GameView } from '../../shared/view.ts';
import { COLS, coord, IDENTITY_MARK, IDENTITY_NAME, IDENTITY_SHORT } from '../labels.ts';
import { COVER_SIZES, coverImageName, fallbackColor, imageSrcSet, imageUrl, type AssetManifest } from '../theme.ts';

export interface BoardProps {
  game: GameView;
  manifest: AssetManifest | null;
  showKey: boolean;
  /** 이 카드를 지금 고를 수 있는가 (추측·벌칙·가상 상대) */
  selectable: (card: CardView) => boolean;
  selected: number | null;
  onSelect: (index: number) => void;
  onActivate?: (index: number) => void;
  large?: boolean;
}

function lengthClass(word: string): string {
  const n = [...word].length;
  if (n <= 2) return 'w-2';
  if (n <= 3) return 'w-3';
  if (n <= 4) return 'w-4';
  if (n <= 6) return 'w-6';
  if (n <= 9) return 'w-9';
  return 'w-long';
}

export function Board({ game, manifest, showKey, selectable, selected, onSelect, onActivate, large }: BoardProps) {
  const [focus, setFocus] = useState(0);
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  // 처음 그릴 때 이미 공개된 카드는 연출 없이, 그 뒤에 공개된 카드만 덮개 연출을 한다.
  const seen = useRef<{ gameId: string; set: Set<number> } | null>(null);
  if (!seen.current || seen.current.gameId !== game.gameId) {
    seen.current = { gameId: game.gameId, set: new Set(game.cards.filter((c) => c.revealed).map((c) => c.index)) };
  }
  const fresh = game.cards.filter((c) => c.revealed && !seen.current?.set.has(c.index)).map((c) => c.index);
  useEffect(() => {
    const t = window.setTimeout(() => {
      for (const i of fresh) seen.current?.set.add(i);
    }, 400);
    return () => window.clearTimeout(t);
  });

  const front = imageUrl(manifest, 'word-card-front');

  const move = (e: KeyboardEvent<HTMLDivElement>) => {
    const key = e.key;
    let next: number;
    if (key === 'ArrowRight') next = Math.min(24, focus + 1);
    else if (key === 'ArrowLeft') next = Math.max(0, focus - 1);
    else if (key === 'ArrowDown') next = Math.min(24, focus + 5);
    else if (key === 'ArrowUp') next = Math.max(0, focus - 5);
    else if (key === 'Home') next = focus - (focus % 5);
    else if (key === 'End') next = focus - (focus % 5) + 4;
    else return;
    e.preventDefault();
    setFocus(next);
    refs.current[next]?.focus();
  };

  return (
    <div className={`board-wrap ${large ? 'board-large' : ''}`}>
      <div className="board-cols" aria-hidden="true">
        {COLS.map((c) => (
          <span key={c}>{c}</span>
        ))}
      </div>
      <div className="board-rows" aria-hidden="true">
        {[1, 2, 3, 4, 5].map((r) => (
          <span key={r}>{r}</span>
        ))}
      </div>
      <div className="board" role="group" aria-label="단어판 5×5. 화살표 키로 이동" onKeyDown={move}>
        {game.cards.map((card) => {
          const r = card.revealed;
          const can = !r && selectable(card);
          const keyId = showKey && !r ? card.key : undefined;
          // 접근성 이름: 공개 전에는 정체를 넣지 않는다 (스파이마스터 화면에서만 키를 읽어 준다)
          let label = `${coord(card.index)} ${card.word}`;
          if (r) label += `, 공개됨: ${IDENTITY_NAME[r.identity]}`;
          else if (keyId) label += `, 키: ${IDENTITY_NAME[keyId]}`;
          if (selected === card.index) label += ', 선택됨';
          const coverName = r ? coverImageName(manifest, r.cover, game.gameId) : null;
          const coverUrl = coverName ? imageUrl(manifest, coverName) : null;
          const cls = [
            'card',
            r ? `revealed revealed-${r.identity}` : 'hidden',
            keyId ? `key-${keyId}` : '',
            can ? 'selectable' : '',
            selected === card.index ? 'selected' : '',
            fresh.includes(card.index) ? 'cover-new' : '',
            game.phase === 'finished' && !r && card.key ? `final-${card.key}` : '',
          ]
            .filter(Boolean)
            .join(' ');
          return (
            <button
              key={card.index}
              ref={(el) => {
                refs.current[card.index] = el;
              }}
              type="button"
              className={cls}
              data-index={card.index}
              tabIndex={card.index === focus ? 0 : -1}
              aria-label={label}
              aria-pressed={selected === card.index}
              aria-disabled={!can}
              onFocus={() => setFocus(card.index)}
              onClick={() => {
                if (!can) return;
                if (selected === card.index && onActivate) onActivate(card.index);
                else onSelect(card.index);
              }}
            >
              <span className="card-face" style={front ? { backgroundImage: `url(${front})` } : undefined}>
                <span className={`card-word ${lengthClass(card.word)}`}>{card.word}</span>
                {keyId && (
                  <span className={`key-chip key-chip-${keyId}`} aria-hidden="true">
                    {IDENTITY_MARK[keyId]} {IDENTITY_SHORT[keyId]}
                  </span>
                )}
                {game.phase === 'finished' && !r && card.key && (
                  <span className={`key-chip key-chip-${card.key}`} aria-hidden="true">
                    {IDENTITY_MARK[card.key]} {IDENTITY_SHORT[card.key]}
                  </span>
                )}
              </span>
              {r && (
                <span className="card-cover" style={{ backgroundColor: fallbackColor(manifest, coverName ?? '', '#333') }} aria-hidden="true">
                  {coverUrl && <img src={coverUrl} srcSet={imageSrcSet(manifest, coverName ?? '')} sizes={COVER_SIZES} alt="" decoding="async" />}
                  <span className={`cover-chip cover-chip-${r.identity}`}>
                    {IDENTITY_MARK[r.identity]} {IDENTITY_SHORT[r.identity]}
                  </span>
                </span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
