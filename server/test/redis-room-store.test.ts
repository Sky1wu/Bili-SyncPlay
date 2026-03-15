import assert from "node:assert/strict";
import test from "node:test";
import Redis from "ioredis";
import { createRedisRoomStore } from "../src/redis-room-store.js";

const REDIS_URL = process.env.REDIS_URL;

test("redis room reaper does not delete rooms whose expiresAt was cleared after zset candidate selection", async (t) => {
  if (!REDIS_URL) {
    t.skip("REDIS_URL is not configured.");
    return;
  }

  const store = await createRedisRoomStore(REDIS_URL);
  const redis = new Redis(REDIS_URL, {
    lazyConnect: true,
    maxRetriesPerRequest: 1
  });
  await redis.connect();

  const roomCode = `T${Date.now().toString(36).slice(-5).toUpperCase()}`.padEnd(6, "A").slice(0, 6);

  try {
    const room = await store.createRoom({
      code: roomCode,
      joinToken: "join-token-123456",
      createdAt: 1
    });

    const expired = await store.updateRoom(room.code, room.version, {
      expiresAt: 10,
      lastActiveAt: 2
    });
    assert.equal(expired.ok, true);
    if (!expired.ok) {
      throw new Error("Expected update to succeed.");
    }

    const revived = await store.updateRoom(room.code, expired.room.version, {
      expiresAt: null,
      lastActiveAt: 3
    });
    assert.equal(revived.ok, true);
    if (!revived.ok) {
      throw new Error("Expected room revival to succeed.");
    }

    await redis.zadd("bsp:room-expiry", "10", room.code);

    const deletedCount = await store.deleteExpiredRooms(10);
    assert.equal(deletedCount, 0);

    const remainingRoom = await store.getRoom(room.code);
    assert.ok(remainingRoom);
    assert.equal(remainingRoom?.expiresAt, null);
    assert.equal(await redis.zscore("bsp:room-expiry", room.code), null);
  } finally {
    await store.deleteRoom(roomCode);
    await redis.quit();
    await store.close();
  }
});
