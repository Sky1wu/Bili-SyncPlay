import assert from "node:assert/strict";
import test from "node:test";
import { createAdminOverviewService } from "../src/admin/overview-service.js";
import { createEventStore } from "../src/admin/event-store.js";
import { createInMemoryRoomStore } from "../src/room-store.js";
import { createInMemoryRuntimeStore } from "../src/runtime-store.js";
import { getDefaultPersistenceConfig } from "../src/app.js";

test("overview counts only persisted non-expired active rooms and reports orphan runtime indexes", async () => {
  const now = Date.parse("2026-04-05T12:00:00.000Z");
  const roomStore = createInMemoryRoomStore({ now: () => now });
  const runtimeStore = createInMemoryRuntimeStore(() => now);
  const persistenceConfig = {
    ...getDefaultPersistenceConfig(),
    instanceId: "instance-a",
  };

  await roomStore.createRoom({
    code: "ROOM01",
    joinToken: "token-1",
    createdAt: now - 1_000,
  });

  runtimeStore.registerSession({
    id: "session-1",
    connectionState: "detached",
    socket: null,
    instanceId: "instance-a",
    remoteAddress: null,
    origin: null,
    roomCode: "ROOM01",
    memberId: "member-1",
    displayName: "Alice",
    memberToken: null,
    joinedAt: now - 800,
    invalidMessageCount: 0,
    rateLimitState: {
      roomCreate: { windowStart: 0, count: 0 },
      roomJoin: { windowStart: 0, count: 0 },
      videoShare: { windowStart: 0, count: 0 },
      playbackUpdate: { tokens: 0, lastRefillAt: 0 },
      syncRequest: { windowStart: 0, count: 0 },
      syncPing: { tokens: 0, lastRefillAt: 0 },
    },
  });
  runtimeStore.markSessionJoinedRoom("session-1", "ROOM01");

  runtimeStore.registerSession({
    id: "session-2",
    connectionState: "detached",
    socket: null,
    instanceId: "instance-b",
    remoteAddress: null,
    origin: null,
    roomCode: "GHOST1",
    memberId: "member-2",
    displayName: "Bob",
    memberToken: null,
    joinedAt: now - 500,
    invalidMessageCount: 0,
    rateLimitState: {
      roomCreate: { windowStart: 0, count: 0 },
      roomJoin: { windowStart: 0, count: 0 },
      videoShare: { windowStart: 0, count: 0 },
      playbackUpdate: { tokens: 0, lastRefillAt: 0 },
      syncRequest: { windowStart: 0, count: 0 },
      syncPing: { tokens: 0, lastRefillAt: 0 },
    },
  });
  runtimeStore.markSessionJoinedRoom("session-2", "GHOST1");

  const service = createAdminOverviewService({
    instanceId: persistenceConfig.instanceId,
    serviceName: "bili-syncplay-server",
    serviceVersion: "0.9.2-test",
    persistenceConfig,
    roomStore,
    runtimeStore,
    eventStore: createEventStore(),
    now: () => now,
  });

  const overview = await service.getOverview();
  assert.equal(overview.runtime.activeRoomCount, 1);
  assert.equal(overview.rooms.active, 1);
  assert.equal(overview.rooms.orphanRuntimeCount, 1);
});
