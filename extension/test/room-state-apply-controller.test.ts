import assert from "node:assert/strict";
import test from "node:test";
import type { PlaybackState, RoomState } from "@bili-syncplay/protocol";
import { createContentRuntimeState } from "../src/content/runtime-state";
import { createRoomStateApplyController } from "../src/content/room-state-apply-controller";

function createEmptyRoomState(roomCode = "ROOM01"): RoomState {
  return {
    roomCode,
    sharedVideo: null,
    playback: null,
    members: [],
  };
}

function createStubVideo(paused: boolean) {
  return {
    paused,
    currentTime: 10,
    playbackRate: 1,
    pause() {
      this.paused = true;
    },
  } as unknown as HTMLVideoElement;
}

function createController(overrides: {
  runtimeState?: ReturnType<typeof createContentRuntimeState>;
  video?: HTMLVideoElement | null;
  now?: number;
  userGestureGraceMs?: number;
  lastAppliedVersionByActor?: Map<string, { serverTime: number; seq: number }>;
}) {
  const runtimeState = overrides.runtimeState ?? createContentRuntimeState();
  const video = overrides.video ?? null;
  let _pauseHoldActivated = false;
  let _acceptedHydration = false;
  const logs: string[] = [];
  const lastAppliedVersionByActor =
    overrides.lastAppliedVersionByActor ??
    new Map<string, { serverTime: number; seq: number }>();

  const controller = createRoomStateApplyController({
    runtimeState,
    lastAppliedVersionByActor,
    ignoredSelfPlaybackLogState: { key: null, at: 0 },
    localIntentGuardMs: 1_200,
    pauseHoldMs: 800,
    initialRoomStatePauseHoldMs: 3_000,
    userGestureGraceMs: overrides.userGestureGraceMs ?? 1_200,
    getNow: () => overrides.now ?? 10_000,
    debugLog: (msg) => logs.push(msg),
    shouldLogHeartbeat: () => true,
    runtimeSendMessage: async () => null,
    getHydrateRetryTimer: () => null,
    setHydrateRetryTimer: () => {},
    getVideoElement: () => video,
    getSharedVideo: () => null,
    normalizeUrl: (url) => url ?? null,
    notifyRoomStateToasts: () => {},
    maybeShowSharedVideoToast: () => {},
    cancelActiveSoftApply: () => {},
    resetPlaybackSyncState: () => {},
    activatePauseHold: () => {
      _pauseHoldActivated = true;
    },
    clearRemoteFollowPlayingWindow: () => {},
    acceptInitialRoomStateHydration: () => {
      _acceptedHydration = true;
    },
    acceptInitialRoomStateHydrationIfPending: () => {},
    logIgnoredRemotePlayback: () => {},
    getPendingLocalPlaybackOverrideDecision: () => ({ shouldIgnore: false }),
    shouldCancelActiveSoftApplyForPlayback: () => null,
    shouldApplySelfPlayback: () => false,
    shouldIgnoreRemotePlaybackApply: () => false,
    shouldSuppressRemotePlaybackByCooldown: () => false,
    rememberRemoteFollowPlayingWindow: () => {},
    rememberRemotePlaybackForSuppression: () => {},
    armProgrammaticApplyWindow: () => {},
    applyPendingPlaybackApplication: () => {},
    formatPlaybackDiagnostic: (a) => `${a.result}`,
  });

  return {
    controller,
    runtimeState,
    lastAppliedVersionByActor,
    get pauseHoldActivated() {
      return _pauseHoldActivated;
    },
    get acceptedHydration() {
      return _acceptedHydration;
    },
    logs,
  };
}

test("suppresses autoplay for empty room when intendedPlayState is paused", async () => {
  const video = createStubVideo(false);
  const harness = createController({ video, now: 10_000 });

  harness.runtimeState.pendingRoomStateHydration = true;
  harness.runtimeState.intendedPlayState = "paused";

  await harness.controller.applyRoomState(createEmptyRoomState());

  assert.equal(harness.runtimeState.intendedPlayState, "paused");
  assert.equal(harness.pauseHoldActivated, true);
  assert.equal(harness.acceptedHydration, true);
  assert.equal(video.paused, true);
});

test("does not suppress playback for empty room when intendedPlayState is playing", async () => {
  const video = createStubVideo(false);
  const harness = createController({ video, now: 10_000 });

  harness.runtimeState.pendingRoomStateHydration = true;
  harness.runtimeState.intendedPlayState = "playing";

  await harness.controller.applyRoomState(createEmptyRoomState());

  assert.equal(harness.runtimeState.intendedPlayState, "playing");
  assert.equal(harness.pauseHoldActivated, false);
  assert.equal(harness.acceptedHydration, true);
  assert.equal(video.paused, false);
});

test("suppresses autoplay for empty room after navigation resets gesture state", async () => {
  const video = createStubVideo(false);
  const harness = createController({
    video,
    now: 10_000,
    userGestureGraceMs: 1_200,
  });

  harness.runtimeState.pendingRoomStateHydration = true;
  harness.runtimeState.intendedPlayState = "paused";
  harness.runtimeState.lastUserGestureAt = 0;
  harness.runtimeState.lastExplicitPlaybackAction = null;
  harness.runtimeState.lastExplicitUserAction = null;

  await harness.controller.applyRoomState(createEmptyRoomState());

  assert.equal(harness.runtimeState.intendedPlayState, "paused");
  assert.equal(harness.pauseHoldActivated, true);
  assert.equal(video.paused, true);
});

test("skips pauseVideo when a recent user gesture is within the grace window", async () => {
  const video = createStubVideo(false);
  const harness = createController({
    video,
    now: 10_000,
    userGestureGraceMs: 1_200,
  });

  harness.runtimeState.pendingRoomStateHydration = true;
  harness.runtimeState.intendedPlayState = "paused";
  harness.runtimeState.lastUserGestureAt = 9_500;

  await harness.controller.applyRoomState(createEmptyRoomState());

  assert.equal(harness.runtimeState.intendedPlayState, "paused");
  assert.equal(harness.pauseHoldActivated, true);
  assert.equal(harness.acceptedHydration, true);
  assert.equal(video.paused, false);
});

test("pauses video when gesture age exactly equals the grace window boundary", async () => {
  const video = createStubVideo(false);
  const harness = createController({
    video,
    now: 10_000,
    userGestureGraceMs: 1_200,
  });

  harness.runtimeState.pendingRoomStateHydration = true;
  harness.runtimeState.intendedPlayState = "paused";
  harness.runtimeState.lastUserGestureAt = 8_800;

  await harness.controller.applyRoomState(createEmptyRoomState());

  assert.equal(harness.runtimeState.intendedPlayState, "paused");
  assert.equal(harness.pauseHoldActivated, true);
  assert.equal(harness.acceptedHydration, true);
  assert.equal(video.paused, true);
});

test("prunes lastAppliedVersionByActor for members that have left the room", async () => {
  const actorMap = new Map<string, { serverTime: number; seq: number }>([
    ["member-A", { serverTime: 1000, seq: 1 }],
    ["member-B", { serverTime: 2000, seq: 2 }],
    ["member-C", { serverTime: 3000, seq: 3 }],
  ]);
  const harness = createController({ lastAppliedVersionByActor: actorMap });

  // member-B left; only member-A and member-C remain
  await harness.controller.applyRoomState({
    ...createEmptyRoomState(),
    members: [
      { id: "member-A", name: "Alice" },
      { id: "member-C", name: "Carol" },
    ],
  });

  assert.equal(harness.lastAppliedVersionByActor.has("member-A"), true);
  assert.equal(harness.lastAppliedVersionByActor.has("member-B"), false);
  assert.equal(harness.lastAppliedVersionByActor.has("member-C"), true);
});

test("clears all actor entries when room becomes empty", async () => {
  const actorMap = new Map<string, { serverTime: number; seq: number }>([
    ["member-A", { serverTime: 1000, seq: 1 }],
    ["member-B", { serverTime: 2000, seq: 2 }],
  ]);
  const harness = createController({ lastAppliedVersionByActor: actorMap });

  await harness.controller.applyRoomState(createEmptyRoomState());

  assert.equal(harness.lastAppliedVersionByActor.size, 0);
});

test("retains actor entry for departed member whose playback is still current room playback", async () => {
  // member-B left the room but the server still reports their playback as the
  // current room playback. The entry must not be pruned so that subsequent
  // identical state updates are still recognised as already-applied and are
  // not re-applied.
  const stalePlayback: PlaybackState = {
    url: "https://www.bilibili.com/video/BV1xx411c7X1",
    currentTime: 42,
    playState: "playing",
    playbackRate: 1,
    updatedAt: 1000,
    serverTime: 1000,
    actorId: "member-B",
    seq: 5,
  };
  const actorMap = new Map<string, { serverTime: number; seq: number }>([
    ["member-A", { serverTime: 500, seq: 1 }],
    ["member-B", { serverTime: 1000, seq: 5 }],
  ]);
  const harness = createController({ lastAppliedVersionByActor: actorMap });

  // member-B is no longer in the members list but is still the playback actor
  await harness.controller.applyRoomState({
    ...createEmptyRoomState(),
    members: [{ id: "member-A", name: "Alice" }],
    playback: stalePlayback,
  });

  // member-B's entry must be kept to guard against re-applying their playback
  assert.equal(harness.lastAppliedVersionByActor.has("member-B"), true);
  assert.deepEqual(harness.lastAppliedVersionByActor.get("member-B"), {
    serverTime: 1000,
    seq: 5,
  });
});
