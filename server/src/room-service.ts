import { normalizeBilibiliUrl, type ClientMessage, type ErrorCode, type PlaybackState, type SharedVideo } from "@bili-syncplay/protocol";
import type { ActiveRoomRegistry } from "./active-room-registry";
import { createRoomCode, roomStateOf, type RoomStore } from "./room-store";
import type { LogEvent, PersistenceConfig, PersistedRoom, SecurityConfig, Session } from "./types";

const PAUSE_DOMINANCE_WINDOW_MS = 400;
const MAX_VERSION_RETRIES = 3;

type ServiceErrorReason =
  | "room_not_found"
  | "join_token_invalid"
  | "member_token_invalid"
  | "not_in_room"
  | "room_full"
  | "invalid_message"
  | "internal_error";

export class RoomServiceError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly reason: ServiceErrorReason,
    readonly details: Record<string, unknown> = {}
  ) {
    super(message);
  }
}

type JoinedRoomAccess = {
  session: Session;
  persistedRoom: PersistedRoom;
  activeRoom: ReturnType<ActiveRoomRegistry["getOrCreateRoom"]>;
};

export function createRoomService(options: {
  config: SecurityConfig;
  persistence: PersistenceConfig;
  roomStore: RoomStore;
  activeRooms: ActiveRoomRegistry;
  createRoomCode?: () => string;
  generateToken: () => string;
  logEvent: LogEvent;
  now?: () => number;
}): {
  createRoomForSession: (session: Session, displayName?: string) => Promise<{ room: PersistedRoom; memberToken: string }>;
  joinRoomForSession: (session: Session, roomCode: string, joinToken: string, displayName?: string) => Promise<{ room: PersistedRoom; memberToken: string }>;
  leaveRoomForSession: (session: Session) => Promise<{ room: PersistedRoom | null }>;
  shareVideoForSession: (session: Session, memberToken: string, video: SharedVideo) => Promise<{ room: PersistedRoom }>;
  updatePlaybackForSession: (
    session: Session,
    memberToken: string,
    playback: PlaybackState
  ) => Promise<{ room: PersistedRoom | null; ignored: boolean }>;
  getRoomStateForSession: (session: Session, memberToken: string, messageType: ClientMessage["type"]) => Promise<ReturnType<typeof roomStateOf>>;
  getActiveRoom: (roomCode: string) => ReturnType<ActiveRoomRegistry["getRoom"]>;
  getRoomStateByCode: (roomCode: string) => Promise<ReturnType<typeof roomStateOf> | null>;
  deleteExpiredRooms: (currentTime?: number) => Promise<number>;
} {
  const { config, persistence, roomStore, activeRooms, generateToken, logEvent } = options;
  const now = options.now ?? Date.now;
  const nextRoomCode = options.createRoomCode ?? createRoomCode;

  function setSessionDisplayName(session: Session, displayName?: string): void {
    session.displayName = displayName?.trim() || session.displayName;
  }

  function clearSessionRoom(session: Session): void {
    session.roomCode = null;
    session.memberToken = null;
    session.joinedAt = null;
  }

  async function resolveRoom(code: string): Promise<PersistedRoom | null> {
    const room = await roomStore.getRoom(code);
    if (!room) {
      return null;
    }
    if (room.expiresAt !== null && room.expiresAt <= now()) {
      await roomStore.deleteRoom(code);
      activeRooms.deleteRoom(code);
      return null;
    }
    return room;
  }

  function requireMemberToken(
    activeRoom: ReturnType<ActiveRoomRegistry["getOrCreateRoom"]>,
    session: Session,
    memberToken: string,
    messageType: ClientMessage["type"]
  ): void {
    if (!session.memberToken || memberToken !== session.memberToken || activeRoom.memberTokens.get(session.id) !== session.memberToken) {
      logEvent("auth_failed", {
        sessionId: session.id,
        roomCode: session.roomCode,
        remoteAddress: session.remoteAddress,
        origin: session.origin,
        messageType,
        result: "rejected",
        reason: "member_token_invalid"
      });
      throw new RoomServiceError("member_token_invalid", "Member token is invalid.", "member_token_invalid");
    }
  }

  async function requireJoinedRoomSession(
    session: Session,
    memberToken: string,
    messageType: ClientMessage["type"]
  ): Promise<JoinedRoomAccess> {
    if (!session.roomCode) {
      logEvent("auth_failed", {
        sessionId: session.id,
        roomCode: null,
        remoteAddress: session.remoteAddress,
        origin: session.origin,
        messageType,
        result: "rejected",
        reason: "not_in_room"
      });
      throw new RoomServiceError("not_in_room", "You must join a room first.", "not_in_room");
    }

    const persistedRoom = await resolveRoom(session.roomCode);
    if (!persistedRoom) {
      clearSessionRoom(session);
      logEvent("auth_failed", {
        sessionId: session.id,
        roomCode: session.roomCode,
        remoteAddress: session.remoteAddress,
        origin: session.origin,
        messageType,
        result: "rejected",
        reason: "room_not_found"
      });
      throw new RoomServiceError("room_not_found", "Room not found.", "room_not_found");
    }

    const activeRoom = activeRooms.getRoom(persistedRoom.code);
    if (!activeRoom || !activeRoom.members.has(session.id)) {
      clearSessionRoom(session);
      logEvent("auth_failed", {
        sessionId: session.id,
        roomCode: persistedRoom.code,
        remoteAddress: session.remoteAddress,
        origin: session.origin,
        messageType,
        result: "rejected",
        reason: "member_token_invalid"
      });
      throw new RoomServiceError("member_token_invalid", "Member token is invalid.", "member_token_invalid");
    }

    requireMemberToken(activeRoom, session, memberToken, messageType);
    return { session, persistedRoom, activeRoom };
  }

  async function withVersionRetry(
    roomCode: string,
    action: (room: PersistedRoom) => Promise<PersistedRoom | null>
  ): Promise<PersistedRoom | null> {
    for (let attempt = 0; attempt < MAX_VERSION_RETRIES; attempt += 1) {
      const room = await resolveRoom(roomCode);
      if (!room) {
        return null;
      }

      const updatedRoom = await action(room);
      if (updatedRoom) {
        return updatedRoom;
      }
    }

    logEvent("room_version_conflict", {
      roomCode,
      result: "conflict"
    });
    return null;
  }

  function shouldIgnorePlaybackUpdate(room: PersistedRoom, nextPlayback: PlaybackState, currentTime: number): boolean {
    if (!room.playback) {
      return false;
    }

    const currentPlayback = room.playback;
    if (currentPlayback.actorId === nextPlayback.actorId) {
      return false;
    }
    const currentIsStopLike = currentPlayback.playState === "paused" || currentPlayback.playState === "buffering";
    const nextIsPlaying = nextPlayback.playState === "playing";
    const withinPauseWindow = currentTime - currentPlayback.serverTime < PAUSE_DOMINANCE_WINDOW_MS;
    const closeInTimeline = Math.abs(nextPlayback.currentTime - currentPlayback.currentTime) < 1.2;

    return currentIsStopLike && nextIsPlaying && withinPauseWindow && closeInTimeline;
  }

  async function leaveCurrentRoom(session: Session): Promise<{ room: PersistedRoom | null }> {
    if (!session.roomCode) {
      return { room: null };
    }

    const roomCode = session.roomCode;
    const removal = activeRooms.removeMember(roomCode, session.id);
    clearSessionRoom(session);

    const persistedRoom = await resolveRoom(roomCode);
    if (!persistedRoom) {
      return { room: null };
    }

    if (!removal.roomEmpty) {
      logEvent("room_left", {
        sessionId: session.id,
        roomCode,
        remoteAddress: session.remoteAddress,
        origin: session.origin,
        result: "ok"
      });
      return { room: persistedRoom };
    }

    const expiresAt = now() + persistence.emptyRoomTtlMs;
    const updatedRoom = await withVersionRetry(roomCode, async (room) => {
      const result = await roomStore.updateRoom(roomCode, room.version, {
        expiresAt,
        lastActiveAt: now()
      });
      if (!result.ok) {
        return null;
      }
      return result.room;
    });

    if (updatedRoom) {
      logEvent("room_expiry_scheduled", {
        roomCode,
        version: updatedRoom.version,
        expiresAt,
        result: "ok"
      });
    }

    logEvent("room_left", {
      sessionId: session.id,
      roomCode,
      remoteAddress: session.remoteAddress,
      origin: session.origin,
      result: "ok"
    });

    return { room: updatedRoom };
  }

  return {
    async createRoomForSession(session, displayName) {
      setSessionDisplayName(session, displayName);
      await leaveCurrentRoom(session);

      const createdAt = now();
      let room: PersistedRoom | null = null;
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const roomCode = nextRoomCode();
        try {
          room = await roomStore.createRoom({
            code: roomCode,
            joinToken: generateToken(),
            createdAt
          });
          break;
        } catch {
          room = null;
        }
      }
      if (!room) {
        logEvent("room_persist_failed", {
          sessionId: session.id,
          result: "error",
          reason: "room_create_conflict"
        });
        throw new RoomServiceError("internal_error", "Internal server error.", "internal_error");
      }

      const memberToken = generateToken();
      activeRooms.addMember(room.code, session, memberToken);
      session.roomCode = room.code;
      session.memberToken = memberToken;
      session.joinedAt = createdAt;

      logEvent("room_persisted", {
        roomCode: room.code,
        version: room.version,
        sessionId: session.id,
        provider: persistence.provider,
        result: "ok"
      });

      return { room, memberToken };
    },

    async joinRoomForSession(session, roomCode, joinToken, displayName) {
      setSessionDisplayName(session, displayName);
      await leaveCurrentRoom(session);

      const joinedRoom = await withVersionRetry(roomCode, async (room) => {
        if (room.joinToken !== joinToken) {
          logEvent("auth_failed", {
            sessionId: session.id,
            roomCode,
            remoteAddress: session.remoteAddress,
            origin: session.origin,
            messageType: "room:join",
            result: "rejected",
            reason: "join_token_invalid"
          });
          throw new RoomServiceError("join_token_invalid", "Join token is invalid.", "join_token_invalid");
        }

        const activeRoom = activeRooms.getRoom(roomCode);
        const activeMemberCount = activeRoom?.members.size ?? 0;
        if (activeMemberCount >= config.maxMembersPerRoom) {
          throw new RoomServiceError("room_full", "Room is full.", "room_full");
        }

        const result = await roomStore.updateRoom(roomCode, room.version, {
          expiresAt: null,
          lastActiveAt: now()
        });
        if (!result.ok) {
          return null;
        }
        return result.room;
      });

      if (!joinedRoom) {
        throw new RoomServiceError("room_not_found", "Room not found.", "room_not_found");
      }

      const memberToken = generateToken();
      activeRooms.addMember(joinedRoom.code, session, memberToken);
      session.roomCode = joinedRoom.code;
      session.memberToken = memberToken;
      session.joinedAt = now();

      logEvent("room_restored", {
        roomCode: joinedRoom.code,
        version: joinedRoom.version,
        sessionId: session.id,
        provider: persistence.provider,
        result: "ok"
      });

      return { room: joinedRoom, memberToken };
    },

    leaveRoomForSession: leaveCurrentRoom,

    async shareVideoForSession(session, memberToken, video) {
      const access = await requireJoinedRoomSession(session, memberToken, "video:share");
      const currentTime = now();

      const room = await withVersionRetry(access.persistedRoom.code, async (currentRoom) => {
        const result = await roomStore.updateRoom(currentRoom.code, currentRoom.version, {
          sharedVideo: {
            ...video,
            sharedByMemberId: session.id
          },
          playback: {
            url: video.url,
            currentTime: 0,
            playState: "paused",
            playbackRate: 1,
            updatedAt: currentTime,
            serverTime: currentTime,
            actorId: session.id,
            seq: 0
          },
          expiresAt: null,
          lastActiveAt: currentTime
        });
        if (!result.ok) {
          return null;
        }
        return result.room;
      });

      if (!room) {
        logEvent("room_persist_failed", {
          roomCode: access.persistedRoom.code,
          sessionId: session.id,
          provider: persistence.provider,
          result: "error",
          reason: "video_share_conflict"
        });
        throw new RoomServiceError("internal_error", "Internal server error.", "internal_error");
      }

      return { room };
    },

    async updatePlaybackForSession(session, memberToken, playback) {
      const access = await requireJoinedRoomSession(session, memberToken, "playback:update");
      if (!access.persistedRoom.sharedVideo) {
        throw new RoomServiceError("invalid_message", "No shared video exists for this room.", "invalid_message");
      }

      const sharedUrl = normalizeBilibiliUrl(access.persistedRoom.sharedVideo.url);
      const playbackUrl = normalizeBilibiliUrl(playback.url);
      if (!sharedUrl || !playbackUrl || sharedUrl !== playbackUrl) {
        throw new RoomServiceError("invalid_message", "Playback URL does not match the shared video.", "invalid_message");
      }

      const currentTime = now();
      const nextPlayback: PlaybackState = {
        ...playback,
        actorId: session.id,
        serverTime: currentTime
      };
      if (shouldIgnorePlaybackUpdate(access.persistedRoom, nextPlayback, currentTime)) {
        return { room: access.persistedRoom, ignored: true };
      }

      const result = await roomStore.updateRoom(access.persistedRoom.code, access.persistedRoom.version, {
        playback: nextPlayback,
        expiresAt: null,
        lastActiveAt: currentTime
      });
      if (!result.ok) {
        if (result.reason === "version_conflict") {
          logEvent("room_version_conflict", {
            roomCode: access.persistedRoom.code,
            version: access.persistedRoom.version,
            sessionId: session.id,
            result: "ignored"
          });
          return { room: null, ignored: true };
        }
        throw new RoomServiceError("room_not_found", "Room not found.", "room_not_found");
      }

      return { room: result.room, ignored: false };
    },

    async getRoomStateForSession(session, memberToken, messageType) {
      const access = await requireJoinedRoomSession(session, memberToken, messageType);
      const persistedRoom = await resolveRoom(access.persistedRoom.code);
      if (!persistedRoom) {
        throw new RoomServiceError("room_not_found", "Room not found.", "room_not_found");
      }
      return roomStateOf(persistedRoom, activeRooms.getRoom(persistedRoom.code));
    },

    getActiveRoom(roomCode) {
      return activeRooms.getRoom(roomCode);
    },

    async getRoomStateByCode(roomCode) {
      const room = await resolveRoom(roomCode);
      if (!room) {
        return null;
      }
      return roomStateOf(room, activeRooms.getRoom(roomCode));
    },

    async deleteExpiredRooms(currentTime = now()) {
      return await roomStore.deleteExpiredRooms(currentTime);
    }
  };
}
