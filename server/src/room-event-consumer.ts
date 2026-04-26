import { hasAttachedSocket, type SendMessage, type Session } from "./types.js";
import type { RoomEventBus, RoomEventBusMessage } from "./room-event-bus.js";
import type { ServerMessage } from "@bili-syncplay/protocol";

const MEMBER_DELTA_PROTOCOL_VERSION = 2;

function supportsIncrementalMemberEvents(session: Session): boolean {
  return (session.protocolVersion ?? 1) >= MEMBER_DELTA_PROTOCOL_VERSION;
}

function createMemberMessage(
  message: RoomEventBusMessage,
): ServerMessage | null {
  if (message.type === "room_member_joined") {
    return {
      type: "room:member-joined",
      payload: {
        roomCode: message.roomCode,
        member: {
          id: message.memberId,
          name: message.displayName,
        },
      },
    };
  }
  if (message.type === "room_member_left") {
    return {
      type: "room:member-left",
      payload: {
        roomCode: message.roomCode,
        member: {
          id: message.memberId,
          name: message.displayName,
        },
      },
    };
  }
  return null;
}

export async function createRoomEventConsumer(options: {
  roomEventBus: RoomEventBus;
  getRoomStateByCode: (
    roomCode: string,
  ) => Promise<import("./types.js").RoomStoreRoomState | null>;
  listLocalSessionsByRoom: (roomCode: string) => Session[];
  send: SendMessage;
  instanceId?: string;
  logEvent?: import("./types.js").LogEvent;
}): Promise<{ close: () => Promise<void> }> {
  const unsubscribe = await options.roomEventBus.subscribe(async (message) => {
    try {
      const localSessions = options.listLocalSessionsByRoom(message.roomCode);
      if (
        message.type === "room_member_joined" ||
        message.type === "room_member_left"
      ) {
        const memberMessage = createMemberMessage(message);
        if (!memberMessage) {
          return;
        }
        let legacyRoomState:
          | Awaited<ReturnType<typeof options.getRoomStateByCode>>
          | undefined;
        for (const session of localSessions) {
          if (
            !hasAttachedSocket(session) ||
            session.memberId === message.memberId
          ) {
            continue;
          }
          if (supportsIncrementalMemberEvents(session)) {
            options.send(session.socket, memberMessage);
            continue;
          }

          legacyRoomState ??= await options.getRoomStateByCode(
            message.roomCode,
          );
          if (legacyRoomState) {
            options.send(session.socket, {
              type: "room:state",
              payload: legacyRoomState,
            });
          }
        }

        options.logEvent?.("room_event_consumed", {
          roomCode: message.roomCode,
          eventType: message.type,
          sourceInstanceId: message.sourceInstanceId,
          instanceId: options.instanceId ?? null,
          localSessionCount: localSessions.length,
          result: "ok",
        });
        return;
      }

      const state =
        message.type === "room_deleted"
          ? {
              roomCode: message.roomCode,
              sharedVideo: null,
              playback: null,
              members: [],
            }
          : await options.getRoomStateByCode(message.roomCode);
      if (!state) {
        return;
      }

      for (const session of localSessions) {
        if (!hasAttachedSocket(session)) {
          continue;
        }
        options.send(session.socket, {
          type: "room:state",
          payload: state,
        });
      }

      options.logEvent?.("room_event_consumed", {
        roomCode: message.roomCode,
        eventType: message.type,
        sourceInstanceId: message.sourceInstanceId,
        instanceId: options.instanceId ?? null,
        localSessionCount: localSessions.length,
        result: "ok",
      });
    } catch (error) {
      options.logEvent?.("room_event_consume_failed", {
        roomCode: message.roomCode,
        eventType: message.type,
        sourceInstanceId: message.sourceInstanceId,
        instanceId: options.instanceId ?? null,
        result: "error",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  return {
    async close() {
      await unsubscribe();
    },
  };
}
