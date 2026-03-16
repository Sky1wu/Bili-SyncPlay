import assert from "node:assert/strict";
import test from "node:test";
import { getConnectionErrorMessage } from "../src/background/connection-error";

test("returns the generic message when the healthcheck endpoint is unreachable", () => {
  assert.equal(
    getConnectionErrorMessage({
      healthcheckReachable: false,
      extensionOrigin: "chrome-extension://abc123"
    }),
    "无法连接到同步服务器。"
  );
});

test("mentions the extension origin when the websocket handshake is rejected after a reachable healthcheck", () => {
  assert.equal(
    getConnectionErrorMessage({
      healthcheckReachable: true,
      extensionOrigin: "chrome-extension://abc123"
    }),
    "服务器可达，但 WebSocket 握手被拒绝。请检查服务端 ALLOWED_ORIGINS 是否包含 chrome-extension://abc123，以及反向代理是否已正确转发 WebSocket。"
  );
});

test("returns a generic reachable-but-rejected message for non-origin handshake failures", () => {
  assert.equal(
    getConnectionErrorMessage({
      healthcheckReachable: true,
      extensionOrigin: "chrome-extension://abc123",
      reason: "proxy_rejected"
    }),
    "服务器可达，但 WebSocket 握手被拒绝。请检查服务端状态，以及反向代理是否已正确转发 WebSocket。"
  );
});

test("falls back to a generic handshake rejection hint when the extension origin is unavailable", () => {
  assert.equal(
    getConnectionErrorMessage({
      healthcheckReachable: true,
      extensionOrigin: "   "
    }),
    "服务器可达，但 WebSocket 握手被拒绝。请检查服务端 ALLOWED_ORIGINS，以及反向代理是否已正确转发 WebSocket。"
  );
});
