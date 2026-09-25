import { useCallback, useEffect, useReducer, useState } from 'react';
import type { Command } from '../../shared/protocol.ts';
import { api, ApiError } from '../api.ts';
import { RoomConnection, type EndReason } from '../connection.ts';
import { forgetRoom, rememberRoom } from '../recent.ts';
import { ConnectionOverlay, navigate, useToast } from '../ui.tsx';
import type { ClassConnection } from '../connection.ts';
import { useClassConnection, type ClassSend } from './Class.tsx';
import { GameScreen } from './Game.tsx';
import { Lobby } from './Lobby.tsx';

type Check = 'checking' | 'member' | 'notMember' | 'gone' | 'banned' | 'noSession' | 'network';

export type SendFn = (cmd: Command, okText?: string) => Promise<boolean>;

const END_TEXT: Record<EndReason, string> = {
  kicked: '방장이 이 방에서 내보냈습니다.',
  banned: '이 방에서 강퇴되어 다시 들어갈 수 없습니다.',
  gone: '방이 없어졌습니다. 방장이 방을 닫았거나 오래 쓰지 않아 정리되었습니다.',
  closed: '방장이 방을 닫았습니다.',
  expired: '오래 활동이 없어 방이 정리되었습니다.',
  protocol: '앱이 새 버전으로 바뀌었습니다. 새로고침해 주세요. 진행 중인 게임은 서버에 그대로 남아 있습니다.',
  replaced: '이 자리는 방장 승인으로 다른 브라우저에 넘어갔습니다.',
  notMember: '이 브라우저는 이 방의 참가자가 아닙니다.',
  noSession: '브라우저 쿠키(세션)가 없어졌습니다. 기존 자리를 자동으로 되찾을 수 없습니다.',
  classEnded: '수업이 끝났습니다.',
  removed: '이 방의 참가자 명단에서 빠졌습니다. 클래스로 돌아가 확인하세요.',
};

export function RoomScreen({ roomId }: { roomId: string }) {
  const [check, setCheck] = useState<Check>('checking');

  useEffect(() => {
    api.status(roomId).then(
      (s) => setCheck(s.status),
      (e: unknown) => setCheck(e instanceof ApiError && e.code === 'noSession' ? 'noSession' : 'network'),
    );
  }, [roomId]);

  if (check === 'checking') return <div className="center-page">방을 확인하는 중…</div>;
  if (check === 'member') return <ConnectedRoom roomId={roomId} />;
  const reason: EndReason = check === 'network' ? 'gone' : check;
  if (check === 'network')
    return (
      <EndPage roomId={roomId} text="서버에 연결하지 못했습니다. 인터넷 연결을 확인하고 다시 시도하세요." retry />
    );
  return <EndPage roomId={roomId} text={END_TEXT[reason]} lost={check === 'notMember' || check === 'noSession'} />;
}

function EndPage({ roomId, text, retry, lost, classId }: { roomId: string; text: string; retry?: boolean; lost?: boolean; classId?: string | null }) {
  useEffect(() => {
    if (!retry && !lost) forgetRoom(roomId);
  }, [roomId, retry, lost]);
  return (
    <div className="center-page">
      <div className="panel narrow">
        <p>{text}</p>
        {lost && (
          <p className="muted small">
            이미 참가하던 방이라면 방장에게 받은 초대 링크로 새로 들어온 뒤, 방장에게 ‘자리 재지정’을 부탁하세요. 이미 정답을 본 사람은 같은 게임에서 추측자 자리로 옮길 수 없습니다.
          </p>
        )}
        <div className="modal-actions">
          {classId && (
            <button type="button" className="btn btn-primary" onClick={() => navigate(`/c/${classId}`)}>
              클래스로 돌아가기
            </button>
          )}
          {retry && (
            <button type="button" className="btn btn-primary" onClick={() => location.reload()}>
              다시 시도
            </button>
          )}
          <button type="button" className="btn" onClick={() => navigate('/')}>
            처음 화면으로
          </button>
        </div>
      </div>
    </div>
  );
}

function ConnectedRoom({ roomId }: { roomId: string }) {
  const [conn, setConn] = useState<RoomConnection | null>(null);
  const [, force] = useReducer((x: number) => x + 1, 0);
  const toast = useToast();

  useEffect(() => {
    const c = new RoomConnection(roomId);
    setConn(c);
    const un = c.subscribe(force);
    return () => {
      un();
      c.dispose();
    };
  }, [roomId]);

  const room = conn?.room ?? null;
  const [classId, setClassId] = useState<string | null>(null);
  useEffect(() => {
    if (room && !room.classMode && !room.solo) rememberRoom(roomId, room.you.nickname);
    if (room?.classMode) setClassId(room.classMode.classId);
  }, [roomId, room?.you.nickname, room]);
  // 학급 방: 클래스 연결 하나 (공지 받기, 방장·선생님의 봇 넣기·빼기는 좌석을 정하는 클래스에 보낸다)
  const classConn = useClassConnection(classId);
  const classSend: ClassSend = useCallback(
    async (cmd, okText) => {
      if (!classConn) return false;
      const ack = await classConn.send(cmd);
      if (!ack.ok) {
        toast(ack.message ?? '처리하지 못했습니다.', 'error');
        return false;
      }
      if (okText) toast(okText);
      return true;
    },
    [classConn, toast],
  );

  useEffect(() => {
    if (conn?.lastError) {
      toast(conn.lastError, 'error');
      conn.lastError = null;
    }
  });

  const send: SendFn = useCallback(
    async (cmd, okText) => {
      if (!conn) return false;
      const ack = await conn.send(cmd);
      if (!ack.ok) {
        if (ack.code === 'staleRevision' || ack.code === 'staleGame') toast('다른 사람이 먼저 움직였습니다. 최신 화면을 확인하고 다시 선택하세요.', 'error');
        else toast(ack.message ?? '처리하지 못했습니다.', 'error');
        return false;
      }
      if (okText) toast(okText);
      return true;
    },
    [conn, toast],
  );

  if (!conn) return <div className="center-page">연결하는 중…</div>;
  if (conn.status === 'ended') {
    const r = conn.endReason ?? 'closed';
    if (r === 'protocol')
      return (
        <div className="center-page">
          <div className="panel narrow">
            <p>{END_TEXT.protocol}</p>
            <button type="button" className="btn btn-primary" onClick={() => location.reload()}>
              새로고침
            </button>
          </div>
        </div>
      );
    const text = classId && r === 'closed' ? '이 게임방이 닫혔습니다. 클래스로 돌아가 다른 방을 고르세요.' : END_TEXT[r];
    return <EndPage roomId={roomId} text={text} lost={!classId && (r === 'notMember' || r === 'noSession')} classId={classId} />;
  }
  if (!room) return <ConnectionOverlay conn={conn} fullPage />;

  return (
    <>
      {room.game ? <GameScreen room={room} conn={conn} send={send} /> : <Lobby room={room} send={send} conn={conn} classSend={classSend} />}
      <ConnectionOverlay conn={conn} />
      {room.classMode && !room.classMode.isTeacher && classConn && <ClassFeed conn={classConn} />}
    </>
  );
}

/**
 * 학급 방에 있는 학생은 클래스 연결도 하나 유지한다(학생당 클래스 1 + 자기 방 1).
 * 게임 중에도 선생님의 운영 공지를 받는다. 클래스 전체 채팅은 없다.
 */
function ClassFeed({ conn }: { conn: ClassConnection }) {
  const latest = conn.view?.announcements.at(-1);
  const [seen, setSeen] = useState<number | null>(null);
  const toast = useToast();
  useEffect(() => {
    if (!latest) return;
    if (seen === null) {
      setSeen(latest.id); // 들어오기 전 공지는 다시 띄우지 않는다
      return;
    }
    if (latest.id !== seen) {
      setSeen(latest.id);
      toast(`📢 선생님 공지: ${latest.text}`);
    }
  }, [latest, seen, toast]);
  if (!latest) return null;
  return (
    <div className="class-feed" role="status" aria-live="polite">
      📢 {latest.text}
    </div>
  );
}

