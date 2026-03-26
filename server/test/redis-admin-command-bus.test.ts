import assert from "node:assert/strict";
import test from "node:test";
import { createRedisAdminCommandBus } from "../src/redis-admin-command-bus.js";

const REDIS_URL = process.env.REDIS_URL;

function createChannelPrefix(prefix: string): string {
  return `${prefix}:${Date.now()}:${Math.random().toString(16).slice(2)}:`;
}

test("redis admin command bus routes commands to the target instance and returns results", async (t) => {
  if (!REDIS_URL) {
    t.skip("REDIS_URL is not configured.");
    return;
  }

  const commandChannelPrefix = createChannelPrefix("bsp:test:admin-command");
  const resultChannelPrefix = createChannelPrefix(
    "bsp:test:admin-command-result",
  );
  const busA = await createRedisAdminCommandBus(REDIS_URL, {
    commandChannelPrefix,
    resultChannelPrefix,
  });
  const busB = await createRedisAdminCommandBus(REDIS_URL, {
    commandChannelPrefix,
    resultChannelPrefix,
  });

  const unsubscribe = await busB.subscribe("node-b", async (command) => ({
    requestId: command.requestId,
    targetInstanceId: command.targetInstanceId,
    executorInstanceId: "node-b",
    status: "ok",
    roomCode: command.kind === "kick_member" ? command.roomCode : null,
    memberId: command.kind === "kick_member" ? command.memberId : undefined,
    sessionId:
      command.kind === "disconnect_session" ? command.sessionId : undefined,
    completedAt: 5_000,
  }));

  try {
    const result = await busA.request({
      kind: "disconnect_session",
      requestId: "req-redis-1",
      targetInstanceId: "node-b",
      sessionId: "session-1",
      requestedAt: 4_000,
    });

    assert.deepEqual(result, {
      requestId: "req-redis-1",
      targetInstanceId: "node-b",
      executorInstanceId: "node-b",
      status: "ok",
      roomCode: null,
      memberId: undefined,
      sessionId: "session-1",
      completedAt: 5_000,
    });
  } finally {
    await unsubscribe();
    await busA.close();
    await busB.close();
  }
});

test("redis admin command bus reports stale target when no subscriber responds", async (t) => {
  if (!REDIS_URL) {
    t.skip("REDIS_URL is not configured.");
    return;
  }

  const bus = await createRedisAdminCommandBus(REDIS_URL, {
    commandChannelPrefix: createChannelPrefix("bsp:test:admin-command"),
    resultChannelPrefix: createChannelPrefix("bsp:test:admin-command-result"),
  });

  try {
    const result = await bus.request(
      {
        kind: "kick_member",
        requestId: "req-redis-2",
        targetInstanceId: "missing-node",
        roomCode: "ROOM01",
        memberId: "member-a",
        requestedAt: 6_000,
      },
      100,
    );

    assert.equal(result.status, "stale_target");
    assert.equal(result.code, "command_timeout");
  } finally {
    await bus.close();
  }
});
