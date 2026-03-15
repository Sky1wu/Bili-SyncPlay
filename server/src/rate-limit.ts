import type { SecurityConfig, SessionRateLimitState, TokenBucket, WindowCounter } from "./types.js";

export const WINDOW_MINUTE_MS = 60_000;
export const WINDOW_10_SECONDS_MS = 10_000;

export function createWindowCounter(now: number = Date.now()): WindowCounter {
  return { windowStart: now, count: 0 };
}

export function createTokenBucket(capacity: number, now: number = Date.now()): TokenBucket {
  return {
    tokens: capacity,
    lastRefillAt: now
  };
}

export function createSessionRateLimitState(config: SecurityConfig, now: number = Date.now()): SessionRateLimitState {
  return {
    roomCreate: createWindowCounter(now),
    roomJoin: createWindowCounter(now),
    videoShare: createWindowCounter(now),
    syncRequest: createWindowCounter(now),
    playbackUpdate: createTokenBucket(config.rateLimits.playbackUpdateBurst, now),
    syncPing: createTokenBucket(config.rateLimits.syncPingBurst, now)
  };
}

export function consumeFixedWindow(counter: WindowCounter, limit: number, windowMs: number, now: number): boolean {
  if (now - counter.windowStart >= windowMs) {
    counter.windowStart = now;
    counter.count = 0;
  }

  if (counter.count >= limit) {
    return false;
  }

  counter.count += 1;
  return true;
}

export function consumeTokenBucket(bucket: TokenBucket, refillPerSecond: number, capacity: number, now: number): boolean {
  const elapsedMs = Math.max(0, now - bucket.lastRefillAt);
  const refill = elapsedMs / 1000 * refillPerSecond;
  bucket.tokens = Math.min(capacity, bucket.tokens + refill);
  bucket.lastRefillAt = now;

  if (bucket.tokens < 1) {
    return false;
  }

  bucket.tokens -= 1;
  return true;
}
