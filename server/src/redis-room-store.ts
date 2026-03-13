import Redis from "ioredis";
import { createPersistedRoom, type RoomStore, type RoomUpdateResult } from "./room-store";
import type { PersistedRoom } from "./types";

const ROOM_KEY_PREFIX = "bsp:room:";
const ROOM_EXPIRY_KEY = "bsp:room-expiry";
const DELETE_EXPIRED_ROOMS_LUA = `
local expiryKey = KEYS[1]
local roomKeyPrefix = ARGV[1]
local now = tonumber(ARGV[2])
local expiredCodes = redis.call("ZRANGEBYSCORE", expiryKey, 0, now)
local deletedCount = 0

for _, code in ipairs(expiredCodes) do
  local key = roomKeyPrefix .. code
  local rawRoom = redis.call("GET", key)

  if rawRoom then
    local ok, room = pcall(cjson.decode, rawRoom)
    if ok and room and room["expiresAt"] ~= cjson.null and room["expiresAt"] ~= nil and tonumber(room["expiresAt"]) ~= nil and tonumber(room["expiresAt"]) <= now then
      redis.call("DEL", key)
      redis.call("ZREM", expiryKey, code)
      deletedCount = deletedCount + 1
    elseif ok and room and (room["expiresAt"] == cjson.null or room["expiresAt"] == nil) then
      redis.call("ZREM", expiryKey, code)
    end
  else
    redis.call("ZREM", expiryKey, code)
  end
end

return deletedCount
`;

function roomKey(code: string): string {
  return `${ROOM_KEY_PREFIX}${code}`;
}

function serializeRoom(room: PersistedRoom): string {
  return JSON.stringify(room);
}

function parseRoom(value: string | null): PersistedRoom | null {
  if (!value) {
    return null;
  }
  return JSON.parse(value) as PersistedRoom;
}

async function updateExpiryIndex(redis: Redis, room: PersistedRoom): Promise<void> {
  if (room.expiresAt === null) {
    await redis.zrem(ROOM_EXPIRY_KEY, room.code);
    return;
  }
  await redis.zadd(ROOM_EXPIRY_KEY, String(room.expiresAt), room.code);
}

export async function createRedisRoomStore(redisUrl: string): Promise<RoomStore & { close: () => Promise<void> }> {
  const redis = new Redis(redisUrl, {
    lazyConnect: true,
    maxRetriesPerRequest: 1
  });
  await redis.connect();

  return {
    async createRoom(input) {
      const room = createPersistedRoom(input);
      const created = await redis.set(roomKey(room.code), serializeRoom(room), "NX");
      if (created !== "OK") {
        throw new Error(`Room ${room.code} already exists.`);
      }
      return room;
    },
    async getRoom(code) {
      return parseRoom(await redis.get(roomKey(code)));
    },
    async saveRoom(room) {
      await redis.set(roomKey(room.code), serializeRoom(room));
      await updateExpiryIndex(redis, room);
      return room;
    },
    async updateRoom(code, expectedVersion, patch): Promise<RoomUpdateResult> {
      const key = roomKey(code);
      await redis.watch(key);
      try {
        const currentRoom = parseRoom(await redis.get(key));
        if (!currentRoom) {
          return { ok: false, reason: "not_found" };
        }
        if (currentRoom.version !== expectedVersion) {
          return { ok: false, reason: "version_conflict" };
        }

        const nextRoom: PersistedRoom = {
          ...currentRoom,
          ...patch,
          version: currentRoom.version + 1
        };

        const transaction = redis.multi();
        transaction.set(key, serializeRoom(nextRoom));
        if (nextRoom.expiresAt === null) {
          transaction.zrem(ROOM_EXPIRY_KEY, code);
        } else {
          transaction.zadd(ROOM_EXPIRY_KEY, String(nextRoom.expiresAt), code);
        }
        const result = await transaction.exec();
        if (result === null) {
          return { ok: false, reason: "version_conflict" };
        }
        return { ok: true, room: nextRoom };
      } finally {
        await redis.unwatch();
      }
    },
    async deleteRoom(code) {
      await redis.del(roomKey(code));
      await redis.zrem(ROOM_EXPIRY_KEY, code);
    },
    async deleteExpiredRooms(now) {
      const deletedCount = await redis.eval(DELETE_EXPIRED_ROOMS_LUA, 1, ROOM_EXPIRY_KEY, ROOM_KEY_PREFIX, String(now));
      return Number(deletedCount);
    },
    async close() {
      await redis.quit();
    }
  };
}
