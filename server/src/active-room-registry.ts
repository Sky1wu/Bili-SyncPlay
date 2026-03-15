import type { ActiveRoom, Session } from "./types.js";

export type ActiveRoomRegistry = {
  getRoom: (code: string) => ActiveRoom | null;
  getOrCreateRoom: (code: string) => ActiveRoom;
  addMember: (code: string, session: Session, memberToken: string) => ActiveRoom;
  removeMember: (code: string, sessionId: string) => { room: ActiveRoom | null; roomEmpty: boolean };
  deleteRoom: (code: string) => void;
};

export function createActiveRoomRegistry(): ActiveRoomRegistry {
  const rooms = new Map<string, ActiveRoom>();

  function getOrCreateRoom(code: string): ActiveRoom {
    const existingRoom = rooms.get(code);
    if (existingRoom) {
      return existingRoom;
    }

    const room: ActiveRoom = {
      code,
      members: new Map(),
      memberTokens: new Map()
    };
    rooms.set(code, room);
    return room;
  }

  return {
    getRoom(code) {
      return rooms.get(code) ?? null;
    },
    getOrCreateRoom,
    addMember(code, session, memberToken) {
      const room = getOrCreateRoom(code);
      room.members.set(session.id, session);
      room.memberTokens.set(session.id, memberToken);
      return room;
    },
    removeMember(code, sessionId) {
      const room = rooms.get(code) ?? null;
      if (!room) {
        return { room: null, roomEmpty: true };
      }

      room.members.delete(sessionId);
      room.memberTokens.delete(sessionId);
      const roomEmpty = room.members.size === 0;
      if (roomEmpty) {
        rooms.delete(code);
      }
      return { room: roomEmpty ? null : room, roomEmpty };
    },
    deleteRoom(code) {
      rooms.delete(code);
    }
  };
}
