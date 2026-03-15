import assert from "node:assert/strict";
import test from "node:test";
import { consumeFixedWindow, consumeTokenBucket, createSessionRateLimitState, createTokenBucket, createWindowCounter } from "../src/rate-limit.js";
import { getDefaultSecurityConfig } from "../src/app.js";

test("fixed window counters reset after the window elapses", () => {
  const counter = createWindowCounter(0);

  assert.equal(consumeFixedWindow(counter, 2, 1_000, 0), true);
  assert.equal(consumeFixedWindow(counter, 2, 1_000, 100), true);
  assert.equal(consumeFixedWindow(counter, 2, 1_000, 200), false);
  assert.equal(consumeFixedWindow(counter, 2, 1_000, 1_000), true);
});

test("token bucket refills over time and caps at capacity", () => {
  const bucket = createTokenBucket(2, 0);

  assert.equal(consumeTokenBucket(bucket, 1, 2, 0), true);
  assert.equal(consumeTokenBucket(bucket, 1, 2, 0), true);
  assert.equal(consumeTokenBucket(bucket, 1, 2, 0), false);
  assert.equal(consumeTokenBucket(bucket, 1, 2, 1_000), true);
  assert.equal(consumeTokenBucket(bucket, 10, 2, 5_000), true);
  assert.equal(bucket.tokens <= 1, true);
});

test("session rate limit state uses configured burst capacities", () => {
  const config = getDefaultSecurityConfig();
  config.rateLimits.playbackUpdateBurst = 9;
  config.rateLimits.syncPingBurst = 4;

  const state = createSessionRateLimitState(config, 123);

  assert.equal(state.playbackUpdate.tokens, 9);
  assert.equal(state.playbackUpdate.lastRefillAt, 123);
  assert.equal(state.syncPing.tokens, 4);
  assert.equal(state.syncPing.lastRefillAt, 123);
});
