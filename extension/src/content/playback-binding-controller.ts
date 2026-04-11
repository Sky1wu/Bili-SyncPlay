import type { SharedVideo } from "@bili-syncplay/protocol";
import {
  bindVideoElement,
  getVideoElement,
  pauseVideo,
} from "./player-binding";
import {
  evaluateNonSharedPageGuard,
  shouldForcePauseWhileWaitingForInitialRoomState,
} from "./sync-guards";
import type {
  ContentRuntimeState,
  ExplicitUserActionKind,
  LocalPlaybackEventSource,
} from "./runtime-state";

export interface PlaybackBindingController {
  start(): void;
  attachPlaybackListeners(): void;
}

export function createPlaybackBindingController(args: {
  runtimeState: ContentRuntimeState;
  videoBindIntervalMs: number;
  userGestureGraceMs: number;
  initialRoomStatePauseHoldMs: number;
  getSharedVideo: () => SharedVideo | null;
  hasRecentRemoteStopIntent: (currentVideoUrl: string) => boolean;
  normalizeUrl: (url: string | undefined | null) => string | null;
  getLastBroadcastAt: () => number;
  broadcastPlayback: (
    video: HTMLVideoElement,
    eventSource?: LocalPlaybackEventSource,
  ) => Promise<void>;
  cancelActiveSoftApply: (
    video: HTMLVideoElement | null,
    reason: string,
  ) => void;
  maintainActiveSoftApply: (video: HTMLVideoElement) => void;
  applyPendingPlaybackApplication: (video: HTMLVideoElement) => void;
  activatePauseHold: (durationMs?: number) => void;
  debugLog: (message: string) => void;
  getNow?: () => number;
}): PlaybackBindingController {
  let videoBindingTimer: number | null = null;
  const nowOf = () => args.getNow?.() ?? Date.now();
  const hasRecentUserGesture = () =>
    nowOf() - args.runtimeState.lastUserGestureAt < args.userGestureGraceMs;
  const getRecentExplicitSeekWithoutNewGestureAt = (): number | null => {
    const explicitAction = args.runtimeState.lastExplicitUserAction;
    if (
      explicitAction?.kind !== "seek" ||
      nowOf() - explicitAction.at >= args.userGestureGraceMs
    ) {
      return null;
    }

    return args.runtimeState.lastUserGestureAt <= explicitAction.at
      ? explicitAction.at
      : null;
  };

  function scheduleBroadcast(
    video: HTMLVideoElement,
    eventSource: LocalPlaybackEventSource,
    followUpMs?: number,
  ) {
    void args.broadcastPlayback(video, eventSource);
    if (followUpMs) {
      window.setTimeout(() => {
        void args.broadcastPlayback(video, eventSource);
      }, followUpMs);
    }
  }

  function rememberExplicitPlaybackAction(playState: "playing" | "paused") {
    if (
      nowOf() - args.runtimeState.lastUserGestureAt < args.userGestureGraceMs &&
      args.runtimeState.lastUserGestureAt > args.runtimeState.lastForcedPauseAt
    ) {
      args.runtimeState.lastExplicitPlaybackAction = {
        playState,
        at: nowOf(),
      };
    }
  }

  function rememberExplicitUserAction(kind: ExplicitUserActionKind) {
    if (
      nowOf() - args.runtimeState.lastUserGestureAt < args.userGestureGraceMs &&
      args.runtimeState.lastUserGestureAt > args.runtimeState.lastForcedPauseAt
    ) {
      if (
        kind === "play" &&
        args.runtimeState.lastExplicitUserAction?.kind === "seek" &&
        nowOf() - args.runtimeState.lastExplicitUserAction.at <
          args.userGestureGraceMs &&
        args.runtimeState.lastUserGestureAt <=
          args.runtimeState.lastExplicitUserAction.at
      ) {
        return;
      }
      args.runtimeState.lastExplicitUserAction = {
        kind,
        at: nowOf(),
      };
    }
  }

  function shouldTreatRateChangeAsProgrammatic(
    video: HTMLVideoElement,
  ): boolean {
    const signature = args.runtimeState.programmaticApplySignature;
    if (!signature || nowOf() >= args.runtimeState.programmaticApplyUntil) {
      return false;
    }

    const currentVideo = args.getSharedVideo();
    const normalizedCurrentUrl = args.normalizeUrl(currentVideo?.url);
    if (!normalizedCurrentUrl || normalizedCurrentUrl !== signature.url) {
      return false;
    }

    return Math.abs(video.playbackRate - signature.playbackRate) <= 0.01;
  }

  function isCurrentVideoShared(currentVideo: SharedVideo | null): boolean {
    if (!currentVideo || !args.runtimeState.activeSharedUrl) {
      return false;
    }
    return (
      args.normalizeUrl(currentVideo.url) === args.runtimeState.activeSharedUrl
    );
  }

  function shouldPreRecordNonSharedExplicitPlay(): boolean {
    const currentVideo = args.getSharedVideo();
    if (
      !hasRecentUserGesture() ||
      args.runtimeState.lastUserGestureAt <=
        args.runtimeState.lastForcedPauseAt ||
      !currentVideo ||
      isCurrentVideoShared(currentVideo)
    ) {
      return false;
    }

    // When the browser auto-seeks to a resume point and then auto-plays,
    // the play event is browser-initiated, not an explicit user play gesture.
    // Only block when the seek belongs to the CURRENT gesture
    // (lastUserGestureAt <= seek time), meaning no newer user gesture
    // has occurred since the seek.
    const lastAction = args.runtimeState.lastExplicitUserAction;
    if (
      lastAction?.kind === "seek" &&
      nowOf() - lastAction.at < args.userGestureGraceMs &&
      args.runtimeState.lastUserGestureAt <= lastAction.at
    ) {
      return false;
    }

    return true;
  }

  function preAuthorizeExplicitNonSharedPlay(): void {
    const currentVideo = args.getSharedVideo();
    const normalizedCurrentUrl = args.normalizeUrl(currentVideo?.url);
    if (!normalizedCurrentUrl || isCurrentVideoShared(currentVideo)) {
      return;
    }

    rememberExplicitPlaybackAction("playing");
    args.runtimeState.explicitNonSharedPlaybackUrl = normalizedCurrentUrl;
  }

  function forcePauseWhileWaitingForInitialRoomState(
    video: HTMLVideoElement,
  ): boolean {
    if (
      !shouldForcePauseWhileWaitingForInitialRoomState({
        activeRoomCode: args.runtimeState.activeRoomCode,
        pendingRoomStateHydration: args.runtimeState.pendingRoomStateHydration,
        videoPaused: video.paused,
      })
    ) {
      return false;
    }

    args.debugLog(
      `Suppressed page autoplay while waiting for initial room state of ${args.runtimeState.activeRoomCode}`,
    );
    args.runtimeState.intendedPlayState = "paused";
    args.runtimeState.lastForcedPauseAt = nowOf();
    window.setTimeout(() => {
      if (!video.paused) {
        pauseVideo(video);
      }
    }, 0);
    return true;
  }

  function forcePauseOnNonSharedPage(video: HTMLVideoElement): boolean {
    if (
      !args.runtimeState.activeRoomCode ||
      !args.runtimeState.activeSharedUrl
    ) {
      return false;
    }

    const currentVideo = args.getSharedVideo();
    const normalizedCurrentUrl = args.normalizeUrl(currentVideo?.url);
    if (!currentVideo) {
      args.runtimeState.explicitNonSharedPlaybackUrl = null;
      return false;
    }

    if (
      normalizedCurrentUrl &&
      normalizedCurrentUrl !== args.runtimeState.activeSharedUrl &&
      normalizedCurrentUrl !== args.runtimeState.lastNonSharedGuardUrl
    ) {
      args.runtimeState.lastNonSharedGuardUrl = normalizedCurrentUrl;
      args.runtimeState.lastExplicitPlaybackAction = null;
    } else if (
      !normalizedCurrentUrl ||
      normalizedCurrentUrl === args.runtimeState.activeSharedUrl
    ) {
      args.runtimeState.lastNonSharedGuardUrl = null;
    }

    const decision = evaluateNonSharedPageGuard({
      activeRoomCode: args.runtimeState.activeRoomCode,
      activeSharedUrl: args.runtimeState.activeSharedUrl,
      normalizedCurrentUrl,
      videoPaused: video.paused,
      explicitNonSharedPlaybackUrl:
        args.runtimeState.explicitNonSharedPlaybackUrl,
      lastExplicitPlaybackAction: args.runtimeState.lastExplicitPlaybackAction,
      now: nowOf(),
      userGestureGraceMs: args.userGestureGraceMs,
    });

    if (
      !normalizedCurrentUrl ||
      normalizedCurrentUrl === args.runtimeState.activeSharedUrl
    ) {
      args.runtimeState.explicitNonSharedPlaybackUrl = null;
      return false;
    }

    args.runtimeState.explicitNonSharedPlaybackUrl =
      decision.nextExplicitNonSharedPlaybackUrl;
    if (!decision.shouldPause) {
      return false;
    }

    args.runtimeState.intendedPlayState = "paused";
    args.runtimeState.lastForcedPauseAt = nowOf();
    args.activatePauseHold(args.initialRoomStatePauseHoldMs);
    window.setTimeout(() => {
      if (!video.paused) {
        pauseVideo(video);
      }
    }, 0);
    return true;
  }

  function attachPlaybackListeners(): void {
    const video = getVideoElement();
    if (!video) {
      return;
    }

    const guardUnexpectedResume = () => {
      const currentVideo = args.getSharedVideo();
      const recentSeekWithoutNewGestureAt =
        getRecentExplicitSeekWithoutNewGestureAt();
      const shouldBlockSeekTriggeredAutoplay =
        currentVideo &&
        isCurrentVideoShared(currentVideo) &&
        args.runtimeState.intendedPlayState !== "playing" &&
        recentSeekWithoutNewGestureAt !== null;

      if (shouldBlockSeekTriggeredAutoplay) {
        args.debugLog(
          `Forced pause reapplied after seek-triggered autoplay intended=${args.runtimeState.intendedPlayState}`,
        );
        args.runtimeState.lastExplicitUserAction = null;
        args.runtimeState.lastExplicitPlaybackAction = null;
        args.runtimeState.lastForcedPauseAt = nowOf();
        window.setTimeout(() => {
          pauseVideo(video);
        }, 0);
        return true;
      }

      if (
        currentVideo &&
        isCurrentVideoShared(currentVideo) &&
        args.hasRecentRemoteStopIntent(currentVideo.url) &&
        args.runtimeState.intendedPlayState !== "playing" &&
        nowOf() - args.runtimeState.lastUserGestureAt >= args.userGestureGraceMs
      ) {
        args.debugLog(
          `Forced pause hold reapplied after unexpected resume intended=${args.runtimeState.intendedPlayState}`,
        );
        args.runtimeState.lastForcedPauseAt = nowOf();
        window.setTimeout(() => {
          pauseVideo(video);
        }, 0);
        return true;
      }
      if (forcePauseOnNonSharedPage(video)) {
        return true;
      }
      if (forcePauseWhileWaitingForInitialRoomState(video)) {
        return true;
      }
      return false;
    };

    bindVideoElement({
      video,
      onPlay: () => {
        if (shouldPreRecordNonSharedExplicitPlay()) {
          preAuthorizeExplicitNonSharedPlay();
        }
        if (guardUnexpectedResume()) {
          return;
        }
        rememberExplicitPlaybackAction("playing");
        rememberExplicitUserAction("play");
        scheduleBroadcast(video, "play", 180);
      },
      onPause: () => {
        const currentVideo = args.getSharedVideo();
        if (hasRecentUserGesture()) {
          args.cancelActiveSoftApply(video, "pause");
        }
        rememberExplicitPlaybackAction("paused");
        rememberExplicitUserAction("pause");
        if (
          currentVideo &&
          args.normalizeUrl(currentVideo.url) ===
            args.runtimeState.explicitNonSharedPlaybackUrl
        ) {
          args.runtimeState.explicitNonSharedPlaybackUrl = null;
        }
        scheduleBroadcast(video, "pause", 120);
      },
      onWaiting: () => scheduleBroadcast(video, "waiting"),
      onStalled: () => scheduleBroadcast(video, "stalled"),
      onLoadedMetadata: () => {
        if (!forcePauseWhileWaitingForInitialRoomState(video)) {
          args.applyPendingPlaybackApplication(video);
        }
      },
      onCanPlay: () => {
        if (!forcePauseWhileWaitingForInitialRoomState(video)) {
          args.applyPendingPlaybackApplication(video);
        }
        scheduleBroadcast(video, "canplay", 120);
      },
      onPlaying: () => {
        if (shouldPreRecordNonSharedExplicitPlay()) {
          preAuthorizeExplicitNonSharedPlay();
        }
        if (guardUnexpectedResume()) {
          return;
        }
        rememberExplicitPlaybackAction("playing");
        rememberExplicitUserAction("play");
        scheduleBroadcast(video, "playing", 180);
      },
      onSeeking: () => {
        if (hasRecentUserGesture()) {
          args.cancelActiveSoftApply(video, "seek");
        }
        rememberExplicitUserAction("seek");
        scheduleBroadcast(video, "seeking");
      },
      onSeeked: () => {
        if (hasRecentUserGesture()) {
          args.cancelActiveSoftApply(video, "seek");
        }
        rememberExplicitUserAction("seek");
        scheduleBroadcast(video, "seeked", 120);
      },
      onRateChange: () => {
        if (!shouldTreatRateChangeAsProgrammatic(video)) {
          rememberExplicitUserAction("ratechange");
        }
        scheduleBroadcast(video, "ratechange", 120);
      },
      onTimeUpdate: () => {
        args.maintainActiveSoftApply(video);
        if (nowOf() - args.getLastBroadcastAt() > 2000 && !video.paused) {
          void args.broadcastPlayback(video, "timeupdate");
        }
      },
    });
  }

  return {
    start() {
      attachPlaybackListeners();
      if (videoBindingTimer === null) {
        videoBindingTimer = window.setInterval(
          attachPlaybackListeners,
          args.videoBindIntervalMs,
        );
      }
    },
    attachPlaybackListeners,
  };
}
