import type { PlaybackState } from "@bili-syncplay/protocol";

export type PlaybackReconcileMode =
  | "ignore"
  | "rate-only"
  | "soft-apply"
  | "hard-seek";

export interface PlaybackReconcileDecision {
  mode: PlaybackReconcileMode;
  delta: number;
  reason:
    | "within-threshold"
    | "paused-or-buffering"
    | "playing-rate-adjust"
    | "playing-soft-drift"
    | "playing-hard-drift"
    | "explicit-seek";
}

export function formatPlaybackReconcileDecision(
  decision: PlaybackReconcileDecision,
): string {
  return `mode=${decision.mode} reason=${decision.reason} delta=${decision.delta.toFixed(2)}`;
}

const PAUSED_HARD_SEEK_THRESHOLD_SECONDS = 0.15;
const PLAYING_IGNORE_THRESHOLD_SECONDS = 0.35;
const PLAYING_RATE_ONLY_THRESHOLD_SECONDS = 0.9;
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
        : delta <= PLAYING_RATE_ONLY_THRESHOLD_SECONDS
          ? "rate-only"
        : delta <= PLAYING_SOFT_APPLY_THRESHOLD_SECONDS
          ? "soft-apply"
          : "hard-seek",
    delta,
    reason:
      delta <= PLAYING_IGNORE_THRESHOLD_SECONDS
        ? "within-threshold"
        : delta <= PLAYING_RATE_ONLY_THRESHOLD_SECONDS
          ? "playing-rate-adjust"
          : delta <= PLAYING_SOFT_APPLY_THRESHOLD_SECONDS
            ? "playing-soft-drift"
            : "playing-hard-drift",
  };
}
