import { useEffect, useRef, useState } from 'react';
import { CHAT_MAX } from '../../shared/constants.ts';
import type { RoomView } from '../../shared/view.ts';
import type { SendFn } from './Room.tsx';

export function Chat({ room, send, canSend, placeholder, disabledText }: { room: RoomView; send: SendFn; canSend: boolean; placeholder: string; disabledText?: string }) {
  const [text, setText] = useState('');
  const listRef = useRef<HTMLOListElement>(null);
  const last = room.chat.at(-1)?.id;
  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [last]);

  return (
    <div className="chat">
      <ol ref={listRef} className="chat-list" aria-label="메시지">
        {room.chat.length === 0 && <li className="muted small">아직 메시지가 없습니다.</li>}
        {room.chat.map((c) => (
          <li key={c.id} className={c.memberId === room.you.memberId ? 'mine' : ''}>
            <span className="chat-nick">{c.nickname}</span>
            <span className="chat-text">{c.text}</span>
          </li>
        ))}
      </ol>
      {canSend ? (
        <form
          className="chat-form"
          onSubmit={(e) => {
            e.preventDefault();
            const t = text.trim();
            if (!t) return;
            void send({ type: 'chat', text: t }).then((ok) => ok && setText(''));
          }}
        >
          <input value={text} onChange={(e) => setText(e.target.value)} maxLength={CHAT_MAX} placeholder={placeholder} aria-label={placeholder} />
          <button type="submit" className="btn btn-small">
            보내기
          </button>
        </form>
      ) : (
        <p className="muted small">{disabledText}</p>
      )}
    </div>
  );
}
