import type { PlaybackState } from "@bili-syncplay/protocol";

export type PlaybackReconcileMode = "ignore" | "soft-apply" | "hard-seek";

export interface PlaybackReconcileDecision {
  mode: PlaybackReconcileMode;
  delta: number;
  reason:
    | "within-threshold"
    | "paused-or-buffering"
    | "playing-drift"
    | "explicit-seek";
}

const PAUSED_HARD_SEEK_THRESHOLD_SECONDS = 0.15;
const PLAYING_IGNORE_THRESHOLD_SECONDS = 0.35;
const PLAYING_SOFT_APPLY_THRESHOLD_SECONDS = 1.2;

export function shouldTreatAsExplicitSeek(args: {
  syncIntent?: PlaybackState["syncIntent"];
  playState: PlaybackState["playState"];
}): boolean {
  return args.playState === "playing" && args.syncIntent === "explicit-seek";
}

export function decidePlaybackReconcileMode(args: {
  localCurrentTime: number;
  targetTime: number;
  playState: PlaybackState["playState"];
  isExplicitSeek?: boolean;
}): PlaybackReconcileDecision {
  const delta = Math.abs(args.targetTime - args.localCurrentTime);

  if (args.playState !== "playing") {
    return {
      mode: delta > PAUSED_HARD_SEEK_THRESHOLD_SECONDS ? "hard-seek" : "ignore",
      delta,
      reason:
        delta > PAUSED_HARD_SEEK_THRESHOLD_SECONDS
          ? "paused-or-buffering"
          : "within-threshold",
    };
  }

  if (args.isExplicitSeek) {
    return {
      mode: "hard-seek",
      delta,
      reason: "explicit-seek",
    };
  }

  return {
    mode:
      delta <= PLAYING_IGNORE_THRESHOLD_SECONDS
        ? "ignore"
        : delta <= PLAYING_SOFT_APPLY_THRESHOLD_SECONDS
          ? "soft-apply"
          : "hard-seek",
    delta,
    reason:
      delta > PLAYING_IGNORE_THRESHOLD_SECONDS
        ? "playing-drift"
        : "within-threshold",
  };
}
