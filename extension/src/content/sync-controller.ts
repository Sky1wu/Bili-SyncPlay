import type {
  PlaybackState,
  RoomState,
  SharedVideo,
} from "@bili-syncplay/protocol";
import type { SharedVideoToastPayload } from "../shared/messages";
import {
  createPlaybackBroadcastPayload,
  derivePlaybackSyncIntent,
  shouldPauseForNonSharedBroadcast,
  shouldSkipBroadcastWhileHydrating,
} from "./playback-broadcast";
import {
  applyPendingPlaybackApplication as applyPendingPlaybackApplicationWithBinding,
  createProgrammaticPlaybackSignature,
  getPlayState,
  pauseVideo,
} from "./player-binding";
import {
  decidePlaybackReconcileMode,
  formatPlaybackReconcileDecision,
  shouldTreatAsExplicitSeek,
} from "./playback-reconcile";
import { createRoomStateApplyController } from "./room-state-apply-controller";
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
  const SOFT_APPLY_COOLDOWN_MS = 2_500;
  const nowOf = () => args.getNow?.() ?? Date.now();
  let activeSoftApply: {
    normalizedUrl: string;
    targetTime: number;
    restorePlaybackRate: number;
    deadlineAt: number;
  } | null = null;
  let activeSoftApplyTimer: number | null = null;
  const ignoredRemotePlaybackLogState = { key: null as string | null, at: 0 };
  const localEchoLogState = { key: null as string | null, at: 0 };
  const dispatchPlaybackLogState = { key: null as string | null, at: 0 };

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

  function logHeartbeatMessage(
    state: { key: string | null; at: number },
    key: string,
    message: string,
    now = nowOf(),
  ): void {
    if (args.shouldLogHeartbeat(state, key, now)) {
      args.debugLog(message);
    }
  }

  function logBroadcastTrace(
    result: string,
    eventSource: LocalPlaybackEventSource,
    trace: string,
    _normalizedUrl: string | null,
    _now = nowOf(),
  ): void {
    if (
      eventSource === "timeupdate" ||
      eventSource === "canplay" ||
      eventSource === "playing" ||
      eventSource === "seeked"
    ) {
      return;
    }
    args.debugLog(`Broadcast trace result=${result} ${trace}`);
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

  function armSoftApplyCooldown(normalizedUrl: string, reason: string): void {
    args.runtimeState.softApplyCooldownUrl = normalizedUrl;
    args.runtimeState.softApplyCooldownUntil = nowOf() + SOFT_APPLY_COOLDOWN_MS;
    args.debugLog(
      `Soft apply cooldown armed url=${normalizedUrl} result=${reason} until=${args.runtimeState.softApplyCooldownUntil}`,
    );
  }

  function clearSoftApplyCooldown(): void {
    args.runtimeState.softApplyCooldownUntil = 0;
    args.runtimeState.softApplyCooldownUrl = null;
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
    if (reason === "converged" || reason === "apply-hard-seek") {
      armSoftApplyCooldown(session.normalizedUrl, reason);
    } else if (
      args.runtimeState.softApplyCooldownUrl === session.normalizedUrl
    ) {
      clearSoftApplyCooldown();
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
    clearSoftApplyCooldown();
    args.runtimeState.lastLocalPlaybackVersion = null;
    args.runtimeState.intendedPlaybackRate = 1;
    args.runtimeState.lastNonSharedGuardUrl = null;
    args.runtimeState.lastExplicitPlaybackAction = null;
    args.runtimeState.explicitNonSharedPlaybackUrl = null;
    args.debugLog(`Reset playback sync state: ${reason}`);
  }

  function applyPendingPlaybackApplication(video: HTMLVideoElement): void {
    const result = applyPendingPlaybackApplicationWithBinding({
      video,
      pendingPlaybackApplication: args.runtimeState.pendingPlaybackApplication,
      clearPendingPlaybackApplication: () => {
        args.runtimeState.pendingPlaybackApplication = null;
      },
      onPlaybackAdjusted: (adjustment, playback) => {
        if (adjustment.mode !== "soft-apply") {
          clearSoftApplyCooldown();
        }
        args.debugLog(
          `Playback reconcile actor=${playback.actorId} playState=${playback.playState} url=${playback.url} ${formatPlaybackReconcileDecision(
            {
              mode: adjustment.mode,
              reason: adjustment.reason,
              delta: adjustment.delta,
            },
          )} wroteTime=${adjustment.didWriteCurrentTime} wroteRate=${adjustment.didWritePlaybackRate} targetTime=${adjustment.targetTime.toFixed(2)} appliedTime=${adjustment.currentTime.toFixed(2)} appliedRate=${adjustment.playbackRate.toFixed(2)} restoreRate=${adjustment.restorePlaybackRate.toFixed(2)}`,
        );
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
        `Skipped noop playback apply because reconcile stayed within ignore threshold reason=${result.adjustment.reason} delta=${result.adjustment.delta.toFixed(2)}`,
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

  function shouldSuppressBySoftApplyCooldown(
    video: HTMLVideoElement,
    playback: PlaybackState,
  ): boolean {
    if (
      args.runtimeState.softApplyCooldownUntil <= nowOf() ||
      !args.runtimeState.softApplyCooldownUrl
    ) {
      return false;
    }

    const normalizedUrl = args.normalizeUrl(playback.url);
    if (
      !normalizedUrl ||
      normalizedUrl !== args.runtimeState.softApplyCooldownUrl ||
      video.paused ||
      playback.playState !== "playing" ||
      playback.syncIntent === "explicit-seek" ||
      playback.syncIntent === "explicit-ratechange"
    ) {
      return false;
    }

    const decision = decidePlaybackReconcileMode({
      localCurrentTime: video.currentTime,
      targetTime: playback.currentTime,
      playState: playback.playState,
      playbackRate: playback.playbackRate,
      isExplicitSeek: shouldTreatAsExplicitSeek({
        syncIntent: playback.syncIntent,
        playState: playback.playState,
      }),
    });

    return decision.mode === "rate-only" || decision.mode === "soft-apply";
  }

  function logIgnoredRemotePlayback(argsForLog: {
    playback: PlaybackState;
    video: HTMLVideoElement;
    result: string;
    extra?: string;
  }): void {
    logHeartbeatMessage(
      ignoredRemotePlaybackLogState,
      `${argsForLog.playback.actorId}|${argsForLog.playback.playState}|${argsForLog.result}|${args.normalizeUrl(argsForLog.playback.url) ?? argsForLog.playback.url}`,
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
    logHeartbeatMessage(
      localEchoLogState,
      `${decision.shouldSuppress ? "suppress" : "allow"}|${playState}|${args.normalizeUrl(currentVideo.url) ?? currentVideo.url}`,
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

  function shouldLogSuppressedBroadcastDetail(
    eventSource: LocalPlaybackEventSource,
  ): boolean {
    return !(
      eventSource === "timeupdate" ||
      eventSource === "canplay" ||
      eventSource === "playing" ||
      eventSource === "seeked"
    );
  }

  async function broadcastPlayback(
    video: HTMLVideoElement,
    eventSource: LocalPlaybackEventSource = "manual",
  ): Promise<void> {
    const now = nowOf();
    if (!args.runtimeState.hydrationReady) {
      args.debugLog("Skip broadcast before hydration ready");
      logBroadcastTrace(
        "before-hydration",
        eventSource,
        formatBroadcastTrace({
          eventSource,
          currentVideoUrl: null,
          normalizedCurrentVideoUrl: null,
          playState: getPlayState(video, args.runtimeState.intendedPlayState),
          currentTime: video.currentTime,
          playbackRate: video.playbackRate,
        }),
        null,
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
        logBroadcastTrace(
          "hydration-gate",
          eventSource,
          formatBroadcastTrace({
            eventSource,
            currentVideoUrl: null,
            normalizedCurrentVideoUrl: null,
            playState: getPlayState(video, args.runtimeState.intendedPlayState),
            currentTime: video.currentTime,
            playbackRate: video.playbackRate,
          }),
          null,
          now,
        );
        return;
      }
    }

    const currentVideo = await args.getCurrentPlaybackVideo();
    if (!currentVideo) {
      logBroadcastTrace(
        "no-current-video",
        eventSource,
        formatBroadcastTrace({
          eventSource,
          currentVideoUrl: null,
          normalizedCurrentVideoUrl: null,
          playState: getPlayState(video, args.runtimeState.intendedPlayState),
          currentTime: video.currentTime,
          playbackRate: video.playbackRate,
        }),
        null,
        now,
      );
      return;
    }
    const hasRecentExplicitResumeIntent =
      (args.runtimeState.lastExplicitUserAction?.kind === "play" ||
        args.runtimeState.lastExplicitUserAction?.kind === "seek") &&
      now - args.runtimeState.lastExplicitUserAction.at <
        args.userGestureGraceMs;
    const normalizedCurrentVideoUrl = args.normalizeUrl(currentVideo.url);
    logBroadcastTrace(
      "enter",
      eventSource,
      formatBroadcastTrace({
        eventSource,
        currentVideoUrl: currentVideo.url,
        normalizedCurrentVideoUrl,
        playState: getPlayState(video, args.runtimeState.intendedPlayState),
        currentTime: video.currentTime,
        playbackRate: video.playbackRate,
      }),
      normalizedCurrentVideoUrl,
      now,
    );
    if (
      args.runtimeState.activeRoomCode &&
      args.runtimeState.activeSharedUrl &&
      normalizedCurrentVideoUrl !== args.runtimeState.activeSharedUrl
    ) {
      if (
        normalizedCurrentVideoUrl !== args.runtimeState.lastNonSharedGuardUrl &&
        normalizedCurrentVideoUrl !== null
      ) {
        args.runtimeState.lastNonSharedGuardUrl = normalizedCurrentVideoUrl;
        args.runtimeState.lastExplicitPlaybackAction = null;
      }
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
        args.runtimeState.lastForcedPauseAt = now;
        activatePauseHold(args.initialRoomStatePauseHoldMs);
        window.setTimeout(() => {
          if (!video.paused) {
            pauseVideo(video);
          }
        }, 0);
      }
      logBroadcastTrace(
        "non-shared-page",
        eventSource,
        formatBroadcastTrace({
          eventSource,
          currentVideoUrl: currentVideo.url,
          normalizedCurrentVideoUrl,
          playState: getPlayState(video, args.runtimeState.intendedPlayState),
          currentTime: video.currentTime,
          playbackRate: video.playbackRate,
        }),
        normalizedCurrentVideoUrl,
        now,
      );
      return;
    }

    args.runtimeState.lastNonSharedGuardUrl = null;

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
      if (shouldLogSuppressedBroadcastDetail(eventSource)) {
        args.debugLog(
          `Skip broadcast ${formatPlaybackDiagnostic({
            actor: args.runtimeState.localMemberId,
            playState,
            url: currentVideo.url,
            localTime: video.currentTime,
            targetTime:
              programmaticDecision.nextProgrammaticApplySignature
                ?.currentTime ?? video.currentTime,
            result: `programmatic-${eventSource}`,
          })}`,
        );
      }
      logBroadcastTrace(
        "programmatic-suppress",
        eventSource,
        formatBroadcastTrace({
          eventSource,
          currentVideoUrl: currentVideo.url,
          normalizedCurrentVideoUrl,
          playState,
          currentTime: video.currentTime,
          playbackRate: video.playbackRate,
        }),
        normalizedCurrentVideoUrl,
        now,
      );
      return;
    }
    if (
      args.runtimeState.lastExplicitUserAction &&
      args.runtimeState.lastExplicitUserAction.at >
        args.runtimeState.lastForcedPauseAt &&
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
      logBroadcastTrace(
        "soft-apply-suppress",
        eventSource,
        formatBroadcastTrace({
          eventSource,
          currentVideoUrl: currentVideo.url,
          normalizedCurrentVideoUrl,
          playState,
          currentTime: video.currentTime,
          playbackRate: video.playbackRate,
        }),
        normalizedCurrentVideoUrl,
        now,
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
      logBroadcastTrace(
        "unexpected-rate-suppress",
        eventSource,
        formatBroadcastTrace({
          eventSource,
          currentVideoUrl: currentVideo.url,
          normalizedCurrentVideoUrl,
          playState,
          currentTime: video.currentTime,
          playbackRate: video.playbackRate,
        }),
        normalizedCurrentVideoUrl,
        now,
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
      if (shouldLogSuppressedBroadcastDetail(eventSource)) {
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
      }
      logBroadcastTrace(
        "remote-follow-suppress",
        eventSource,
        formatBroadcastTrace({
          eventSource,
          currentVideoUrl: currentVideo.url,
          normalizedCurrentVideoUrl,
          playState,
          currentTime: video.currentTime,
          playbackRate: video.playbackRate,
        }),
        normalizedCurrentVideoUrl,
        now,
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
      args.runtimeState.lastForcedPauseAt = now;
      window.setTimeout(() => {
        if (!video.paused) {
          pauseVideo(video);
        }
      }, 0);
      logBroadcastTrace(
        "remote-stop-hold",
        eventSource,
        formatBroadcastTrace({
          eventSource,
          currentVideoUrl: currentVideo.url,
          normalizedCurrentVideoUrl,
          playState,
          currentTime: video.currentTime,
          playbackRate: video.playbackRate,
        }),
        normalizedCurrentVideoUrl,
        now,
      );
      return;
    }
    if (shouldSuppressLocalEcho(video, currentVideo, playState)) {
      logBroadcastTrace(
        "local-echo-suppress",
        eventSource,
        formatBroadcastTrace({
          eventSource,
          currentVideoUrl: currentVideo.url,
          normalizedCurrentVideoUrl,
          playState,
          currentTime: video.currentTime,
          playbackRate: video.playbackRate,
        }),
        normalizedCurrentVideoUrl,
        now,
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
      logBroadcastTrace(
        "remote-play-transition-suppress",
        eventSource,
        formatBroadcastTrace({
          eventSource,
          currentVideoUrl: currentVideo.url,
          normalizedCurrentVideoUrl,
          playState,
          currentTime: video.currentTime,
          playbackRate: video.playbackRate,
        }),
        normalizedCurrentVideoUrl,
        now,
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
        lastForcedPauseAt: args.runtimeState.lastForcedPauseAt,
        now,
        userGestureGraceMs: args.userGestureGraceMs,
      }),
      playbackRate: video.playbackRate,
      actorId: args.runtimeState.localMemberId ?? "local",
      seq: args.nextSeq(),
      now,
    });
    rememberPendingLocalPlaybackOverride(payload, now);

    if (eventSource === "timeupdate") {
      logHeartbeatMessage(
        dispatchPlaybackLogState,
        `${payload.playState}|${args.normalizeUrl(payload.url) ?? payload.url}|dispatch`,
        `Dispatch playback update actor=${payload.actorId} playState=${payload.playState} url=${payload.url} delta=0.00 result=dispatch seq=${payload.seq} source=${eventSource} intent=${payload.syncIntent ?? "none"} rate=${payload.playbackRate.toFixed(2)}`,
        now,
      );
    } else {
      args.debugLog(
        `Dispatch playback update actor=${payload.actorId} playState=${payload.playState} url=${payload.url} delta=0.00 result=dispatch seq=${payload.seq} source=${eventSource} intent=${payload.syncIntent ?? "none"} rate=${payload.playbackRate.toFixed(2)}`,
      );
    }

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
  const roomStateApplyController = createRoomStateApplyController({
    runtimeState: args.runtimeState,
    lastAppliedVersionByActor: args.lastAppliedVersionByActor,
    ignoredSelfPlaybackLogState: args.ignoredSelfPlaybackLogState,
    localIntentGuardMs: args.localIntentGuardMs,
    pauseHoldMs: args.pauseHoldMs,
    initialRoomStatePauseHoldMs: args.initialRoomStatePauseHoldMs,
    userGestureGraceMs: args.userGestureGraceMs,
    getNow: args.getNow,
    debugLog: args.debugLog,
    shouldLogHeartbeat: args.shouldLogHeartbeat,
    runtimeSendMessage: args.runtimeSendMessage,
    getHydrateRetryTimer: args.getHydrateRetryTimer,
    setHydrateRetryTimer: args.setHydrateRetryTimer,
    getVideoElement: args.getVideoElement,
    getSharedVideo: args.getSharedVideo,
    normalizeUrl: args.normalizeUrl,
    notifyRoomStateToasts: args.notifyRoomStateToasts,
    maybeShowSharedVideoToast: args.maybeShowSharedVideoToast,
    cancelActiveSoftApply,
    resetPlaybackSyncState,
    activatePauseHold,
    clearRemoteFollowPlayingWindow,
    acceptInitialRoomStateHydration,
    acceptInitialRoomStateHydrationIfPending,
    logIgnoredRemotePlayback,
    getPendingLocalPlaybackOverrideDecision,
    shouldCancelActiveSoftApplyForPlayback,
    shouldApplySelfPlayback,
    shouldIgnoreRemotePlaybackApply,
    shouldSuppressRemotePlaybackByCooldown: shouldSuppressBySoftApplyCooldown,
    rememberRemoteFollowPlayingWindow,
    rememberRemotePlaybackForSuppression,
    armProgrammaticApplyWindow,
    applyPendingPlaybackApplication,
    formatPlaybackDiagnostic,
  });

  return {
    resetPlaybackSyncState,
    hasRecentRemoteStopIntent,
    cancelActiveSoftApply,
    maintainActiveSoftApply,
    applyPendingPlaybackApplication,
    broadcastPlayback,
    applyRoomState: roomStateApplyController.applyRoomState,
    hydrateRoomState: roomStateApplyController.hydrateRoomState,
    scheduleHydrationRetry: roomStateApplyController.scheduleHydrationRetry,
  };
}
