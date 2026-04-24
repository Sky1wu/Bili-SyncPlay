import assert from "node:assert/strict";
import test from "node:test";
import { createAdminLoginRateLimiter } from "../src/admin/login-rate-limit.js";

function makeClock() {
  let current = 1_000_000;
  return {
    now: () => current,
    advance: (deltaMs: number) => {
      current += deltaMs;
    },
  };
}

test("login rate limiter enforces per-IP failure window", () => {
  const clock = makeClock();
  const limiter = createAdminLoginRateLimiter(
    { failuresPerIpPerMinute: 3, failuresPerUsernamePerMinute: 1000 },
    clock.now,
  );

  for (let attempt = 0; attempt < 3; attempt += 1) {
    assert.equal(
      limiter.check({ ipKey: "1.2.3.4", username: `user-${attempt}` }).ok,
      true,
    );
    limiter.registerFailure({ ipKey: "1.2.3.4", username: `user-${attempt}` });
  }

  const blocked = limiter.check({ ipKey: "1.2.3.4", username: "anyone" });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.ok === false && blocked.dimension, "ip");

  const otherIp = limiter.check({ ipKey: "9.9.9.9", username: "user-0" });
  assert.equal(otherIp.ok, true);
});

test("login rate limiter enforces per-username failure window across IPs", () => {
  const clock = makeClock();
  const limiter = createAdminLoginRateLimiter(
    { failuresPerIpPerMinute: 1000, failuresPerUsernamePerMinute: 2 },
    clock.now,
  );

  limiter.registerFailure({ ipKey: "1.1.1.1", username: "alice" });
  limiter.registerFailure({ ipKey: "2.2.2.2", username: "alice" });

  const blocked = limiter.check({ ipKey: "3.3.3.3", username: "alice" });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.ok === false && blocked.dimension, "username");

  const differentUser = limiter.check({ ipKey: "3.3.3.3", username: "bob" });
  assert.equal(differentUser.ok, true);
});

test("login rate limiter resets after a successful login", () => {
  const clock = makeClock();
  const limiter = createAdminLoginRateLimiter(
    { failuresPerIpPerMinute: 2, failuresPerUsernamePerMinute: 2 },
    clock.now,
  );

  limiter.registerFailure({ ipKey: "1.2.3.4", username: "admin" });
  limiter.registerFailure({ ipKey: "1.2.3.4", username: "admin" });
  assert.equal(
    limiter.check({ ipKey: "1.2.3.4", username: "admin" }).ok,
    false,
  );

  limiter.registerSuccess({ ipKey: "1.2.3.4", username: "admin" });
  assert.equal(limiter.check({ ipKey: "1.2.3.4", username: "admin" }).ok, true);
});

test("login rate limiter rolls the window after a full minute", () => {
  const clock = makeClock();
  const limiter = createAdminLoginRateLimiter(
    { failuresPerIpPerMinute: 2, failuresPerUsernamePerMinute: 2 },
    clock.now,
  );

  limiter.registerFailure({ ipKey: "1.2.3.4", username: "admin" });
  limiter.registerFailure({ ipKey: "1.2.3.4", username: "admin" });
  const blocked = limiter.check({ ipKey: "1.2.3.4", username: "admin" });
  assert.equal(blocked.ok, false);

  clock.advance(60_001);
  const afterWindow = limiter.check({ ipKey: "1.2.3.4", username: "admin" });
  assert.equal(afterWindow.ok, true);
});

test("login rate limiter normalizes usernames for consistent throttling", () => {
  const clock = makeClock();
  const limiter = createAdminLoginRateLimiter(
    { failuresPerIpPerMinute: 1000, failuresPerUsernamePerMinute: 1 },
    clock.now,
  );

  limiter.registerFailure({ ipKey: "1.1.1.1", username: "Admin" });
  const blocked = limiter.check({ ipKey: "2.2.2.2", username: "ADMIN" });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.ok === false && blocked.dimension, "username");
});
