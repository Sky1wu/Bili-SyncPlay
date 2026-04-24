import assert from "node:assert/strict";
import type { IncomingMessage } from "node:http";
import test from "node:test";
import { evaluateAdminWriteOrigin } from "../src/admin/csrf.js";

type FakeSocket = { encrypted?: boolean };

function createRequest(args: {
  host?: string;
  origin?: string | null;
  forwardedProto?: string;
  encrypted?: boolean;
}): IncomingMessage {
  const headers: Record<string, string> = {};
  if (args.host !== undefined) {
    headers.host = args.host;
  }
  if (args.origin !== null && args.origin !== undefined) {
    headers.origin = args.origin;
  }
  if (args.forwardedProto !== undefined) {
    headers["x-forwarded-proto"] = args.forwardedProto;
  }
  const socket: FakeSocket = { encrypted: args.encrypted ?? false };
  return {
    headers,
    socket,
  } as unknown as IncomingMessage;
}

test("admin CSRF origin allows same-origin requests", () => {
  const request = createRequest({
    host: "admin.example.com",
    origin: "https://admin.example.com",
    forwardedProto: "https",
  });
  const result = evaluateAdminWriteOrigin(request, { allowedOrigins: [] });
  assert.deepEqual(result, { ok: true });
});

test("admin CSRF origin rejects cross-origin requests", () => {
  const request = createRequest({
    host: "admin.example.com",
    origin: "https://evil.example.com",
    forwardedProto: "https",
  });
  const result = evaluateAdminWriteOrigin(request, { allowedOrigins: [] });
  assert.deepEqual(result, { ok: false, reason: "origin_not_allowed" });
});

test("admin CSRF origin rejects when Origin header is missing", () => {
  const request = createRequest({
    host: "admin.example.com",
    origin: null,
  });
  const result = evaluateAdminWriteOrigin(request, {
    allowedOrigins: ["https://admin.example.com"],
  });
  assert.deepEqual(result, { ok: false, reason: "origin_missing" });
});

test("admin CSRF origin accepts Origin listed in the allow-list", () => {
  const request = createRequest({
    host: "admin.example.com",
    origin: "https://trusted.example.com",
    forwardedProto: "https",
  });
  const result = evaluateAdminWriteOrigin(request, {
    allowedOrigins: ["https://trusted.example.com"],
  });
  assert.deepEqual(result, { ok: true });
});

test("admin CSRF origin honors x-forwarded-proto for scheme comparison", () => {
  const request = createRequest({
    host: "admin.example.com",
    origin: "https://admin.example.com",
    forwardedProto: "https,http",
  });
  const result = evaluateAdminWriteOrigin(request, { allowedOrigins: [] });
  assert.deepEqual(result, { ok: true });
});

test("admin CSRF origin falls back to socket.encrypted when no forwarded-proto", () => {
  const request = createRequest({
    host: "admin.example.com",
    origin: "http://admin.example.com",
  });
  const result = evaluateAdminWriteOrigin(request, { allowedOrigins: [] });
  assert.deepEqual(result, { ok: true });
});
