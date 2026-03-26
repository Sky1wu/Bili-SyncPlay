import type { GlobalEventStore } from "./global-event-store.js";
import type { RuntimeRegistry } from "./runtime-registry.js";
import type { RoomStore } from "../room-store.js";
import type { PersistenceConfig } from "../types.js";

export function createAdminOverviewService(options: {
  instanceId: string;
  serviceName: string;
  serviceVersion: string;
  persistenceConfig: PersistenceConfig;
  roomStore: RoomStore;
  runtimeRegistry: RuntimeRegistry;
  eventStore: GlobalEventStore;
  now?: () => number;
}) {
  const now = options.now ?? Date.now;

  return {
    async getOverview() {
      const currentTime = now();
      const totalNonExpired = await options.roomStore.countRooms({
        keyword: undefined,
        includeExpired: false,
      });
      const activeRoomCount = options.runtimeRegistry.getActiveRoomCount();
      const activeMemberCount = options.runtimeRegistry.getActiveMemberCount();

      return {
        service: {
          instanceId: options.instanceId,
          name: options.serviceName,
          version: options.serviceVersion,
          startedAt: options.runtimeRegistry.getStartedAt(),
          uptimeMs: currentTime - options.runtimeRegistry.getStartedAt(),
        },
        storage: {
          provider: options.persistenceConfig.provider,
          redisConnected:
            options.persistenceConfig.provider === "redis"
              ? await options.roomStore.isReady()
              : true,
        },
        runtime: {
          connectionCount: options.runtimeRegistry.getConnectionCount(),
          activeRoomCount,
          activeMemberCount,
        },
        rooms: {
          totalNonExpired,
          active: activeRoomCount,
          idle: Math.max(0, totalNonExpired - activeRoomCount),
        },
        events: {
          lastMinute: {
            room_created: 0,
            room_joined: 0,
            rate_limited: 0,
            ws_connection_rejected: 0,
            error: 0,
            ...options.runtimeRegistry.getRecentEventCounts(currentTime),
          },
          totals: {
            room_created: 0,
            room_joined: 0,
            ws_connection_rejected: 0,
            rate_limited: 0,
            ...options.runtimeRegistry.getLifetimeEventCounts(),
          },
        },
      };
    },
  };
}
