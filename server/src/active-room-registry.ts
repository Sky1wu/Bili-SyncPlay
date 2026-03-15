import type { ActiveRoom, Session } from "./types.js";

export type ActiveRoomRegistry = {
  getRoom: (code: string) => ActiveRoom | null;
  getOrCreateRoom: (code: string) => ActiveRoom;
  addMember: (code: string, memberId: string, session: Session, memberToken: string) => ActiveRoom;
  findMemberIdByToken: (code: string, memberToken: string) => string | null;
  removeMember: (code: string, memberId: string, session?: Session) => { room: ActiveRoom | null; roomEmpty: boolean };
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
    addMember(code, memberId, session, memberToken) {
      const room = getOrCreateRoom(code);
      room.members.set(memberId, session);
      room.memberTokens.set(memberId, memberToken);
      return room;
    },
    findMemberIdByToken(code, memberToken) {
      const room = rooms.get(code) ?? null;
      if (!room) {
        return null;
      }

      for (const [memberId, token] of room.memberTokens.entries()) {
        if (token === memberToken) {
          return memberId;
        }
      }
      return null;
    },
    removeMember(code, memberId, session) {
      const room = rooms.get(code) ?? null;
      if (!room) {
        return { room: null, roomEmpty: true };
      }

      if (session) {
        const currentSession = room.members.get(memberId);
        if (currentSession && currentSession !== session) {
          return { room, roomEmpty: false };
        }
      }

      room.members.delete(memberId);
      room.memberTokens.delete(memberId);
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
