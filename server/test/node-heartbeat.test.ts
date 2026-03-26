import assert from "node:assert/strict";
import test from "node:test";
import { createNodeHeartbeat } from "../src/node-heartbeat.js";
import { createRedisRuntimeStore } from "../src/redis-runtime-store.js";

const REDIS_URL = process.env.REDIS_URL;

function createKeyPrefix(): string {
  return `bsp:test:heartbeat:${Date.now()}:${Math.random().toString(16).slice(2)}:`;
}

test("node heartbeat writes shared node status into redis runtime store", async (t) => {
  if (!REDIS_URL) {
    t.skip("REDIS_URL is not configured.");
    return;
  }

  let currentTime = 1_000;
  const instanceId = `node-heartbeat-${Date.now().toString(36)}`;
  const keyPrefix = createKeyPrefix();
  const sharedRuntimeStore = await createRedisRuntimeStore(REDIS_URL, {
    keyPrefix,
    now: () => currentTime,
  });
  const heartbeat = createNodeHeartbeat({
    enabled: true,
    instanceId,
    serviceVersion: "test-version",
    runtimeStore: sharedRuntimeStore,
    intervalMs: 50,
    ttlMs: 200,
    now: () => currentTime,
  });

  try {
    await heartbeat.beat();

    let statuses = await sharedRuntimeStore.listNodeStatuses(currentTime);
    assert.equal(statuses.length, 1);
    assert.equal(statuses[0]?.instanceId, instanceId);
    assert.equal(statuses[0]?.version, "test-version");
    assert.equal(statuses[0]?.health, "ok");

    currentTime += 120;
    statuses = await sharedRuntimeStore.listNodeStatuses(currentTime);
    assert.equal(statuses[0]?.health, "stale");

    currentTime += 120;
    statuses = await sharedRuntimeStore.listNodeStatuses(currentTime);
    assert.equal(statuses[0]?.health, "offline");
  } finally {
    await heartbeat.stop();
    await sharedRuntimeStore.close();
  }
});
