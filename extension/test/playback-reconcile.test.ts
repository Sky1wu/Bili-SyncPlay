import assert from "node:assert/strict";
import test from "node:test";
import { decidePlaybackReconcileMode } from "../src/content/playback-reconcile";

test("ignores small playback drift while playing", () => {
  assert.deepEqual(
    decidePlaybackReconcileMode({
      localCurrentTime: 12,
      targetTime: 12.5,
      playState: "playing",
    }),
    {
      mode: "ignore",
      delta: 0.5,
      reason: "within-threshold",
    },
  );
});

test("uses soft apply for medium playback drift while playing", () => {
  const decision = decidePlaybackReconcileMode({
    localCurrentTime: 12,
    targetTime: 13.4,
    playState: "playing",
  });

  assert.equal(decision.mode, "soft-apply");
  assert.equal(decision.reason, "playing-drift");
  assert.ok(Math.abs(decision.delta - 1.4) < 0.001);
});

test("forces hard seek for explicit jumps while playing", () => {
  assert.deepEqual(
    decidePlaybackReconcileMode({
      localCurrentTime: 12,
      targetTime: 20,
      playState: "playing",
      isExplicitSeek: true,
    }),
    {
      mode: "hard-seek",
      delta: 8,
      reason: "explicit-seek",
    },
  );
});

test("keeps paused playback on the fast hard-seek path", () => {
  const decision = decidePlaybackReconcileMode({
    localCurrentTime: 12,
    targetTime: 12.4,
    playState: "paused",
  });

  assert.equal(decision.mode, "hard-seek");
  assert.equal(decision.reason, "paused-or-buffering");
  assert.ok(Math.abs(decision.delta - 0.4) < 0.001);
});
