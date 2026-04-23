import assert from "node:assert/strict";
import test from "node:test";
import {
  closeClient,
  connectClient,
  createMessageCollector,
  createMultiNodeTestKit,
  requestJson,
} from "./multi-node-test-kit.js";

test("multi-node test kit starts two room nodes and one global admin on the same redis namespace", async (t) => {
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) {
    t.skip("REDIS_URL is not configured.");
    return;
  }

  const kit = await createMultiNodeTestKit(redisUrl);
  try {
    const roomNodeA = await kit.startRoomNode("node-a");
    const roomNodeB = await kit.startRoomNode("node-b");
    const globalAdmin = await kit.startGlobalAdmin();

    assert.notEqual(roomNodeA.httpBaseUrl, roomNodeB.httpBaseUrl);
    assert.notEqual(roomNodeA.wsUrl, roomNodeB.wsUrl);
    assert.ok(kit.namespace.startsWith("bsp:test:"));

    const token = await kit.login(globalAdmin.httpBaseUrl);
    const overview = await requestJson(
      globalAdmin.httpBaseUrl,
      "/api/admin/overview",
      {
        token,
      },
    );
    assert.equal(overview.status, 200);
    assert.equal(
      (overview.body.data as { service: { name: string } }).service.name,
      "bili-syncplay-global-admin",
    );
  } finally {
    await kit.closeAll();
  }
});

test("multi-node test kit merges partial security config overrides with defaults", async (t) => {
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) {
    t.skip("REDIS_URL is not configured.");
    return;
  }

  const kit = await createMultiNodeTestKit(redisUrl, {
    securityConfig: {
      maxMembersPerRoom: 12,
    },
  });

  let socket: Awaited<ReturnType<typeof connectClient>> | undefined;

  try {
    const roomNode = await kit.startRoomNode("node-partial-security");
    socket = await connectClient(roomNode.wsUrl);
    const inbox = createMessageCollector(socket);

    socket.send(
      JSON.stringify({
        type: "room:create",
        payload: { displayName: "Bench Owner" },
      }),
    );

    const created = await inbox.next("room:created");
    assert.equal(typeof created.payload, "object");
  } finally {
    if (socket) {
      await closeClient(socket);
    }
    await kit.closeAll();
  }
});
