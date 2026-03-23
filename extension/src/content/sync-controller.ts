import type {
  PlaybackState,
  RoomState,
  SharedVideo,
} from "@bili-syncplay/protocol";
import type { SharedVideoToastPayload } from "../shared/messages";
import { decidePlaybackApplication } from "./playback-apply";
import {
  createPlaybackBroadcastPayload,
  derivePlaybackSyncIntent,
  shouldPauseForNonSharedBroadcast,
  shouldSkipBroadcastWhileHydrating,
} from "./playback-broadcast";
import {
  applyPendingPlaybackApplication as applyPendingPlaybackApplicationWithBinding,
  canApplyPlaybackImmediately,
  createProgrammaticPlaybackSignature,
  getPlayState,
  pauseVideo,
} from "./player-binding";
import {
  decidePlaybackReconcileMode,
  shouldTreatAsExplicitSeek,
} from "./playback-reconcile";
import {
  hasRecentRemoteStopIntent as hasRecentRemoteStopIntentGuard,
  rememberRemotePlaybackForSuppression as rememberRemotePlaybackForSuppressionGuard,
  shouldApplySelfPlayback as shouldApplySelfPlaybackGuard,
  shouldSuppressLocalEcho as shouldSuppressLocalEchoGuard,
  shouldSuppressRemoteFollowupBroadcast as shouldSuppressRemoteFollowupBroadcastGuard,
  shouldSuppressProgrammaticEvent as shouldSuppressProgrammaticEventGuard,
  shouldSuppressRemotePlayTransition as shouldSuppressRemotePlayTransitionGuard,
} from "./sync-guards";
import type {
  ContentRuntimeState,
  LocalPlaybackEventSource,
  PendingLocalPlaybackOverride,
} from "./runtime-state";

export interface SyncController {
  resetPlaybackSyncState(reason: string): void;
  hasRecentRemoteStopIntent(currentVideoUrl: string): boolean;
  cancelActiveSoftApply(video: HTMLVideoElement | null, reason: string): void;
  maintainActiveSoftApply(video: HTMLVideoElement): void;
  applyPendingPlaybackApplication(video: HTMLVideoElement): void;
  broadcastPlayback(
    video: HTMLVideoElement,
    eventSource?: LocalPlaybackEventSource,
  ): Promise<void>;
  applyRoomState(
    state: RoomState,
    shareToast?: SharedVideoToastPayload | null,
  ): Promise<void>;
  hydrateRoomState(): Promise<void>;
  scheduleHydrationRetry(delayMs?: number): void;
}

export function createSyncController(args: {
  runtimeState: ContentRuntimeState;
  lastAppliedVersionByActor: Map<string, { serverTime: number; seq: number }>;
  broadcastLogState: { key: string | null; at: number };
  ignoredSelfPlaybackLogState: { key: string | null; at: number };
  localIntentGuardMs: number;
  pauseHoldMs: number;
  initialRoomStatePauseHoldMs: number;
  remoteEchoSuppressionMs: number;
  remotePlayTransitionGuardMs: number;
  remoteFollowPlayingWindowMs: number;
  programmaticApplyWindowMs: number;
  userGestureGraceMs: number;
  nextSeq: () => number;
  markBroadcastAt: (at: number) => void;
  getNow?: () => number;
  debugLog: (message: string) => void;
  shouldLogHeartbeat: (
    state: { key: string | null; at: number },
    key: string,
    now?: number,
  ) => boolean;
  runtimeSendMessage: <T>(message: unknown) => Promise<T | null>;
  getHydrateRetryTimer: () => number | null;
  setHydrateRetryTimer: (timer: number | null) => void;
  getVideoElement: () => HTMLVideoElement | null;
  getCurrentPlaybackVideo: () => Promise<SharedVideo | null>;
  getSharedVideo: () => SharedVideo | null;
  normalizeUrl: (url: string | undefined | null) => string | null;
  notifyRoomStateToasts: (state: RoomState) => void;
  maybeShowSharedVideoToast: (
    toast: SharedVideoToastPayload | null | undefined,
    state: RoomState,
  ) => void;
}): SyncController {
  const PENDING_LOCAL_EXPLICIT_SEEK_GUARD_MS = 5_000;
  const PENDING_LOCAL_EXPLICIT_SEEK_SETTLE_THRESHOLD_SECONDS = 0.35;
  const PENDING_LOCAL_EXPLICIT_RATECHANGE_GUARD_MS = 5_000;
  const PENDING_LOCAL_EXPLICIT_RATECHANGE_SETTLE_THRESHOLD = 0.01;
  const SOFT_APPLY_RECOVERY_THRESHOLD_SECONDS = 0.2;
  const SOFT_APPLY_MIN_TIMEOUT_MS = 2_000;
  const SOFT_APPLY_MAX_TIMEOUT_MS = 4_500;
  const SOFT_APPLY_TIMEOUT_PER_SECOND_MS = 900;
  const SOFT_APPLY_RTT_TIMEOUT_FACTOR = 2.5;
  const SOFT_APPLY_TARGET_SHIFT_CANCEL_THRESHOLD_SECONDS = 0.6;
  const nowOf = () => args.getNow?.() ?? Date.now();
  let activeSoftApply: {
    normalizedUrl: string;
    targetTime: number;
    restorePlaybackRate: number;
    deadlineAt: number;
  } | null = null;
  let activeSoftApplyTimer: number | null = null;

  function formatPlaybackDiagnostic(args: {
    actor?: string | null;
    playState: PlaybackState["playState"];
    url: string;
    localTime?: number | null;
    targetTime: number;
    result: string;
    extra?: string;
  }): string {
    const localTime = args.localTime ?? null;
    const delta =
      localTime === null
        ? "n/a"
        : Math.abs(localTime - args.targetTime).toFixed(2);
    const parts = [
      `actor=${args.actor ?? "unknown"}`,
      `playState=${args.playState}`,
      `url=${args.url}`,
      `delta=${delta}`,
      `result=${args.result}`,
    ];
    if (args.extra) {
      parts.push(args.extra);
    }
    return parts.join(" ");
  }

  function formatBroadcastTrace(argsForTrace: {
    eventSource: LocalPlaybackEventSource;
    currentVideoUrl: string | null;
    normalizedCurrentVideoUrl: string | null;
    playState?: PlaybackState["playState"];
    currentTime?: number;
    playbackRate?: number;
  }): string {
    const pending = args.runtimeState.pendingLocalPlaybackOverride;
    const suppressed = args.runtimeState.suppressedRemotePlayback;
    const explicitAction = args.runtimeState.lastExplicitUserAction;
    const programmatic = args.runtimeState.programmaticApplySignature;

    return [
      `source=${argsForTrace.eventSource}`,
      `url=${argsForTrace.currentVideoUrl ?? "none"}`,
      `normalizedUrl=${argsForTrace.normalizedCurrentVideoUrl ?? "none"}`,
      `playState=${argsForTrace.playState ?? "unknown"}`,
      `t=${argsForTrace.currentTime?.toFixed(2) ?? "n/a"}`,
      `rate=${argsForTrace.playbackRate?.toFixed(2) ?? "n/a"}`,
      `intendedState=${args.runtimeState.intendedPlayState}`,
      `intendedRate=${args.runtimeState.intendedPlaybackRate.toFixed(2)}`,
      `explicitAction=${explicitAction?.kind ?? "none"}@${explicitAction?.at ?? 0}`,
      `lastGestureAt=${args.runtimeState.lastUserGestureAt}`,
      `pendingOverride=${pending ? `${pending.kind}:${pending.seq}@${pending.url}` : "none"}`,
      `remoteFollow=${args.runtimeState.remoteFollowPlayingUrl ?? "none"}@${args.runtimeState.remoteFollowPlayingUntil}`,
      `suppressedRemote=${suppressed ? `${suppressed.playState}@${suppressed.url}` : "none"}`,
      `programmatic=${programmatic ? `${programmatic.playState}@${programmatic.url}` : "none"}@${args.runtimeState.programmaticApplyUntil}`,
      `pauseHoldUntil=${args.runtimeState.pauseHoldUntil}`,
    ].join(" ");
  }

  function activatePauseHold(durationMs = args.pauseHoldMs): void {
    args.runtimeState.pauseHoldUntil = nowOf() + durationMs;
  }

  function armProgrammaticApplyWindow(
    signature: ReturnType<typeof createProgrammaticPlaybackSignature>,
    reason: "pending" | "apply",
    actorId = "system",
  ): void {
    args.runtimeState.programmaticApplySignature = signature;
    args.runtimeState.programmaticApplyUntil =
      nowOf() + args.programmaticApplyWindowMs;
    args.debugLog(
      `Programmatic apply window armed actor=${actorId} playState=${signature.playState} url=${signature.url} delta=n/a result=${reason} until=${args.runtimeState.programmaticApplyUntil}`,
    );
  }

  function clearActiveSoftApplyState(): void {
    activeSoftApply = null;
    if (activeSoftApplyTimer !== null) {
      window.clearTimeout(activeSoftApplyTimer);
      activeSoftApplyTimer = null;
    }
  }

  function computeSoftApplyTimeoutMs(remainingDriftSeconds: number): number {
    const networkAllowanceMs =
      args.runtimeState.rttMs === null
        ? 0
        : Math.round(args.runtimeState.rttMs * SOFT_APPLY_RTT_TIMEOUT_FACTOR);
    return Math.min(
      SOFT_APPLY_MAX_TIMEOUT_MS,
      Math.max(
        SOFT_APPLY_MIN_TIMEOUT_MS,
        Math.round(
          SOFT_APPLY_MIN_TIMEOUT_MS +
            networkAllowanceMs +
            Math.max(
              0,
              remainingDriftSeconds - SOFT_APPLY_RECOVERY_THRESHOLD_SECONDS,
            ) *
              SOFT_APPLY_TIMEOUT_PER_SECOND_MS,
        ),
      ),
    );
  }

  function cancelActiveSoftApply(
    video: HTMLVideoElement | null,
    reason: string,
  ): void {
    if (!activeSoftApply) {
      return;
    }

    const session = activeSoftApply;
    clearActiveSoftApplyState();
    if (
      video &&
      Math.abs(video.playbackRate - session.restorePlaybackRate) > 0.01
    ) {
      video.playbackRate = session.restorePlaybackRate;
      armProgrammaticApplyWindow(
        {
          url: session.normalizedUrl,
          playState: getPlayState(video, args.runtimeState.intendedPlayState),
          currentTime: video.currentTime,
          playbackRate: session.restorePlaybackRate,
        },
        "apply",
      );
    }
    args.debugLog(
      `Cancelled soft apply url=${session.normalizedUrl} target=${session.targetTime.toFixed(2)} result=${reason}`,
    );
  }

  function scheduleActiveSoftApplyTimeout(): void {
    if (!activeSoftApply) {
      return;
    }
    if (activeSoftApplyTimer !== null) {
      window.clearTimeout(activeSoftApplyTimer);
    }
    const delayMs = Math.max(0, activeSoftApply.deadlineAt - nowOf());
    activeSoftApplyTimer = window.setTimeout(() => {
      activeSoftApplyTimer = null;
      if (!activeSoftApply) {
        return;
      }
      const video = args.getVideoElement();
      cancelActiveSoftApply(video, "timeout");
    }, delayMs);
  }

  function upsertActiveSoftApply(
    playback: PlaybackState,
    remainingDriftSeconds: number,
  ): void {
    const normalizedUrl = args.normalizeUrl(playback.url);
    if (!normalizedUrl) {
      clearActiveSoftApplyState();
      return;
    }
    const timeoutMs = computeSoftApplyTimeoutMs(remainingDriftSeconds);
    activeSoftApply = {
      normalizedUrl,
      targetTime: playback.currentTime,
      restorePlaybackRate: playback.playbackRate,
      deadlineAt: nowOf() + timeoutMs,
    };
    scheduleActiveSoftApplyTimeout();
    args.debugLog(
      `Started soft apply url=${normalizedUrl} target=${playback.currentTime.toFixed(2)} rate=${playback.playbackRate.toFixed(2)} timeout=${timeoutMs}`,
    );
  }

  function shouldCancelActiveSoftApplyForPlayback(
    playback: PlaybackState | null,
  ): string | null {
    if (!activeSoftApply) {
      return null;
    }
    if (!playback) {
      return "missing-playback";
    }

    const normalizedUrl = args.normalizeUrl(playback.url);
    if (!normalizedUrl || normalizedUrl !== activeSoftApply.normalizedUrl) {
      return "url-changed";
    }
    if (playback.playState !== "playing") {
      return "play-state-changed";
    }
    if (
      shouldTreatAsExplicitSeek({
        syncIntent: playback.syncIntent,
        playState: playback.playState,
      })
    ) {
      return "explicit-seek";
    }
    if (
      Math.abs(playback.playbackRate - activeSoftApply.restorePlaybackRate) >
      0.01
    ) {
      return "rate-changed";
    }
    if (
      Math.abs(playback.currentTime - activeSoftApply.targetTime) >
      SOFT_APPLY_TARGET_SHIFT_CANCEL_THRESHOLD_SECONDS
    ) {
      return "target-shifted";
    }
    return null;
  }

  function maintainActiveSoftApply(video: HTMLVideoElement): void {
    if (!activeSoftApply) {
      return;
    }
    if (nowOf() >= activeSoftApply.deadlineAt) {
      cancelActiveSoftApply(video, "timeout");
      return;
    }
    if (
      Math.abs(video.currentTime - activeSoftApply.targetTime) <=
      SOFT_APPLY_RECOVERY_THRESHOLD_SECONDS
    ) {
      cancelActiveSoftApply(video, "converged");
    }
  }

  function shouldSuppressActiveSoftApplyBroadcast(input: {
    normalizedCurrentUrl: string | null;
    playState: PlaybackState["playState"];
    eventSource: LocalPlaybackEventSource;
    now: number;
  }): boolean {
    if (
      !activeSoftApply ||
      input.now >= activeSoftApply.deadlineAt ||
      !input.normalizedCurrentUrl ||
      input.normalizedCurrentUrl !== activeSoftApply.normalizedUrl
    ) {
      return false;
    }

    if (
      args.runtimeState.lastExplicitUserAction &&
      input.now - args.runtimeState.lastExplicitUserAction.at <
        args.userGestureGraceMs
    ) {
      return false;
    }

    args.debugLog(
      `Skip broadcast ${formatPlaybackDiagnostic({
        actor: args.runtimeState.localMemberId,
        playState: input.playState,
        url: activeSoftApply.normalizedUrl,
        localTime: null,
        targetTime: activeSoftApply.targetTime,
        result: `soft-apply-follow-${input.eventSource}`,
      })}`,
    );
    return true;
  }

  function resetPlaybackSyncState(reason: string): void {
    cancelActiveSoftApply(args.getVideoElement(), `reset:${reason}`);
    args.lastAppliedVersionByActor.clear();
    clearRemoteFollowPlayingWindow();
    args.runtimeState.suppressedRemotePlayback = null;
    args.runtimeState.recentRemotePlayingIntent = null;
    args.runtimeState.pendingPlaybackApplication = null;
    clearPendingLocalPlaybackOverride();
    args.runtimeState.programmaticApplyUntil = 0;
    args.runtimeState.programmaticApplySignature = null;
    args.runtimeState.lastLocalPlaybackVersion = null;
    args.runtimeState.intendedPlaybackRate = 1;
    args.debugLog(`Reset playback sync state: ${reason}`);
  }

  function scheduleHydrationRetry(delayMs = 350): void {
    if (args.getHydrateRetryTimer() !== null) {
      return;
    }
    const timer = window.setTimeout(() => {
      args.setHydrateRetryTimer(null);
      void hydrateRoomState();
    }, delayMs);
    args.setHydrateRetryTimer(timer);
  }

  function applyPendingPlaybackApplication(video: HTMLVideoElement): void {
    const result = applyPendingPlaybackApplicationWithBinding({
      video,
      pendingPlaybackApplication: args.runtimeState.pendingPlaybackApplication,
      clearPendingPlaybackApplication: () => {
        args.runtimeState.pendingPlaybackApplication = null;
      },
      onPlaybackAdjusted: (adjustment, playback) => {
        if (adjustment.mode === "soft-apply") {
          upsertActiveSoftApply(
            playback,
            Math.abs(adjustment.targetTime - adjustment.currentTime),
          );
          return;
        }
        cancelActiveSoftApply(
          args.getVideoElement(),
          `apply-${adjustment.mode}`,
        );
      },
      markProgrammaticApply: (_signature, playback) => {
        armProgrammaticApplyWindow(_signature, "apply", playback.actorId);
      },
      debugLog: args.debugLog,
    });
    if (
      result.applied &&
      !result.didChange &&
      result.adjustment?.mode === "ignore"
    ) {
      args.debugLog(
        "Skipped noop playback apply because reconcile stayed within ignore threshold",
      );
    }
  }

  function acceptInitialRoomStateHydration(): void {
    args.runtimeState.pendingRoomStateHydration = false;
    args.runtimeState.hasReceivedInitialRoomState = true;
  }

  function acceptInitialRoomStateHydrationIfPending(): void {
    if (args.runtimeState.pendingRoomStateHydration) {
      acceptInitialRoomStateHydration();
    }
  }

  function logIgnoredRemotePlayback(argsForLog: {
    playback: PlaybackState;
    video: HTMLVideoElement;
    result: string;
    extra?: string;
  }): void {
    args.debugLog(
      `Ignored remote playback ${formatPlaybackDiagnostic({
        actor: argsForLog.playback.actorId,
        playState: argsForLog.playback.playState,
        url: argsForLog.playback.url,
        localTime: argsForLog.video.currentTime,
        targetTime: argsForLog.playback.currentTime,
        result: argsForLog.result,
        extra: argsForLog.extra,
      })}`,
    );
  }

  function clearPendingLocalPlaybackOverride(reason = "unknown"): void {
    if (args.runtimeState.pendingLocalPlaybackOverride) {
      const pending = args.runtimeState.pendingLocalPlaybackOverride;
      args.debugLog(
        `Cleared pending local playback override kind=${pending.kind} url=${pending.url} seq=${pending.seq} reason=${reason}`,
      );
    }
    args.runtimeState.pendingLocalPlaybackOverride = null;
  }

  function getPendingLocalPlaybackOverrideDecision(
    playback: PlaybackState | null,
  ): {
    shouldIgnore: boolean;
    reason?: string;
    extra?: string;
  } {
    const pending = args.runtimeState.pendingLocalPlaybackOverride;
    if (!pending) {
      return { shouldIgnore: false };
    }

    if (nowOf() >= pending.expiresAt) {
      clearPendingLocalPlaybackOverride("expired");
      return { shouldIgnore: false };
    }

    if (!playback) {
      return { shouldIgnore: false };
    }

    const normalizedPlaybackUrl = args.normalizeUrl(playback.url);
    if (!normalizedPlaybackUrl || normalizedPlaybackUrl !== pending.url) {
      return { shouldIgnore: false };
    }

    if (
      args.runtimeState.localMemberId &&
      playback.actorId === args.runtimeState.localMemberId &&
      playback.seq >= pending.seq
    ) {
      clearPendingLocalPlaybackOverride("self-echo-ack");
      return { shouldIgnore: false };
    }

    if (pending.kind === "seek") {
      return getPendingLocalSeekOverrideDecision(playback, pending);
    }

    return getPendingLocalRateOverrideDecision(playback, pending);
  }

  function getPendingLocalSeekOverrideDecision(
    playback: PlaybackState,
    pending: PendingLocalPlaybackOverride,
  ): {
    shouldIgnore: boolean;
    reason?: string;
    extra?: string;
  } {
    if (pending.targetTime === undefined) {
      return { shouldIgnore: false };
    }

    const deltaToPending = Math.abs(playback.currentTime - pending.targetTime);
    if (
      deltaToPending <= PENDING_LOCAL_EXPLICIT_SEEK_SETTLE_THRESHOLD_SECONDS
    ) {
      clearPendingLocalPlaybackOverride("seek-settled");
      return { shouldIgnore: false };
    }

    return {
      shouldIgnore: true,
      reason: "pending-local-explicit-seek",
      extra: `seq=${playback.seq} pendingSeq=${pending.seq} seekDelta=${deltaToPending.toFixed(2)} incomingIntent=${playback.syncIntent ?? "none"}`,
    };
  }

  function getPendingLocalRateOverrideDecision(
    playback: PlaybackState,
    pending: PendingLocalPlaybackOverride,
  ): {
    shouldIgnore: boolean;
    reason?: string;
    extra?: string;
  } {
    if (
      playback.playState !== "playing" ||
      pending.playbackRate === undefined
    ) {
      return { shouldIgnore: false };
    }

    const rateDelta = Math.abs(playback.playbackRate - pending.playbackRate);
    if (rateDelta <= PENDING_LOCAL_EXPLICIT_RATECHANGE_SETTLE_THRESHOLD) {
      clearPendingLocalPlaybackOverride("rate-settled");
      return { shouldIgnore: false };
    }

    return {
      shouldIgnore: true,
      reason: "pending-local-explicit-ratechange",
      extra: `seq=${playback.seq} pendingSeq=${pending.seq} rateDelta=${rateDelta.toFixed(2)} targetRate=${pending.playbackRate.toFixed(2)} incomingRate=${playback.playbackRate.toFixed(2)}`,
    };
  }

  function rememberPendingLocalPlaybackOverride(
    payload: PlaybackState,
    now: number,
  ): void {
    if (payload.syncIntent === "explicit-seek") {
      args.runtimeState.pendingLocalPlaybackOverride = {
        kind: "seek",
        url: args.normalizeUrl(payload.url) ?? payload.url,
        targetTime: payload.currentTime,
        seq: payload.seq,
        expiresAt: now + PENDING_LOCAL_EXPLICIT_SEEK_GUARD_MS,
      };
      args.debugLog(
        `Remember pending local playback override kind=seek url=${payload.url} target=${payload.currentTime.toFixed(2)} seq=${payload.seq} expiresAt=${args.runtimeState.pendingLocalPlaybackOverride.expiresAt}`,
      );
      return;
    }

    if (
      args.runtimeState.lastExplicitUserAction?.kind === "ratechange" &&
      now - args.runtimeState.lastExplicitUserAction.at <
        args.userGestureGraceMs
    ) {
      args.runtimeState.pendingLocalPlaybackOverride = {
        kind: "ratechange",
        url: args.normalizeUrl(payload.url) ?? payload.url,
        playbackRate: payload.playbackRate,
        seq: payload.seq,
        expiresAt: now + PENDING_LOCAL_EXPLICIT_RATECHANGE_GUARD_MS,
      };
      args.debugLog(
        `Remember pending local playback override kind=ratechange url=${payload.url} rate=${payload.playbackRate.toFixed(2)} seq=${payload.seq} expiresAt=${args.runtimeState.pendingLocalPlaybackOverride.expiresAt}`,
      );
    }
  }

  function clearRemoteFollowPlayingWindow(): void {
    args.runtimeState.remoteFollowPlayingUntil = 0;
    args.runtimeState.remoteFollowPlayingUrl = null;
  }

  function rememberRemoteFollowPlayingWindow(playback: PlaybackState): void {
    if (playback.playState !== "playing") {
      clearRemoteFollowPlayingWindow();
      return;
    }

    args.runtimeState.remoteFollowPlayingUntil =
      nowOf() + args.remoteFollowPlayingWindowMs;
    args.runtimeState.remoteFollowPlayingUrl = args.normalizeUrl(playback.url);
  }

  function hasRecentRemoteStopIntent(currentVideoUrl: string): boolean {
    return hasRecentRemoteStopIntentGuard({
      now: nowOf(),
      pauseHoldUntil: args.runtimeState.pauseHoldUntil,
      normalizedCurrentUrl: args.normalizeUrl(currentVideoUrl),
      activeSharedUrl: args.runtimeState.activeSharedUrl,
      intendedPlayState: args.runtimeState.intendedPlayState,
      suppressedRemotePlayback: args.runtimeState.suppressedRemotePlayback,
    });
  }

  function rememberRemotePlaybackForSuppression(playback: PlaybackState): void {
    const url = args.normalizeUrl(playback.url);
    const remembered = rememberRemotePlaybackForSuppressionGuard({
      playback,
      normalizedUrl: url,
      now: nowOf(),
      remoteEchoSuppressionMs: args.remoteEchoSuppressionMs,
      remotePlayTransitionGuardMs: args.remotePlayTransitionGuardMs,
    });
    args.runtimeState.suppressedRemotePlayback =
      remembered.suppressedRemotePlayback;
    args.runtimeState.recentRemotePlayingIntent =
      remembered.recentRemotePlayingIntent;
    if (!url) {
      return;
    }
    args.debugLog(
      `Remember remote echo ${playback.playState} ${url} t=${playback.currentTime.toFixed(2)} rate=${playback.playbackRate.toFixed(2)}`,
    );
  }

  function shouldSuppressLocalEcho(
    video: HTMLVideoElement,
    currentVideo: SharedVideo,
    playState: PlaybackState["playState"],
  ): boolean {
    const decision = shouldSuppressLocalEchoGuard({
      suppressedRemotePlayback: args.runtimeState.suppressedRemotePlayback,
      normalizedCurrentUrl: args.normalizeUrl(currentVideo.url),
      playState,
      currentTime: video.currentTime,
      playbackRate: video.playbackRate,
      now: nowOf(),
    });

    if (
      args.runtimeState.suppressedRemotePlayback &&
      !decision.nextSuppressedRemotePlayback
    ) {
      args.debugLog(
        `Remote echo window expired for ${args.runtimeState.suppressedRemotePlayback.playState} ${args.runtimeState.suppressedRemotePlayback.url}`,
      );
      args.runtimeState.suppressedRemotePlayback =
        decision.nextSuppressedRemotePlayback;
    }

    if (
      args.runtimeState.suppressedRemotePlayback &&
      decision.nextSuppressedRemotePlayback &&
      args.normalizeUrl(currentVideo.url) !==
        args.runtimeState.suppressedRemotePlayback.url
    ) {
      args.debugLog(
        `Remote echo skipped by url ${currentVideo.url} != ${args.runtimeState.suppressedRemotePlayback.url}`,
      );
    } else if (
      args.runtimeState.suppressedRemotePlayback &&
      decision.nextSuppressedRemotePlayback &&
      playState !== args.runtimeState.suppressedRemotePlayback.playState
    ) {
      args.debugLog(
        `Remote echo skipped by playState ${playState} != ${args.runtimeState.suppressedRemotePlayback.playState}`,
      );
    } else if (
      args.runtimeState.suppressedRemotePlayback &&
      decision.nextSuppressedRemotePlayback &&
      Math.abs(
        video.playbackRate -
          args.runtimeState.suppressedRemotePlayback.playbackRate,
      ) > 0.01
    ) {
      args.debugLog(
        `Remote echo skipped by rate ${video.playbackRate.toFixed(2)} != ${args.runtimeState.suppressedRemotePlayback.playbackRate.toFixed(2)}`,
      );
    }

    const threshold = playState === "playing" ? 0.9 : 0.2;
    const delta = args.runtimeState.suppressedRemotePlayback
      ? Math.abs(
          video.currentTime -
            args.runtimeState.suppressedRemotePlayback.currentTime,
        )
      : Infinity;
    args.debugLog(
      `${decision.shouldSuppress ? "Suppressed" : "Allowed"} local echo ${playState} ${currentVideo.url} delta=${delta.toFixed(2)} threshold=${threshold.toFixed(2)}`,
    );
    return decision.shouldSuppress;
  }

  function shouldSuppressRemotePlayTransition(
    currentVideo: SharedVideo,
    playState: PlaybackState["playState"],
    currentTime: number,
  ): boolean {
    const decision = shouldSuppressRemotePlayTransitionGuard({
      recentRemotePlayingIntent: args.runtimeState.recentRemotePlayingIntent,
      normalizedCurrentUrl: args.normalizeUrl(currentVideo.url),
      playState,
      currentTime,
      lastExplicitPlaybackAction: args.runtimeState.lastExplicitPlaybackAction,
      now: nowOf(),
      userGestureGraceMs: args.userGestureGraceMs,
    });

    if (
      args.runtimeState.recentRemotePlayingIntent &&
      decision.nextRecentRemotePlayingIntent &&
      args.runtimeState.lastExplicitPlaybackAction &&
      nowOf() - args.runtimeState.lastExplicitPlaybackAction.at <
        args.userGestureGraceMs &&
      args.runtimeState.lastExplicitPlaybackAction.playState === "paused" &&
      playState === "paused"
    ) {
      args.debugLog(
        `Allowed remote play transition echo by explicit action ${playState} ${currentVideo.url}`,
      );
    }
    args.runtimeState.recentRemotePlayingIntent =
      decision.nextRecentRemotePlayingIntent;

    const delta = args.runtimeState.recentRemotePlayingIntent
      ? Math.abs(
          currentTime - args.runtimeState.recentRemotePlayingIntent.currentTime,
        )
      : Infinity;
    if (decision.shouldSuppress) {
      args.debugLog(
        `Suppressed remote play transition echo ${formatPlaybackDiagnostic({
          playState,
          url: currentVideo.url,
          targetTime: currentTime,
          result: "remote-play-transition",
          extra: `intentDelta=${delta.toFixed(2)}`,
        })}`,
      );
    }
    return decision.shouldSuppress;
  }

  function shouldApplySelfPlayback(
    video: HTMLVideoElement,
    playback: PlaybackState,
  ): boolean {
    return shouldApplySelfPlaybackGuard({
      videoPaused: video.paused,
      videoCurrentTime: video.currentTime,
      videoPlaybackRate: video.playbackRate,
      playback,
    });
  }

  function shouldIgnoreRemotePlaybackApply(
    video: HTMLVideoElement,
    playback: PlaybackState,
    isSelfPlayback: boolean,
  ): boolean {
    if (isSelfPlayback || playback.playState !== "playing" || video.paused) {
      return false;
    }

    if (Math.abs(video.playbackRate - playback.playbackRate) > 0.01) {
      return false;
    }

    const reconcileDecision = decidePlaybackReconcileMode({
      localCurrentTime: video.currentTime,
      targetTime: playback.currentTime,
      playState: playback.playState,
      isExplicitSeek: shouldTreatAsExplicitSeek({
        syncIntent: playback.syncIntent,
        playState: playback.playState,
      }),
    });

    return reconcileDecision.mode === "ignore";
  }

  function shouldSuppressUnexpectedPlaybackRateBroadcast(input: {
    playbackRate: number;
    currentVideoUrl: string;
    eventSource: LocalPlaybackEventSource;
    now: number;
  }): boolean {
    const hasRecentExplicitUserAction =
      Boolean(args.runtimeState.lastExplicitUserAction) &&
      input.now - (args.runtimeState.lastExplicitUserAction?.at ?? 0) <
        args.userGestureGraceMs;
    const hasRecentExplicitRatechange =
      args.runtimeState.lastExplicitUserAction?.kind === "ratechange" &&
      input.now - args.runtimeState.lastExplicitUserAction.at <
        args.userGestureGraceMs;

    if (
      hasRecentExplicitRatechange ||
      (hasRecentExplicitUserAction &&
        (input.eventSource === "play" ||
          input.eventSource === "playing" ||
          input.eventSource === "ratechange"))
    ) {
      return false;
    }

    if (
      Math.abs(input.playbackRate - args.runtimeState.intendedPlaybackRate) <=
      0.01
    ) {
      return false;
    }

    args.debugLog(
      `Skip broadcast ${formatPlaybackDiagnostic({
        actor: args.runtimeState.localMemberId,
        playState: "playing",
        url: input.currentVideoUrl,
        localTime: null,
        targetTime: args.runtimeState.intendedPlaybackRate,
        result: `unexpected-rate-${input.eventSource}`,
        extra: `localRate=${input.playbackRate.toFixed(2)} expectedRate=${args.runtimeState.intendedPlaybackRate.toFixed(2)}`,
      })}`,
    );
    return true;
  }

  function getBroadcastPlayState(argsForBroadcast: {
    video: HTMLVideoElement;
    eventSource: LocalPlaybackEventSource;
    now: number;
  }): PlaybackState["playState"] {
    const basePlayState = getPlayState(
      argsForBroadcast.video,
      args.runtimeState.intendedPlayState,
    );
    const hasRecentExplicitSeek =
      args.runtimeState.lastExplicitUserAction?.kind === "seek" &&
      argsForBroadcast.now - args.runtimeState.lastExplicitUserAction.at <
        args.userGestureGraceMs;

    if (
      hasRecentExplicitSeek &&
      args.runtimeState.intendedPlayState === "playing" &&
      (argsForBroadcast.eventSource === "seeking" ||
        argsForBroadcast.eventSource === "seeked" ||
        argsForBroadcast.eventSource === "pause" ||
        argsForBroadcast.eventSource === "waiting" ||
        argsForBroadcast.eventSource === "stalled")
    ) {
      return "playing";
    }

    return basePlayState;
  }

  async function broadcastPlayback(
    video: HTMLVideoElement,
    eventSource: LocalPlaybackEventSource = "manual",
  ): Promise<void> {
    const now = nowOf();
    if (!args.runtimeState.hydrationReady) {
      args.debugLog("Skip broadcast before hydration ready");
      args.debugLog(
        `Broadcast trace result=before-hydration ${formatBroadcastTrace({
          eventSource,
          currentVideoUrl: null,
          normalizedCurrentVideoUrl: null,
          playState: getPlayState(video, args.runtimeState.intendedPlayState),
          currentTime: video.currentTime,
          playbackRate: video.playbackRate,
        })}`,
      );
      return;
    }
    if (args.runtimeState.pendingRoomStateHydration) {
      if (
        !shouldSkipBroadcastWhileHydrating({
          pendingRoomStateHydration:
            args.runtimeState.pendingRoomStateHydration,
          now,
          lastUserGestureAt: args.runtimeState.lastUserGestureAt,
          userGestureGraceMs: args.userGestureGraceMs,
        })
      ) {
        args.debugLog(
          `Allowed user-initiated broadcast while waiting for initial room state of ${args.runtimeState.activeRoomCode ?? "unknown-room"}`,
        );
      } else {
        args.debugLog(
          `Skip broadcast while waiting for initial room state of ${args.runtimeState.activeRoomCode ?? "unknown-room"}`,
        );
        args.debugLog(
          `Broadcast trace result=hydration-gate ${formatBroadcastTrace({
            eventSource,
            currentVideoUrl: null,
            normalizedCurrentVideoUrl: null,
            playState: getPlayState(video, args.runtimeState.intendedPlayState),
            currentTime: video.currentTime,
            playbackRate: video.playbackRate,
          })}`,
        );
        return;
      }
    }

    const currentVideo = await args.getCurrentPlaybackVideo();
    if (!currentVideo) {
      args.debugLog(
        `Broadcast trace result=no-current-video ${formatBroadcastTrace({
          eventSource,
          currentVideoUrl: null,
          normalizedCurrentVideoUrl: null,
          playState: getPlayState(video, args.runtimeState.intendedPlayState),
          currentTime: video.currentTime,
          playbackRate: video.playbackRate,
        })}`,
      );
      return;
    }
    const hasRecentExplicitResumeIntent =
      (args.runtimeState.lastExplicitUserAction?.kind === "play" ||
        args.runtimeState.lastExplicitUserAction?.kind === "seek") &&
      now - args.runtimeState.lastExplicitUserAction.at <
        args.userGestureGraceMs;
    const normalizedCurrentVideoUrl = args.normalizeUrl(currentVideo.url);
    args.debugLog(
      `Broadcast trace result=enter ${formatBroadcastTrace({
        eventSource,
        currentVideoUrl: currentVideo.url,
        normalizedCurrentVideoUrl,
        playState: getPlayState(video, args.runtimeState.intendedPlayState),
        currentTime: video.currentTime,
        playbackRate: video.playbackRate,
      })}`,
    );
    if (
      args.runtimeState.activeRoomCode &&
      args.runtimeState.activeSharedUrl &&
      normalizedCurrentVideoUrl !== args.runtimeState.activeSharedUrl
    ) {
      if (
        shouldPauseForNonSharedBroadcast({
          activeRoomCode: args.runtimeState.activeRoomCode,
          activeSharedUrl: args.runtimeState.activeSharedUrl,
          normalizedCurrentVideoUrl,
          explicitNonSharedPlaybackUrl:
            args.runtimeState.explicitNonSharedPlaybackUrl,
          playState: getPlayState(video, args.runtimeState.intendedPlayState),
          lastExplicitPlaybackAction:
            args.runtimeState.lastExplicitPlaybackAction,
          now,
          userGestureGraceMs: args.userGestureGraceMs,
        })
      ) {
        args.runtimeState.intendedPlayState = "paused";
        activatePauseHold(args.initialRoomStatePauseHoldMs);
        window.setTimeout(() => {
          if (!video.paused) {
            pauseVideo(video);
          }
        }, 0);
      }
      args.debugLog(
        `Broadcast trace result=non-shared-page ${formatBroadcastTrace({
          eventSource,
          currentVideoUrl: currentVideo.url,
          normalizedCurrentVideoUrl,
          playState: getPlayState(video, args.runtimeState.intendedPlayState),
          currentTime: video.currentTime,
          playbackRate: video.playbackRate,
        })}`,
      );
      return;
    }

    const playState = getBroadcastPlayState({
      video,
      eventSource,
      now,
    });
    const programmaticDecision = shouldSuppressProgrammaticEventGuard({
      programmaticApplyUntil: args.runtimeState.programmaticApplyUntil,
      programmaticApplySignature: args.runtimeState.programmaticApplySignature,
      normalizedCurrentUrl: normalizedCurrentVideoUrl,
      playState,
      currentTime: video.currentTime,
      playbackRate: video.playbackRate,
      eventSource,
      lastExplicitUserAction: args.runtimeState.lastExplicitUserAction,
      now,
      userGestureGraceMs: args.userGestureGraceMs,
    });
    args.runtimeState.programmaticApplyUntil =
      programmaticDecision.nextProgrammaticApplyUntil;
    args.runtimeState.programmaticApplySignature =
      programmaticDecision.nextProgrammaticApplySignature;
    if (programmaticDecision.shouldSuppress) {
      args.debugLog(
        `Skip broadcast ${formatPlaybackDiagnostic({
          actor: args.runtimeState.localMemberId,
          playState,
          url: currentVideo.url,
          localTime: video.currentTime,
          targetTime:
            programmaticDecision.nextProgrammaticApplySignature?.currentTime ??
            video.currentTime,
          result: `programmatic-${eventSource}`,
        })}`,
      );
      args.debugLog(
        `Broadcast trace result=programmatic-suppress ${formatBroadcastTrace({
          eventSource,
          currentVideoUrl: currentVideo.url,
          normalizedCurrentVideoUrl,
          playState,
          currentTime: video.currentTime,
          playbackRate: video.playbackRate,
        })}`,
      );
      return;
    }
    if (
      args.runtimeState.lastExplicitUserAction &&
      now - args.runtimeState.lastExplicitUserAction.at <
        args.userGestureGraceMs &&
      (eventSource === "play" ||
        eventSource === "playing" ||
        eventSource === "pause" ||
        eventSource === "seeking" ||
        eventSource === "seeked" ||
        eventSource === "ratechange")
    ) {
      args.debugLog(
        `Allowed explicit user event actor=${args.runtimeState.localMemberId ?? "local"} playState=${playState} url=${currentVideo.url} delta=n/a result=${eventSource}`,
      );
    }
    if (
      shouldSuppressActiveSoftApplyBroadcast({
        normalizedCurrentUrl: normalizedCurrentVideoUrl,
        playState,
        eventSource,
        now,
      })
    ) {
      args.debugLog(
        `Broadcast trace result=soft-apply-suppress ${formatBroadcastTrace({
          eventSource,
          currentVideoUrl: currentVideo.url,
          normalizedCurrentVideoUrl,
          playState,
          currentTime: video.currentTime,
          playbackRate: video.playbackRate,
        })}`,
      );
      return;
    }
    if (
      shouldSuppressUnexpectedPlaybackRateBroadcast({
        playbackRate: video.playbackRate,
        currentVideoUrl: currentVideo.url,
        eventSource,
        now,
      })
    ) {
      args.debugLog(
        `Broadcast trace result=unexpected-rate-suppress ${formatBroadcastTrace(
          {
            eventSource,
            currentVideoUrl: currentVideo.url,
            normalizedCurrentVideoUrl,
            playState,
            currentTime: video.currentTime,
            playbackRate: video.playbackRate,
          },
        )}`,
      );
      return;
    }
    const followupDecision = shouldSuppressRemoteFollowupBroadcastGuard({
      remoteFollowPlayingUntil: args.runtimeState.remoteFollowPlayingUntil,
      remoteFollowPlayingUrl: args.runtimeState.remoteFollowPlayingUrl,
      normalizedCurrentUrl: normalizedCurrentVideoUrl,
      playState,
      eventSource,
      lastExplicitUserAction: args.runtimeState.lastExplicitUserAction,
      now,
      userGestureGraceMs: args.userGestureGraceMs,
    });
    args.runtimeState.remoteFollowPlayingUntil =
      followupDecision.nextRemoteFollowPlayingUntil;
    args.runtimeState.remoteFollowPlayingUrl =
      followupDecision.nextRemoteFollowPlayingUrl;
    if (followupDecision.shouldSuppress) {
      args.debugLog(
        `Skip broadcast ${formatPlaybackDiagnostic({
          actor: args.runtimeState.localMemberId,
          playState,
          url: currentVideo.url,
          localTime: video.currentTime,
          targetTime: video.currentTime,
          result: `remote-follow-${eventSource}`,
        })}`,
      );
      args.debugLog(
        `Broadcast trace result=remote-follow-suppress ${formatBroadcastTrace({
          eventSource,
          currentVideoUrl: currentVideo.url,
          normalizedCurrentVideoUrl,
          playState,
          currentTime: video.currentTime,
          playbackRate: video.playbackRate,
        })}`,
      );
      return;
    }

    if (
      playState === "playing" &&
      hasRecentRemoteStopIntent(currentVideo.url) &&
      !hasRecentExplicitResumeIntent &&
      now - args.runtimeState.lastUserGestureAt >= args.userGestureGraceMs
    ) {
      args.debugLog(
        `Skip broadcast ${formatPlaybackDiagnostic({
          actor: args.runtimeState.localMemberId,
          playState,
          url: currentVideo.url,
          localTime: video.currentTime,
          targetTime: video.currentTime,
          result: "remote-stop-hold",
        })}`,
      );
      args.runtimeState.intendedPlayState = "paused";
      window.setTimeout(() => {
        if (!video.paused) {
          pauseVideo(video);
        }
      }, 0);
      args.debugLog(
        `Broadcast trace result=remote-stop-hold ${formatBroadcastTrace({
          eventSource,
          currentVideoUrl: currentVideo.url,
          normalizedCurrentVideoUrl,
          playState,
          currentTime: video.currentTime,
          playbackRate: video.playbackRate,
        })}`,
      );
      return;
    }
    if (shouldSuppressLocalEcho(video, currentVideo, playState)) {
      args.debugLog(
        `Broadcast trace result=local-echo-suppress ${formatBroadcastTrace({
          eventSource,
          currentVideoUrl: currentVideo.url,
          normalizedCurrentVideoUrl,
          playState,
          currentTime: video.currentTime,
          playbackRate: video.playbackRate,
        })}`,
      );
      return;
    }
    if (
      shouldSuppressRemotePlayTransition(
        currentVideo,
        playState,
        video.currentTime,
      )
    ) {
      args.debugLog(
        `Broadcast trace result=remote-play-transition-suppress ${formatBroadcastTrace(
          {
            eventSource,
            currentVideoUrl: currentVideo.url,
            normalizedCurrentVideoUrl,
            playState,
            currentTime: video.currentTime,
            playbackRate: video.playbackRate,
          },
        )}`,
      );
      return;
    }

    args.markBroadcastAt(now);
    args.runtimeState.intendedPlayState = playState;
    args.runtimeState.intendedPlaybackRate = video.playbackRate;
    args.runtimeState.lastLocalIntentAt = now;
    args.runtimeState.lastLocalIntentPlayState = playState;

    const payload = createPlaybackBroadcastPayload({
      currentVideo,
      currentTime: video.currentTime,
      playState,
      syncIntent: derivePlaybackSyncIntent({
        eventSource,
        lastExplicitUserAction: args.runtimeState.lastExplicitUserAction,
        now,
        userGestureGraceMs: args.userGestureGraceMs,
      }),
      playbackRate: video.playbackRate,
      actorId: args.runtimeState.localMemberId ?? "local",
      seq: args.nextSeq(),
      now,
    });
    rememberPendingLocalPlaybackOverride(payload, now);

    args.debugLog(
      `Dispatch playback update actor=${payload.actorId} playState=${payload.playState} url=${payload.url} delta=0.00 result=dispatch seq=${payload.seq} source=${eventSource} intent=${payload.syncIntent ?? "none"} rate=${payload.playbackRate.toFixed(2)}`,
    );

    const response = await args.runtimeSendMessage({
      type: "content:playback-update",
      payload,
    });
    if (response === null) {
      args.debugLog(
        `Dropped playback update actor=${payload.actorId} playState=${payload.playState} url=${payload.url} delta=0.00 result=no-response seq=${payload.seq} source=${eventSource} intent=${payload.syncIntent ?? "none"} rate=${payload.playbackRate.toFixed(2)}`,
      );
      return;
    }
    args.runtimeState.lastLocalPlaybackVersion = {
      serverTime: payload.serverTime,
      seq: payload.seq,
    };
    if (
      args.shouldLogHeartbeat(
        args.broadcastLogState,
        `${playState}|${args.normalizeUrl(currentVideo.url) ?? currentVideo.url}`,
        now,
      )
    ) {
      args.debugLog(
        `Broadcast playback ${formatPlaybackDiagnostic({
          actor: payload.actorId,
          playState,
          url: currentVideo.url,
          localTime: video.currentTime,
          targetTime: payload.currentTime,
          result: "broadcast",
          extra: `seq=${payload.seq} source=${eventSource} intent=${payload.syncIntent ?? "none"} rate=${payload.playbackRate.toFixed(2)}`,
        })}`,
      );
    }
  }

  async function applyRoomState(
    state: RoomState,
    shareToast: SharedVideoToastPayload | null = null,
  ): Promise<void> {
    args.notifyRoomStateToasts(state);
    args.maybeShowSharedVideoToast(shareToast, state);

    const currentVideo = args.getSharedVideo();
    const normalizedSharedUrl = args.normalizeUrl(state.sharedVideo?.url);
    const normalizedCurrentUrl = args.normalizeUrl(currentVideo?.url);
    const normalizedPlaybackUrl = args.normalizeUrl(state.playback?.url);

    const decision = decidePlaybackApplication({
      roomState: state,
      currentVideo,
      normalizedSharedUrl,
      normalizedCurrentUrl,
      normalizedPlaybackUrl,
      pendingRoomStateHydration: args.runtimeState.pendingRoomStateHydration,
      explicitNonSharedPlaybackUrl:
        args.runtimeState.explicitNonSharedPlaybackUrl,
      now: nowOf(),
      lastLocalIntentAt: args.runtimeState.lastLocalIntentAt,
      lastLocalIntentPlayState: args.runtimeState.lastLocalIntentPlayState,
      localIntentGuardMs: args.localIntentGuardMs,
      lastAppliedVersion: state.playback
        ? (args.lastAppliedVersionByActor.get(state.playback.actorId) ?? null)
        : null,
      lastLocalPlaybackVersion: args.runtimeState.lastLocalPlaybackVersion,
      localMemberId: args.runtimeState.localMemberId,
    });

    if (decision.kind === "empty-room") {
      cancelActiveSoftApply(args.getVideoElement(), "room-empty");
      args.runtimeState.activeSharedUrl = null;
      clearRemoteFollowPlayingWindow();
      if (decision.acceptedHydration) {
        args.debugLog(`Accepted empty room state for ${state.roomCode}`);
        acceptInitialRoomStateHydration();
      }
      return;
    }

    if (decision.kind === "no-current-video") {
      cancelActiveSoftApply(args.getVideoElement(), "no-current-video");
      return;
    }

    if (args.runtimeState.activeSharedUrl !== normalizedSharedUrl) {
      args.runtimeState.activeSharedUrl = normalizedSharedUrl ?? null;
      resetPlaybackSyncState(
        `shared url changed to ${state.sharedVideo?.url ?? "none"}`,
      );
      args.runtimeState.intendedPlayState = "paused";
      args.runtimeState.intendedPlaybackRate = 1;
      args.debugLog(
        `Reset local sync state for shared url ${state.sharedVideo?.url ?? "none"}`,
      );
    }

    if (decision.kind === "ignore-non-shared") {
      cancelActiveSoftApply(args.getVideoElement(), "non-shared-page");
      args.debugLog(
        `Ignored room state for ${state.sharedVideo?.url ?? "none"} on current page ${currentVideo?.url ?? "none"}`,
      );
      if (decision.acceptedHydration) {
        acceptInitialRoomStateHydration();
        args.runtimeState.intendedPlayState = "paused";
        args.runtimeState.intendedPlaybackRate = 1;
        activatePauseHold(args.initialRoomStatePauseHoldMs);
        const video = args.getVideoElement();
        if (video && !video.paused && decision.shouldPauseNonSharedVideo) {
          pauseVideo(video);
        }
      }
      return;
    }

    const video = args.getVideoElement();
    if (!video) {
      args.debugLog(
        `Deferred room state because video element is not ready for ${state.sharedVideo.url}`,
      );
      scheduleHydrationRetry();
      return;
    }

    if (decision.kind === "ignore-local-guard") {
      acceptInitialRoomStateHydrationIfPending();
      logIgnoredRemotePlayback({
        playback: state.playback,
        video,
        result: "local-intent-guard",
        extra: `seq=${state.playback.seq} localIntent=${args.runtimeState.lastLocalIntentPlayState ?? "none"}`,
      });
      return;
    }

    const pendingLocalPlaybackOverrideDecision =
      getPendingLocalPlaybackOverrideDecision(state.playback);
    if (pendingLocalPlaybackOverrideDecision.shouldIgnore) {
      acceptInitialRoomStateHydrationIfPending();
      logIgnoredRemotePlayback({
        playback: state.playback,
        video,
        result:
          pendingLocalPlaybackOverrideDecision.reason ??
          "pending-local-playback-override",
        extra: pendingLocalPlaybackOverrideDecision.extra,
      });
      return;
    }

    if (decision.kind === "ignore-stale-playback") {
      acceptInitialRoomStateHydrationIfPending();
      logIgnoredRemotePlayback({
        playback: state.playback,
        video,
        result: "stale-playback",
        extra: `seq=${state.playback.seq}`,
      });
      return;
    }

    if (decision.kind === "ignore-self-playback-version") {
      acceptInitialRoomStateHydrationIfPending();
      if (
        args.shouldLogHeartbeat(
          args.ignoredSelfPlaybackLogState,
          `${state.playback.actorId}|${state.playback.seq}|${args.normalizeUrl(state.playback.url) ?? state.playback.url}`,
        )
      ) {
        args.debugLog(
          `Ignored self playback ${formatPlaybackDiagnostic({
            actor: state.playback.actorId,
            playState: state.playback.playState,
            url: state.playback.url,
            localTime: video.currentTime,
            targetTime: state.playback.currentTime,
            result: "self-playback-version-noop",
            extra: `seq=${state.playback.seq} localSeq=${args.runtimeState.lastLocalPlaybackVersion?.seq ?? "none"}`,
          })}`,
        );
      }
      return;
    }

    const softApplyCancelReason = shouldCancelActiveSoftApplyForPlayback(
      state.playback,
    );
    if (softApplyCancelReason) {
      cancelActiveSoftApply(video, softApplyCancelReason);
    }

    args.lastAppliedVersionByActor.set(state.playback.actorId, {
      serverTime: state.playback.serverTime,
      seq: state.playback.seq,
    });

    if (
      decision.isSelfPlayback &&
      !shouldApplySelfPlayback(video, state.playback)
    ) {
      if (
        args.shouldLogHeartbeat(
          args.ignoredSelfPlaybackLogState,
          `${state.playback.actorId}|${state.playback.playState}|${args.normalizeUrl(state.playback.url) ?? state.playback.url}`,
        )
      ) {
        args.debugLog(
          `Ignored self playback ${formatPlaybackDiagnostic({
            actor: state.playback.actorId,
            playState: state.playback.playState,
            url: state.playback.url,
            localTime: video.currentTime,
            targetTime: state.playback.currentTime,
            result: "self-playback-noop",
            extra: `seq=${state.playback.seq} localPaused=${video.paused}`,
          })}`,
        );
      }
      return;
    }

    if (
      shouldIgnoreRemotePlaybackApply(
        video,
        state.playback,
        decision.isSelfPlayback,
      )
    ) {
      acceptInitialRoomStateHydrationIfPending();
      rememberRemoteFollowPlayingWindow(state.playback);
      args.runtimeState.intendedPlayState = state.playback.playState;
      args.runtimeState.intendedPlaybackRate = state.playback.playbackRate;
      logIgnoredRemotePlayback({
        playback: state.playback,
        video,
        result: "within-threshold-noop",
        extra: `seq=${state.playback.seq}`,
      });
      return;
    }

    rememberRemotePlaybackForSuppression(state.playback);
    if (
      state.playback.playState === "paused" ||
      state.playback.playState === "buffering"
    ) {
      clearRemoteFollowPlayingWindow();
      activatePauseHold(
        args.runtimeState.pendingRoomStateHydration ||
          !args.runtimeState.hasReceivedInitialRoomState
          ? args.initialRoomStatePauseHoldMs
          : args.pauseHoldMs,
      );
    } else if (!decision.isSelfPlayback) {
      rememberRemoteFollowPlayingWindow(state.playback);
    }

    args.runtimeState.intendedPlayState = state.playback.playState;
    args.runtimeState.intendedPlaybackRate = state.playback.playbackRate;
    args.debugLog(
      `Apply playback ${formatPlaybackDiagnostic({
        actor: state.playback.actorId,
        playState: state.playback.playState,
        url: state.sharedVideo.url,
        localTime: video.currentTime,
        targetTime: state.playback.currentTime,
        result: "apply",
        extra: `seq=${state.playback.seq}`,
      })}`,
    );

    args.runtimeState.pendingPlaybackApplication = { ...state.playback };
    if (canApplyPlaybackImmediately(video)) {
      applyPendingPlaybackApplication(video);
    } else {
      armProgrammaticApplyWindow(
        createProgrammaticPlaybackSignature(state.playback),
        "pending",
        state.playback.actorId,
      );
      args.debugLog(
        `Deferred playback apply until metadata is ready ${state.sharedVideo.url}`,
      );
    }

    acceptInitialRoomStateHydration();
  }

  async function hydrateRoomState(): Promise<void> {
    const retryTimer = args.getHydrateRetryTimer();
    if (retryTimer !== null) {
      window.clearTimeout(retryTimer);
      args.setHydrateRetryTimer(null);
    }

    const response = await args.runtimeSendMessage<{
      ok?: boolean;
      roomState?: RoomState;
      memberId?: string | null;
      roomCode?: string | null;
    }>({
      type: "content:get-room-state",
    });
    if (response === null) {
      args.runtimeState.hydrationReady = true;
      return;
    }
    args.runtimeState.localMemberId = response?.memberId ?? null;
    args.runtimeState.activeRoomCode =
      response?.roomCode ?? args.runtimeState.activeRoomCode;

    if (response?.ok && response.roomState) {
      args.debugLog(
        `Hydrate room state success for ${response.roomState.roomCode}`,
      );
      if (
        response.roomState.playback?.playState === "paused" ||
        response.roomState.playback?.playState === "buffering"
      ) {
        args.runtimeState.intendedPlayState =
          response.roomState.playback.playState;
        activatePauseHold(args.initialRoomStatePauseHoldMs);
      }
      const video = args.getVideoElement();
      if (
        video &&
        !video.paused &&
        (response.roomState.playback?.playState === "paused" ||
          response.roomState.playback?.playState === "buffering") &&
        nowOf() - args.runtimeState.lastUserGestureAt >= args.userGestureGraceMs
      ) {
        args.runtimeState.intendedPlayState =
          response.roomState.playback.playState;
        args.debugLog(
          `Suppressed autoplay during hydrate for ${response.roomState.roomCode}`,
        );
        pauseVideo(video);
      }
      await applyRoomState(response.roomState as RoomState);
      args.runtimeState.hydrationReady = true;
      return;
    }

    if (!response?.roomCode) {
      args.runtimeState.pendingRoomStateHydration = false;
    }

    if (!response?.memberId) {
      args.debugLog("Hydrate skipped without member id");
      args.runtimeState.hydrationReady = true;
      return;
    }

    args.debugLog(
      `Hydrate pending for ${response.roomCode ?? args.runtimeState.activeRoomCode ?? "unknown-room"}, retry scheduled`,
    );
    scheduleHydrationRetry(1500);
  }

  return {
    resetPlaybackSyncState,
    hasRecentRemoteStopIntent,
    cancelActiveSoftApply,
    maintainActiveSoftApply,
    applyPendingPlaybackApplication,
    broadcastPlayback,
    applyRoomState,
    hydrateRoomState,
    scheduleHydrationRetry,
  };
}
