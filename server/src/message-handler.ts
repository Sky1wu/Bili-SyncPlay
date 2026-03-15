import type { ClientMessage } from "@bili-syncplay/protocol";
import { consumeFixedWindow, consumeTokenBucket, WINDOW_10_SECONDS_MS, WINDOW_MINUTE_MS } from "./rate-limit.js";
import { roomStateOf } from "./room-store.js";
import { RoomServiceError } from "./room-service.js";
import type { LogEvent, SendError, SendMessage, Session } from "./types.js";

export function createMessageHandler(options: {
  config: {
    maxMembersPerRoom: number;
    rateLimits: {
      roomCreatePerMinute: number;
      roomJoinPerMinute: number;
      videoSharePer10Seconds: number;
      playbackUpdatePerSecond: number;
      playbackUpdateBurst: number;
      syncRequestPer10Seconds: number;
      syncPingPerSecond: number;
      syncPingBurst: number;
    };
  };
  roomService: {
    createRoomForSession: (session: Session, displayName?: string) => Promise<{ room: { code: string; joinToken: string }; memberToken: string }>;
    joinRoomForSession: (
      session: Session,
      roomCode: string,
      joinToken: string,
      displayName?: string,
      previousMemberToken?: string
    ) => Promise<{ room: { code: string }; memberToken: string }>;
    leaveRoomForSession: (session: Session) => Promise<{ room: { code: string } | null }>;
    shareVideoForSession: (
      session: Session,
      memberToken: string,
      video: ClientMessage extends never ? never : Extract<ClientMessage, { type: "video:share" }>["payload"]["video"],
      playback?: ClientMessage extends never ? never : Extract<ClientMessage, { type: "video:share" }>["payload"]["playback"]
    ) => Promise<{ room: { code: string } }>;
    updatePlaybackForSession: (
      session: Session,
      memberToken: string,
      playback: Extract<ClientMessage, { type: "playback:update" }>["payload"]["playback"]
    ) => Promise<{ room: { code: string } | null; ignored: boolean }>;
    getRoomStateForSession: (session: Session, memberToken: string, messageType: ClientMessage["type"]) => Promise<ReturnType<typeof roomStateOf>>;
    getActiveRoom: (roomCode: string) => { members: Map<string, Session> } | null;
  };
  logEvent: LogEvent;
  send: SendMessage;
  sendError: SendError;
  now?: () => number;
}): {
  handleClientMessage: (session: Session, message: ClientMessage) => Promise<void>;
  leaveRoom: (session: Session) => Promise<void>;
} {
  const { config, roomService, logEvent, send, sendError } = options;
  const now = options.now ?? Date.now;

  async function broadcastRoomState(roomCode: string): Promise<void> {
    const activeRoom = roomService.getActiveRoom(roomCode);
    if (!activeRoom || activeRoom.members.size === 0) {
      return;
    }

    const firstMember = activeRoom.members.values().next().value as Session | undefined;
    if (!firstMember?.memberToken) {
      return;
    }

    const roomState = await roomService.getRoomStateForSession(firstMember, firstMember.memberToken, "sync:request");
    for (const member of activeRoom.members.values()) {
      send(member.socket, {
        type: "room:state",
        payload: roomState
      });
    }
  }

  async function leaveRoom(session: Session): Promise<void> {
    const roomCode = session.roomCode;
    const { room } = await roomService.leaveRoomForSession(session);
    if (!roomCode || !room) {
      return;
    }

    await broadcastRoomState(roomCode);
  }

  function handleRateLimitedMessage(session: Session, messageType: string): void {
    logEvent("rate_limited", {
      sessionId: session.id,
      roomCode: session.roomCode,
      remoteAddress: session.remoteAddress,
      origin: session.origin,
      messageType,
      result: "rejected"
    });
  }

  async function handleClientMessage(session: Session, message: ClientMessage): Promise<void> {
    const currentTime = now();

    try {
      switch (message.type) {
        case "room:create": {
          if (!consumeFixedWindow(session.rateLimitState.roomCreate, config.rateLimits.roomCreatePerMinute, WINDOW_MINUTE_MS, currentTime)) {
            handleRateLimitedMessage(session, message.type);
            sendError(session.socket, "rate_limited", "请求过于频繁。");
            return;
          }

          const { room, memberToken } = await roomService.createRoomForSession(session, message.payload?.displayName);
          send(session.socket, {
            type: "room:created",
            payload: {
              roomCode: room.code,
              memberId: session.memberId ?? session.id,
              joinToken: room.joinToken,
              memberToken
            }
          });
          await broadcastRoomState(room.code);
          logEvent("room_created", {
            sessionId: session.id,
            roomCode: room.code,
            remoteAddress: session.remoteAddress,
            origin: session.origin,
            result: "ok"
          });
          return;
        }
        case "room:join": {
          if (!consumeFixedWindow(session.rateLimitState.roomJoin, config.rateLimits.roomJoinPerMinute, WINDOW_MINUTE_MS, currentTime)) {
            handleRateLimitedMessage(session, message.type);
            sendError(session.socket, "rate_limited", "请求过于频繁。");
            return;
          }

          const { room, memberToken } = await roomService.joinRoomForSession(
            session,
            message.payload.roomCode,
            message.payload.joinToken,
            message.payload.displayName,
            message.payload.memberToken
          );
          send(session.socket, {
            type: "room:joined",
            payload: {
              roomCode: room.code,
              memberId: session.memberId ?? session.id,
              memberToken
            }
          });
          await broadcastRoomState(room.code);
          logEvent("room_joined", {
            sessionId: session.id,
            roomCode: room.code,
            remoteAddress: session.remoteAddress,
            origin: session.origin,
            result: "ok"
          });
          return;
        }
        case "room:leave": {
          if (message.payload?.memberToken && session.memberToken && message.payload.memberToken !== session.memberToken) {
            sendError(session.socket, "member_token_invalid", "成员令牌无效。");
            return;
          }
          await leaveRoom(session);
          return;
        }
        case "video:share": {
          if (!consumeFixedWindow(session.rateLimitState.videoShare, config.rateLimits.videoSharePer10Seconds, WINDOW_10_SECONDS_MS, currentTime)) {
            handleRateLimitedMessage(session, message.type);
            sendError(session.socket, "rate_limited", "请求过于频繁。");
            return;
          }

          const { room } = await roomService.shareVideoForSession(
            session,
            message.payload.memberToken,
            message.payload.video,
            message.payload.playback
          );
          await broadcastRoomState(room.code);
          return;
        }
        case "playback:update": {
          if (
            !consumeTokenBucket(
              session.rateLimitState.playbackUpdate,
              config.rateLimits.playbackUpdatePerSecond,
              config.rateLimits.playbackUpdateBurst,
              currentTime
            )
          ) {
            handleRateLimitedMessage(session, message.type);
            return;
          }

          const result = await roomService.updatePlaybackForSession(session, message.payload.memberToken, message.payload.playback);
          if (!result.ignored && result.room) {
            await broadcastRoomState(result.room.code);
          }
          return;
        }
        case "sync:request": {
          if (!consumeFixedWindow(session.rateLimitState.syncRequest, config.rateLimits.syncRequestPer10Seconds, WINDOW_10_SECONDS_MS, currentTime)) {
            handleRateLimitedMessage(session, message.type);
            sendError(session.socket, "rate_limited", "请求过于频繁。");
            return;
          }

          const state = await roomService.getRoomStateForSession(session, message.payload.memberToken, message.type);
          send(session.socket, {
            type: "room:state",
            payload: state
          });
          return;
        }
        case "sync:ping": {
          if (
            !consumeTokenBucket(
              session.rateLimitState.syncPing,
              config.rateLimits.syncPingPerSecond,
              config.rateLimits.syncPingBurst,
              currentTime
            )
          ) {
            handleRateLimitedMessage(session, message.type);
            return;
          }

          send(session.socket, {
            type: "sync:pong",
            payload: {
              clientSendTime: message.payload.clientSendTime,
              serverReceiveTime: currentTime,
              serverSendTime: now()
            }
          });
          return;
        }
        default: {
          const exhaustiveCheck: never = message;
          return exhaustiveCheck;
        }
      }
    } catch (error) {
      if (error instanceof RoomServiceError) {
        sendError(session.socket, error.code, error.message);
        if (error.reason === "internal_error") {
          logEvent("room_persist_failed", {
            sessionId: session.id,
            roomCode: session.roomCode,
            remoteAddress: session.remoteAddress,
            origin: session.origin,
            result: "error",
            reason: error.reason
          });
        }
        return;
      }

      throw error;
    }
  }

  return {
    handleClientMessage,
    leaveRoom
  };
}
