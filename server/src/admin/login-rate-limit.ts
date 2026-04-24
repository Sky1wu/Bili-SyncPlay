import { WINDOW_MINUTE_MS } from "../rate-limit.js";

type CounterEntry = {
  windowStart: number;
  count: number;
  lastSeenAt: number;
};

const ATTEMPT_WINDOW_TTL_MS = 10 * WINDOW_MINUTE_MS;
const SWEEP_INTERVAL = 64;

export type AdminLoginRateLimitConfig = {
  failuresPerIpPerMinute: number;
  failuresPerUsernamePerMinute: number;
};

export type AdminLoginRateLimiter = {
  check(input: { ipKey: string; username: string }): CheckResult;
  registerFailure(input: { ipKey: string; username: string }): void;
  registerSuccess(input: { ipKey: string; username: string }): void;
};

type CheckResult =
  | { ok: true }
  | { ok: false; dimension: "ip" | "username"; retryAfterMs: number };

function refreshIfExpired(
  entry: CounterEntry,
  windowMs: number,
  currentTime: number,
): void {
  if (currentTime - entry.windowStart >= windowMs) {
    entry.windowStart = currentTime;
    entry.count = 0;
  }
}

function isExceeded(
  entry: CounterEntry | undefined,
  limit: number,
  windowMs: number,
  currentTime: number,
): { exceeded: boolean; retryAfterMs: number } {
  if (!entry) {
    return { exceeded: false, retryAfterMs: 0 };
  }
  if (currentTime - entry.windowStart >= windowMs) {
    return { exceeded: false, retryAfterMs: 0 };
  }
  if (entry.count < limit) {
    return { exceeded: false, retryAfterMs: 0 };
  }
  const retryAfterMs = Math.max(
    0,
    windowMs - (currentTime - entry.windowStart),
  );
  return { exceeded: true, retryAfterMs };
}

export function createAdminLoginRateLimiter(
  config: AdminLoginRateLimitConfig,
  now: () => number = Date.now,
): AdminLoginRateLimiter {
  const ipEntries = new Map<string, CounterEntry>();
  const usernameEntries = new Map<string, CounterEntry>();
  let sweepTick = 0;

  function touch(
    map: Map<string, CounterEntry>,
    key: string,
    currentTime: number,
  ): CounterEntry {
    const existing = map.get(key);
    if (existing) {
      existing.lastSeenAt = currentTime;
      return existing;
    }
    const entry: CounterEntry = {
      windowStart: currentTime,
      count: 0,
      lastSeenAt: currentTime,
    };
    map.set(key, entry);
    return entry;
  }

  function maybeSweep(currentTime: number): void {
    sweepTick += 1;
    if (sweepTick % SWEEP_INTERVAL !== 0) {
      return;
    }
    for (const map of [ipEntries, usernameEntries]) {
      for (const [key, entry] of map) {
        if (currentTime - entry.lastSeenAt >= ATTEMPT_WINDOW_TTL_MS) {
          map.delete(key);
        }
      }
    }
  }

  function normalizeUsername(username: string): string {
    return username.trim().toLowerCase();
  }

  return {
    check({ ipKey, username }) {
      const currentTime = now();
      maybeSweep(currentTime);
      const ipCheck = isExceeded(
        ipEntries.get(ipKey),
        config.failuresPerIpPerMinute,
        WINDOW_MINUTE_MS,
        currentTime,
      );
      if (ipCheck.exceeded) {
        return {
          ok: false,
          dimension: "ip",
          retryAfterMs: ipCheck.retryAfterMs,
        };
      }

      const normalizedUsername = normalizeUsername(username);
      if (normalizedUsername.length > 0) {
        const usernameCheck = isExceeded(
          usernameEntries.get(normalizedUsername),
          config.failuresPerUsernamePerMinute,
          WINDOW_MINUTE_MS,
          currentTime,
        );
        if (usernameCheck.exceeded) {
          return {
            ok: false,
            dimension: "username",
            retryAfterMs: usernameCheck.retryAfterMs,
          };
        }
      }

      return { ok: true };
    },
    registerFailure({ ipKey, username }) {
      const currentTime = now();
      const ipEntry = touch(ipEntries, ipKey, currentTime);
      refreshIfExpired(ipEntry, WINDOW_MINUTE_MS, currentTime);
      ipEntry.count += 1;

      const normalizedUsername = normalizeUsername(username);
      if (normalizedUsername.length > 0) {
        const usernameEntry = touch(
          usernameEntries,
          normalizedUsername,
          currentTime,
        );
        refreshIfExpired(usernameEntry, WINDOW_MINUTE_MS, currentTime);
        usernameEntry.count += 1;
      }
    },
    registerSuccess({ ipKey, username }) {
      ipEntries.delete(ipKey);
      const normalizedUsername = normalizeUsername(username);
      if (normalizedUsername.length > 0) {
        usernameEntries.delete(normalizedUsername);
      }
    },
  };
}
