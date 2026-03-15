import assert from "node:assert/strict";
import test from "node:test";
import { createInMemoryRoomStore } from "../src/room-store.js";
import { createRoomReaper } from "../src/room-reaper.js";

test("room reaper deletes expired rooms through the store interface", async () => {
  const store = createInMemoryRoomStore();
  await store.createRoom({
    code: "ROOM01",
    joinToken: "join-token-123456",
    createdAt: 1
  });
  const updated = await store.updateRoom("ROOM01", 0, {
    expiresAt: 10,
    lastActiveAt: 5
  });
  assert.equal(updated.ok, true);

  const reaper = createRoomReaper({
    intervalMs: 60_000,
    deleteExpiredRooms: store.deleteExpiredRooms,
    logEvent: () => undefined,
    now: () => 10
  });

  try {
    const deletedCount = await reaper.runNow();
    assert.equal(deletedCount, 1);
    assert.equal(await store.getRoom("ROOM01"), null);
  } finally {
    reaper.stop();
  }
});
