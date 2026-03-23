import assert from "node:assert/strict";
import test from "node:test";
import {
  decidePlaybackReconcileMode,
  shouldTreatAsExplicitSeek,
} from "../src/content/playback-reconcile";

test("ignores small playback drift while playing", () => {
  const decision = decidePlaybackReconcileMode({
    localCurrentTime: 12,
    targetTime: 12.3,
    playState: "playing",
  });

  assert.equal(decision.mode, "ignore");
  assert.equal(decision.reason, "within-threshold");
  assert.ok(Math.abs(decision.delta - 0.3) < 0.001);
});

test("uses soft apply for medium playback drift while playing", () => {
  const decision = decidePlaybackReconcileMode({
    localCurrentTime: 12,
    targetTime: 13.1,
    playState: "playing",
  });

  assert.equal(decision.mode, "soft-apply");
  assert.equal(decision.reason, "playing-drift");
  assert.ok(Math.abs(decision.delta - 1.1) < 0.001);
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

test("treats a three-second playing jump as an explicit seek", () => {
  assert.equal(
    shouldTreatAsExplicitSeek({
      syncIntent: "explicit-seek",
      playState: "playing",
    }),
    true,
  );
});

test("does not infer explicit seek from a small playing delta without sender intent", () => {
  assert.equal(
    shouldTreatAsExplicitSeek({
      playState: "playing",
    }),
    false,
  );
});

test("forces hard seek for explicit seek intent even within a one-second delta", () => {
  assert.deepEqual(
    decidePlaybackReconcileMode({
      localCurrentTime: 12,
      targetTime: 13,
      playState: "playing",
      isExplicitSeek: true,
    }),
    {
      mode: "hard-seek",
      delta: 1,
      reason: "explicit-seek",
    },
  );
});

test("uses hard seek once playing drift exceeds the tighter soft-apply window", () => {
  const decision = decidePlaybackReconcileMode({
    localCurrentTime: 12,
    targetTime: 13.35,
    playState: "playing",
  });

  assert.equal(decision.mode, "hard-seek");
  assert.equal(decision.reason, "playing-drift");
  assert.ok(Math.abs(decision.delta - 1.35) < 0.001);
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
