// 게임방 연결과 클래스 연결. 재접속·outbox 는 live.ts 공용 부품이 한다.

import { CLOSE } from '../shared/constants.ts';
import type { ClassCommand } from '../shared/class-protocol.ts';
import { CLASS_PROTOCOL_VERSION, type ClassView } from '../shared/classroom.ts';
import type { Command } from '../shared/protocol.ts';
import { PROTOCOL_VERSION, type RoomView } from '../shared/view.ts';
import { api } from './api.ts';
import { LiveConnection, type Ack } from './live.ts';

export type { Ack, ConnStatus, EndReason } from './live.ts';

export class RoomConnection extends LiveConnection<RoomView> {
  constructor(roomId: string) {
    super({
      path: `/api/rooms/${encodeURIComponent(roomId)}/ws`,
      protocol: PROTOCOL_VERSION,
      viewMessage: 't:state/room',
      idField: 'commandId',
      closeCodes: { [CLOSE.kicked]: 'kicked', [CLOSE.gone]: 'gone', [CLOSE.expired]: 'expired', [CLOSE.protocol]: 'protocol', [CLOSE.replaced]: 'replaced', [CLOSE.removed]: 'removed' },
      statusCheck: async () => (await api.status(roomId)).status,
      serverNowOf: (v) => v.serverNow,
    });
  }

  get room(): RoomView | null {
    return this.view;
  }

  /** 명령 전송. 게임 명령은 현재 화면의 gameId·revision 을 함께 보낸다. */
  send(cmd: Command): Promise<Ack> {
    const game = this.view?.game;
    return this.sendFrame((commandId) => ({
      t: 'cmd',
      commandId,
      gameId: cmd.type === 'game' ? (game?.gameId ?? null) : null,
      expectedRevision: cmd.type === 'game' ? (game?.revision ?? 0) : undefined,
      cmd,
    }));
  }
}

export class ClassConnection extends LiveConnection<ClassView> {
  constructor(classId: string) {
    super({
      path: `/api/classes/${encodeURIComponent(classId)}/ws`,
      protocol: CLASS_PROTOCOL_VERSION,
      viewMessage: 't:class/view',
      idField: 'opId',
      closeCodes: { 4403: 'kicked', 4404: 'gone', 4410: 'classEnded', 4426: 'protocol', 4409: 'replaced' },
      statusCheck: async () => {
        const s = (await api.classStatus(classId)).status;
        return s === 'teacher' ? 'member' : s;
      },
      serverNowOf: (v) => v.serverNow,
    });
  }

  send(cmd: ClassCommand): Promise<Ack> {
    return this.sendFrame((opId) => ({ t: 'cmd', opId, cmd }));
  }
}
