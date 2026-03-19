import {
  normalizeBilibiliUrl,
  parseBilibiliVideoRef,
  type ClientMessage,
  type PlaybackState,
  type RoomState,
  type ServerMessage,
  type SharedVideo,
} from "@bili-syncplay/protocol";
import type {
  BackgroundToContentMessage,
  BackgroundToPopupMessage,
  ContentToBackgroundMessage,
  DebugLogEntry,
  PopupToBackgroundMessage,
  SharedVideoToastPayload,
} from "../shared/messages";
import {
  createPendingLocalShareExpiry,
  decideIncomingRoomState,
  getActivePendingLocalShareUrl,
  isSharedVideoChange,
  PENDING_LOCAL_SHARE_TIMEOUT_MS,
  preparePendingLocalShareCleanup,
  preparePendingLocalShareCleanupForRoomLifecycle,
  type RoomLifecycleAction,
  shouldClearPendingLocalShareOnServerUrlChange,
} from "./room-state";
import {
  compensateRoomStateForClock,
  CLOCK_SYNC_INTERVAL_MS,
  toConnectionCheckUrl as buildConnectionCheckUrl,
  toHealthcheckUrl as buildHealthcheckUrl,
  updateClockSample,
} from "./clock-sync";
import { notifyContentTabs } from "./content-bus";
import { appendLog, formatContentLogSource } from "./logger";
import { bootstrapBackground } from "./bootstrap";
import { getConnectionErrorMessage } from "./connection-error";
import { createPopupStateSnapshot } from "./popup-bus";
import {
  createPendingShareToast as createRoomPendingShareToast,
  flushPendingShare as getPendingShareFlushPlan,
  getPendingShareToastFor as getRoomPendingShareToastFor,
} from "./room-manager";
import {
  BILIBILI_VIDEO_URL_PATTERNS,
  DEFAULT_SERVER_URL,
  MAX_RECONNECT_ATTEMPTS,
  SHARE_TOAST_TTL_MS,
} from "./runtime-state";
import { createBackgroundStateStore } from "./state-store";
import { validateServerUrl } from "./server-url";
import { shouldReconnect, getReconnectDelayMs } from "./socket-manager";
import {
  loadPersistedBackgroundSnapshot,
  persistBackgroundState,
} from "./storage-manager";
import {
  decideSharedPlaybackTab,
  rememberSharedSource,
} from "./tab-coordinator";
import { localizeServerError, t } from "../shared/i18n";

const stateStore = createBackgroundStateStore();
const connectionState = stateStore.getState().connection;
const roomSessionState = stateStore.getState().room;
const shareState = stateStore.getState().share;
const clockState = stateStore.getState().clock;
const diagnosticsState = stateStore.getState().diagnostics;
let pendingJoinAttemptResolvers: Array<
  (result: "joined" | "failed" | "timeout") => void
> = [];
const HEARTBEAT_LOG_INTERVAL_MS = 10000;
const ADMIN_SESSION_RESET_REASONS = new Set([
  "Admin kicked member",
  "Admin disconnected session",
  "Admin closed room",
]);
const outgoingMessageLogState = new Map<string, number>();
const incomingMessageLogState = new Map<string, number>();
const popupPorts = new Set<chrome.runtime.Port>();

bootstrap().catch(console.error);

async function bootstrap(): Promise<void> {
  await bootstrapBackground({
    state: {
      get roomCode() {
        return roomSessionState.roomCode;
      },
      set roomCode(value) {
        roomSessionState.roomCode = value;
      },
      get joinToken() {
        return roomSessionState.joinToken;
      },
      set joinToken(value) {
        roomSessionState.joinToken = value;
      },
      get memberToken() {
        return roomSessionState.memberToken;
      },
      set memberToken(value) {
        roomSessionState.memberToken = value;
      },
      get memberId() {
        return roomSessionState.memberId;
      },
      set memberId(value) {
        roomSessionState.memberId = value;
      },
      get displayName() {
        return roomSessionState.displayName;
      },
      set displayName(value) {
        roomSessionState.displayName = value;
      },
      get roomState() {
        return roomSessionState.roomState;
      },
      set roomState(value) {
        roomSessionState.roomState = value;
      },
      get serverUrl() {
        return connectionState.serverUrl;
      },
      set serverUrl(value) {
        connectionState.serverUrl = value;
      },
      get lastError() {
        return connectionState.lastError;
      },
      set lastError(value) {
        connectionState.lastError = value;
      },
      get sharedTabId() {
        return shareState.sharedTabId;
      },
      set sharedTabId(value) {
        shareState.sharedTabId = value;
      },
    },
    loadPersistedBackgroundSnapshot,
    connect: () => {
      void connect();
    },
    log,
    broadcastPopupState,
    addTabRemovedListener: (listener) => {
      chrome.tabs.onRemoved.addListener(listener);
    },
  });
}

function formatAdminSessionResetReason(reason: string): string {
  if (reason === "Admin kicked member") {
    return t("adminRemovedFromRoom");
  }
  if (reason === "Admin disconnected session") {
    return t("adminDisconnectedSession");
  }
  if (reason === "Admin closed room") {
    return t("adminClosedRoom");
  }
  return t("leftRoomWithReason", { reason });
}

function logInvalidServerUrl(context: string, invalidUrl: string): void {
  log("background", `Invalid server URL (${context}): ${invalidUrl}`);
}

function logConnectionProbeFailure(details: {
  stage: "connection-check" | "healthcheck" | "websocket";
  serverUrl: string;
  reason?: string | null;
  extensionOrigin?: string | null;
  readyState?: number | null;
}): void {
  const parts = [
    `Connection failure stage=${details.stage}`,
    `serverUrl=${details.serverUrl}`,
  ];
  if (details.reason) {
    parts.push(`reason=${details.reason}`);
  }
  if (details.extensionOrigin) {
    parts.push(`extensionOrigin=${details.extensionOrigin}`);
  }
  if (details.readyState !== undefined && details.readyState !== null) {
    parts.push(`readyState=${details.readyState}`);
  }
  log("background", parts.join(" "));
}

function logServerError(code: string, message: string): void {
  log(
    "server",
    `Received server error code=${code} message=${JSON.stringify(message)}`,
  );
}

async function connect(): Promise<void> {
  if (
    connectionState.socket &&
    (connectionState.socket.readyState === WebSocket.OPEN ||
      connectionState.socket.readyState === WebSocket.CONNECTING)
  ) {
    return;
  }
  if (connectionState.connectProbe) {
    return connectionState.connectProbe;
  }

  const serverUrlResult = validateServerUrl(connectionState.serverUrl);
  if (!serverUrlResult.ok) {
    connectionState.lastError = serverUrlResult.message;
    connectionState.connected = false;
    stopClockSyncTimer();
    logInvalidServerUrl("connect", connectionState.serverUrl);
    notifyAll();
    return;
  }

  clearReconnectTimer();
  log("background", `Connecting to ${serverUrlResult.normalizedUrl}`);
  connectionState.connectProbe = openSocketWithProbe(
    serverUrlResult.normalizedUrl,
  );
  try {
    await connectionState.connectProbe;
  } finally {
    connectionState.connectProbe = null;
  }
}

async function openSocketWithProbe(targetServerUrl: string): Promise<void> {
  const serverUrlResult = validateServerUrl(targetServerUrl);
  if (!serverUrlResult.ok) {
    connectionState.lastError = serverUrlResult.message;
    connectionState.connected = false;
    stopClockSyncTimer();
    logInvalidServerUrl("open-socket", targetServerUrl);
    notifyAll();
    return;
  }

  const extensionOrigin = `chrome-extension://${chrome.runtime.id}`;
  const connectionCheckUrl = buildConnectionCheckUrl(
    serverUrlResult.normalizedUrl,
  );
  const healthUrl = buildHealthcheckUrl(serverUrlResult.normalizedUrl);
  let healthcheckReachable = false;
  if (connectionCheckUrl) {
    try {
      const response = await fetch(connectionCheckUrl, {
        method: "GET",
        cache: "no-store",
      });
      if (response.ok) {
        type ConnectionCheckResponse = {
          ok?: boolean;
          data?: {
            websocketAllowed?: boolean;
            reason?: string | null;
          };
        };

        const payload = (await response.json()) as ConnectionCheckResponse;
        healthcheckReachable = true;
        if (payload.data?.websocketAllowed === false) {
          connectionState.lastError = getConnectionErrorMessage({
            healthcheckReachable: true,
            extensionOrigin,
            reason: payload.data.reason,
          });
          connectionState.connected = false;
          stopClockSyncTimer();
          logConnectionProbeFailure({
            stage: "connection-check",
            serverUrl: serverUrlResult.normalizedUrl,
            reason: payload.data.reason,
            extensionOrigin,
          });
          scheduleReconnect();
          notifyAll();
          return;
        }
      }
    } catch {
      // Fall back to the healthcheck probe for older servers that do not expose the preflight endpoint.
    }
  }

  if (healthUrl) {
    try {
      await fetch(healthUrl, {
        method: "GET",
        cache: "no-store",
        mode: "no-cors",
      });
      healthcheckReachable = true;
    } catch {
      connectionState.lastError = getConnectionErrorMessage({
        healthcheckReachable: false,
        extensionOrigin,
      });
      connectionState.connected = false;
      stopClockSyncTimer();
      logConnectionProbeFailure({
        stage: "healthcheck",
        serverUrl: serverUrlResult.normalizedUrl,
        extensionOrigin,
      });
      scheduleReconnect();
      notifyAll();
      return;
    }
  }

  connectionState.socket = new WebSocket(serverUrlResult.normalizedUrl);

  connectionState.socket.addEventListener("open", () => {
    connectionState.connected = true;
    connectionState.lastError = null;
    connectionState.reconnectAttempt = 0;
    connectionState.reconnectDeadlineMs = null;
    log("background", "Socket connected");
    if (roomSessionState.pendingCreateRoom) {
      roomSessionState.pendingCreateRoom = false;
      sendToServer({
        type: "room:create",
        payload: { displayName: roomSessionState.displayName ?? undefined },
      });
    } else if (
      roomSessionState.pendingJoinRoomCode &&
      roomSessionState.pendingJoinToken &&
      !roomSessionState.pendingJoinRequestSent
    ) {
      const targetRoomCode = roomSessionState.pendingJoinRoomCode;
      const targetJoinToken = roomSessionState.pendingJoinToken;
      sendJoinRequest(targetRoomCode, targetJoinToken);
    } else if (roomSessionState.roomCode) {
      if (roomSessionState.joinToken) {
        sendJoinRequest(roomSessionState.roomCode, roomSessionState.joinToken);
      }
    }
    syncClock();
    startClockSyncTimer();
    notifyAll();
  });

  connectionState.socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data) as ServerMessage;
    void handleServerMessage(message);
  });

  connectionState.socket.addEventListener("close", (event) => {
    connectionState.connected = false;
    stopClockSyncTimer();
    clearPendingLocalShare("socket closed before share confirmation");
    const closeReason = event.reason
      ? ` reason=${JSON.stringify(event.reason)}`
      : "";
    log(
      "background",
      `Socket closed code=${event.code} clean=${event.wasClean}${closeReason}`,
    );
    if (event.reason && ADMIN_SESSION_RESET_REASONS.has(event.reason)) {
      void clearCurrentRoomContext(
        `socket closed by server: ${event.reason}`,
        formatAdminSessionResetReason(event.reason),
      );
      return;
    }
    scheduleReconnect();
    notifyAll();
  });

  connectionState.socket.addEventListener("error", () => {
    connectionState.lastError = getConnectionErrorMessage({
      healthcheckReachable,
      extensionOrigin,
    });
    connectionState.connected = false;
    stopClockSyncTimer();
    clearPendingLocalShare("socket error before share confirmation");
    logConnectionProbeFailure({
      stage: "websocket",
      serverUrl: serverUrlResult.normalizedUrl,
      extensionOrigin,
      readyState: connectionState.socket?.readyState ?? -1,
    });
    notifyAll();
  });
}

function sendToServer(message: ClientMessage): void {
  if (
    !connectionState.socket ||
    connectionState.socket.readyState !== WebSocket.OPEN
  ) {
    log("background", `Socket not ready for ${message.type}`);
    void connect();
    return;
  }
  if (shouldLogHeartbeatMessage(outgoingMessageLogState, message.type)) {
    log("background", `-> ${message.type}`);
  }
  connectionState.socket.send(JSON.stringify(message));
}

function sendJoinRequest(
  targetRoomCode: string,
  targetJoinToken: string,
): void {
  roomSessionState.pendingJoinRequestSent = true;
  sendToServer({
    type: "room:join",
    payload: {
      roomCode: targetRoomCode,
      joinToken: targetJoinToken,
      ...(roomSessionState.memberToken
        ? { memberToken: roomSessionState.memberToken }
        : {}),
      displayName: roomSessionState.displayName ?? undefined,
    },
  });
}

function settlePendingJoinAttempt(
  result: "joined" | "failed" | "timeout",
): void {
  if (pendingJoinAttemptResolvers.length === 0) {
    return;
  }

  const resolvers = pendingJoinAttemptResolvers;
  pendingJoinAttemptResolvers = [];
  for (const resolve of resolvers) {
    resolve(result);
  }
}

function waitForJoinAttemptResult(
  timeoutMs = 3000,
): Promise<"joined" | "failed" | "timeout"> {
  return new Promise((resolve) => {
    const timer = globalThis.setTimeout(() => {
      pendingJoinAttemptResolvers = pendingJoinAttemptResolvers.filter(
        (candidate) => candidate !== finalize,
      );
      resolve("timeout");
    }, timeoutMs);

    const finalize = (result: "joined" | "failed" | "timeout") => {
      globalThis.clearTimeout(timer);
      resolve(result);
    };

    pendingJoinAttemptResolvers.push(finalize);
  });
}

async function handleServerMessage(message: ServerMessage): Promise<void> {
  if (shouldLogHeartbeatMessage(incomingMessageLogState, message.type)) {
    log("server", `<- ${message.type}`);
  }
  switch (message.type) {
    case "room:created":
      roomSessionState.pendingJoinRoomCode = null;
      roomSessionState.pendingJoinToken = null;
      roomSessionState.roomCode = message.payload.roomCode;
      roomSessionState.joinToken = message.payload.joinToken;
      roomSessionState.memberToken = message.payload.memberToken;
      roomSessionState.memberId = message.payload.memberId;
      connectionState.lastError = null;
      await persistState();
      flushPendingShare();
      notifyAll();
      return;
    case "room:joined":
      roomSessionState.roomCode = message.payload.roomCode;
      roomSessionState.joinToken =
        roomSessionState.pendingJoinToken ?? roomSessionState.joinToken;
      roomSessionState.memberToken = message.payload.memberToken;
      roomSessionState.memberId = message.payload.memberId;
      roomSessionState.pendingJoinRequestSent = false;
      roomSessionState.pendingJoinRoomCode = null;
      roomSessionState.pendingJoinToken = null;
      connectionState.lastError = null;
      settlePendingJoinAttempt("joined");
      await persistState();
      flushPendingShare();
      notifyAll();
      return;
    case "room:state":
      await handleRoomStateMessage(message.payload);
      return;
    case "error":
      connectionState.lastError = localizeServerError(
        message.payload.code,
        message.payload.message,
      );
      if (
        roomSessionState.pendingJoinRoomCode &&
        (message.payload.code === "room_not_found" ||
          message.payload.code === "join_token_invalid" ||
          message.payload.code === "invalid_message")
      ) {
        log(
          "background",
          `Join failed for room ${roomSessionState.pendingJoinRoomCode}`,
        );
        settlePendingJoinAttempt("failed");
        roomSessionState.pendingJoinRequestSent = false;
        roomSessionState.pendingJoinRoomCode = null;
        roomSessionState.pendingJoinToken = null;
        roomSessionState.roomCode = null;
        roomSessionState.joinToken = null;
        roomSessionState.memberToken = null;
        roomSessionState.memberId = null;
        roomSessionState.roomState = null;
        await persistState();
      }
      if (
        roomSessionState.roomCode &&
        !roomSessionState.pendingJoinRoomCode &&
        (message.payload.code === "room_not_found" ||
          message.payload.code === "join_token_invalid")
      ) {
        await clearCurrentRoomContext(
          `server rejected stored room context: ${message.payload.code}`,
          message.payload.message,
        );
        logServerError(message.payload.code, message.payload.message);
        return;
      }
      if (message.payload.code === "member_token_invalid") {
        roomSessionState.memberToken = null;
        await persistState();
      }
      logServerError(message.payload.code, message.payload.message);
      notifyAll();
      return;
    case "sync:pong":
      updateClockOffset(
        message.payload.clientSendTime,
        message.payload.serverReceiveTime,
        message.payload.serverSendTime,
      );
      notifyAll();
      return;
  }
}

async function handleRoomStateMessage(nextState: RoomState): Promise<void> {
  expirePendingLocalShareIfNeeded();
  const decision = decideIncomingRoomState({
    currentRoomState: roomSessionState.roomState,
    normalizedPendingLocalShareUrl: normalizeUrl(
      getActivePendingLocalShareUrl({
        pendingLocalShareUrl: shareState.pendingLocalShareUrl,
        pendingLocalShareExpiresAt: shareState.pendingLocalShareExpiresAt,
        now: Date.now(),
      }),
    ),
    normalizedIncomingSharedUrl: normalizeUrl(nextState.sharedVideo?.url),
  });

  if (decision.kind === "ignore-stale") {
    log(
      "background",
      `Ignored stale room state while waiting for ${shareState.pendingLocalShareUrl}; received ${nextState.sharedVideo?.url ?? "none"}`,
    );
    return;
  }

  if (isSharedVideoChange(decision.previousSharedUrl, nextState)) {
    shareState.lastOpenedSharedUrl = null;
    log(
      "background",
      `Shared video switched to ${nextState.sharedVideo?.url ?? "none"}`,
    );
    shareState.pendingShareToast = createPendingShareToast(nextState);
  }

  roomSessionState.roomState = nextState;
  roomSessionState.roomCode = nextState.roomCode;
  connectionState.lastError = null;

  if (decision.confirmedPendingLocalShare) {
    log(
      "background",
      `Confirmed shared video switch to ${shareState.pendingLocalShareUrl}`,
    );
    clearPendingLocalShare("share confirmation received");
  }

  await persistState();
  await ensureSharedVideoOpen(roomSessionState.roomState);
  const compensatedRoomState = compensateRoomState(roomSessionState.roomState);
  await notifyContentScripts({
    type: "background:apply-room-state",
    payload: compensatedRoomState,
    shareToast: getPendingShareToastFor(nextState),
  });
  notifyAll();
}

function createPendingShareToast(
  state: RoomState,
): (SharedVideoToastPayload & { expiresAt: number; roomCode: string }) | null {
  return createRoomPendingShareToast({
    state,
    normalizedSharedUrl: normalizeUrl(state.sharedVideo?.url),
    now: Date.now(),
    ttlMs: SHARE_TOAST_TTL_MS,
  });
}

function getPendingShareToastFor(
  state: RoomState,
): SharedVideoToastPayload | null {
  const result = getRoomPendingShareToastFor({
    pendingShareToast: shareState.pendingShareToast,
    state,
    normalizedPendingToastUrl: normalizeUrl(
      shareState.pendingShareToast?.videoUrl,
    ),
    normalizedSharedUrl: normalizeUrl(state.sharedVideo?.url),
    now: Date.now(),
  });
  shareState.pendingShareToast = result.pendingShareToast;
  return result.shareToast;
}

function flushPendingShare(): void {
  const plan = getPendingShareFlushPlan({
    pendingSharedVideo: roomSessionState.pendingSharedVideo,
    pendingSharedPlayback: roomSessionState.pendingSharedPlayback,
    connected: connectionState.connected,
    roomCode: roomSessionState.roomCode,
    memberToken: roomSessionState.memberToken,
  });
  if (!plan.shouldFlush || !plan.video) {
    return;
  }
  sendToServer({
    type: "video:share",
    payload: {
      memberToken: roomSessionState.memberToken,
      video: plan.video,
      ...(plan.playback ? { playback: plan.playback } : {}),
    },
  });
  roomSessionState.pendingSharedVideo = null;
  roomSessionState.pendingSharedPlayback = null;
}

async function getActiveTab(): Promise<chrome.tabs.Tab | null> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab ?? null;
}

async function getActiveVideoPayload(): Promise<{
  ok: boolean;
  payload: { video: SharedVideo; playback: PlaybackState | null } | null;
  tabId: number | null;
  error?: string;
}> {
  const activeTab = await getActiveTab();
  if (!activeTab?.id) {
    return {
      ok: false,
      payload: null,
      tabId: null,
      error: t("popupErrorNoActiveTab"),
    };
  }

  if (!activeTab.url || !parseBilibiliVideoRef(activeTab.url)) {
    return {
      ok: false,
      payload: null,
      tabId: activeTab.id,
      error: t("popupErrorOpenBilibiliVideo"),
    };
  }

  try {
    const response = await chrome.tabs.sendMessage(activeTab.id, {
      type: "background:get-current-video",
    });
    if (!response?.ok || !response.payload?.video) {
      return {
        ok: false,
        payload: null,
        tabId: activeTab.id,
        error: t("popupErrorNoPlayableVideo"),
      };
    }
    return {
      ok: true,
      payload: response.payload,
      tabId: activeTab.id,
    };
  } catch {
    return {
      ok: false,
      payload: null,
      tabId: activeTab.id,
      error: t("popupErrorCannotAccessPage"),
    };
  }
}

async function queueOrSendSharedVideo(
  payload: { video: SharedVideo; playback: PlaybackState | null },
  tabId: number | null,
): Promise<void> {
  rememberSharedSourceTab(tabId ?? undefined, payload.video.url);
  setPendingLocalShare(payload.video.url);

  if (connectionState.connected && roomSessionState.roomCode) {
    if (!roomSessionState.memberToken) {
      connectionState.lastError = t("popupErrorMemberTokenMissing");
      notifyAll();
      return;
    }
    sendToServer({
      type: "video:share",
      payload: {
        memberToken: roomSessionState.memberToken,
        video: payload.video,
        ...(payload.playback
          ? {
              playback: {
                ...payload.playback,
                serverTime: 0,
                actorId: roomSessionState.memberId ?? payload.playback.actorId,
              },
            }
          : {}),
      },
    });
    return;
  }

  roomSessionState.pendingSharedVideo = payload.video;
  roomSessionState.pendingSharedPlayback = payload.playback
    ? {
        ...payload.playback,
        serverTime: 0,
        actorId: roomSessionState.memberId ?? payload.playback.actorId,
      }
    : null;

  if (roomSessionState.roomCode) {
    roomSessionState.memberToken = null;
    connect();
    return;
  }

  roomSessionState.roomCode = null;
  roomSessionState.joinToken = null;
  roomSessionState.memberToken = null;
  roomSessionState.memberId = null;
  roomSessionState.roomState = null;
  shareState.pendingShareToast = null;
  await persistState();
  connect();
  if (connectionState.connected) {
    roomSessionState.pendingCreateRoom = false;
    sendToServer({
      type: "room:create",
      payload: { displayName: roomSessionState.displayName ?? undefined },
    });
  } else {
    roomSessionState.pendingCreateRoom = true;
  }
}

function syncClock(): void {
  if (!connectionState.connected) {
    return;
  }
  sendToServer({
    type: "sync:ping",
    payload: {
      clientSendTime: Date.now(),
    },
  });
}

function startClockSyncTimer(): void {
  stopClockSyncTimer();
  clockState.clockSyncTimer = self.setInterval(() => {
    syncClock();
  }, CLOCK_SYNC_INTERVAL_MS);
}

function stopClockSyncTimer(): void {
  if (clockState.clockSyncTimer !== null) {
    clearInterval(clockState.clockSyncTimer);
    clockState.clockSyncTimer = null;
  }
}

function updateClockOffset(
  clientSendTime: number,
  serverReceiveTime: number,
  serverSendTime: number,
): void {
  const sample = updateClockSample({
    clientSendTime,
    serverReceiveTime,
    serverSendTime,
    now: Date.now(),
    previousRttMs: clockState.rttMs,
    previousClockOffsetMs: clockState.clockOffsetMs,
  });
  clockState.rttMs = sample.rttMs;
  clockState.clockOffsetMs = sample.clockOffsetMs;
  log(
    "background",
    `Clock sync offset=${clockState.clockOffsetMs}ms rtt=${clockState.rttMs}ms`,
  );
}

function compensateRoomState(state: RoomState): RoomState {
  return compensateRoomStateForClock(state, clockState.clockOffsetMs);
}

function scheduleReconnect(): void {
  if (
    !shouldReconnect({
      connected: connectionState.connected,
      reconnectTimer: connectionState.reconnectTimer,
      roomCode: roomSessionState.roomCode,
      pendingCreateRoom: roomSessionState.pendingCreateRoom,
      reconnectAttempt: connectionState.reconnectAttempt,
      maxReconnectAttempts: MAX_RECONNECT_ATTEMPTS,
    })
  ) {
    if (connectionState.reconnectAttempt >= MAX_RECONNECT_ATTEMPTS) {
      connectionState.reconnectDeadlineMs = null;
      connectionState.lastError = t("popupErrorReconnectFailed", {
        attempts: MAX_RECONNECT_ATTEMPTS,
      });
      log(
        "background",
        `Reconnect exhausted after ${MAX_RECONNECT_ATTEMPTS} attempts`,
      );
    }
    return;
  }

  connectionState.reconnectAttempt += 1;
  const retryDelayMs = getReconnectDelayMs(connectionState.reconnectAttempt);
  connectionState.reconnectDeadlineMs = Date.now() + retryDelayMs;
  log("background", `Reconnect scheduled in ${retryDelayMs}ms`);
  connectionState.reconnectTimer = self.setTimeout(() => {
    connectionState.reconnectDeadlineMs = null;
    connectionState.reconnectTimer = null;
    connect();
  }, retryDelayMs);
}

function clearReconnectTimer(): void {
  if (connectionState.reconnectTimer !== null) {
    clearTimeout(connectionState.reconnectTimer);
    connectionState.reconnectTimer = null;
  }
  connectionState.reconnectDeadlineMs = null;
}

function getRetryInMs(): number | null {
  if (connectionState.reconnectDeadlineMs === null) {
    return null;
  }
  return Math.max(0, connectionState.reconnectDeadlineMs - Date.now());
}

function resetReconnectState(): void {
  clearReconnectTimer();
  connectionState.reconnectAttempt = 0;
}

async function clearCurrentRoomContext(
  reason: string,
  errorMessage: string | null = null,
): Promise<void> {
  log("background", `Clearing current room context (${reason})`);
  roomSessionState.roomCode = null;
  roomSessionState.joinToken = null;
  roomSessionState.memberToken = null;
  roomSessionState.memberId = null;
  roomSessionState.roomState = null;
  roomSessionState.pendingCreateRoom = false;
  roomSessionState.pendingJoinRoomCode = null;
  roomSessionState.pendingJoinToken = null;
  roomSessionState.pendingJoinRequestSent = false;
  shareState.lastOpenedSharedUrl = null;
  connectionState.lastError = errorMessage;
  resetReconnectState();
  resetRoomLifecycleTransientState("leave-room", reason);
  await persistState();
  notifyAll();
}

function clearPendingLocalShareTimer(): void {
  if (shareState.pendingLocalShareTimer !== null) {
    clearTimeout(shareState.pendingLocalShareTimer);
    shareState.pendingLocalShareTimer = null;
  }
}

function clearPendingLocalShare(reason: string): void {
  const cleanup = preparePendingLocalShareCleanup({
    pendingLocalShareUrl: shareState.pendingLocalShareUrl,
    pendingLocalShareExpiresAt: shareState.pendingLocalShareExpiresAt,
    pendingLocalShareTimer: shareState.pendingLocalShareTimer,
  });
  if (!cleanup.hadPendingLocalShare) {
    return;
  }
  if (cleanup.shouldCancelTimer) {
    clearPendingLocalShareTimer();
  }
  log("background", `Cleared pending local share (${reason})`);
  ({
    pendingLocalShareUrl: shareState.pendingLocalShareUrl,
    pendingLocalShareExpiresAt: shareState.pendingLocalShareExpiresAt,
    pendingLocalShareTimer: shareState.pendingLocalShareTimer,
  } = cleanup.nextState);
}

function expirePendingLocalShareIfNeeded(): void {
  const activePendingShare = getActivePendingLocalShareUrl({
    pendingLocalShareUrl: shareState.pendingLocalShareUrl,
    pendingLocalShareExpiresAt: shareState.pendingLocalShareExpiresAt,
    now: Date.now(),
  });
  if (shareState.pendingLocalShareUrl && activePendingShare === null) {
    clearPendingLocalShare(
      `share confirmation timed out after ${PENDING_LOCAL_SHARE_TIMEOUT_MS}ms`,
    );
  }
}

function setPendingLocalShare(url: string): void {
  clearPendingLocalShareTimer();
  shareState.pendingLocalShareUrl = url;
  shareState.pendingLocalShareExpiresAt = createPendingLocalShareExpiry(
    Date.now(),
  );
  log(
    "background",
    `Waiting up to ${PENDING_LOCAL_SHARE_TIMEOUT_MS}ms for share confirmation ${url}`,
  );
  shareState.pendingLocalShareTimer = self.setTimeout(() => {
    expirePendingLocalShareIfNeeded();
    notifyAll();
  }, PENDING_LOCAL_SHARE_TIMEOUT_MS);
}

function disconnectSocket(): void {
  resetReconnectState();
  stopClockSyncTimer();
  clearPendingLocalShare("socket disconnected");
  roomSessionState.memberToken = null;
  if (!connectionState.socket) {
    connectionState.connected = false;
    return;
  }

  const currentSocket = connectionState.socket;
  connectionState.socket = null;
  connectionState.connected = false;
  currentSocket.close();
}

function resetRoomLifecycleTransientState(
  action: RoomLifecycleAction,
  reason: string,
): void {
  const cleanup = preparePendingLocalShareCleanupForRoomLifecycle(action, {
    pendingLocalShareUrl: shareState.pendingLocalShareUrl,
    pendingLocalShareExpiresAt: shareState.pendingLocalShareExpiresAt,
    pendingLocalShareTimer: shareState.pendingLocalShareTimer,
  });
  if (cleanup.hadPendingLocalShare) {
    if (cleanup.shouldCancelTimer) {
      clearPendingLocalShareTimer();
    }
    log("background", `Cleared pending local share (${reason})`);
    ({
      pendingLocalShareUrl: shareState.pendingLocalShareUrl,
      pendingLocalShareExpiresAt: shareState.pendingLocalShareExpiresAt,
      pendingLocalShareTimer: shareState.pendingLocalShareTimer,
    } = cleanup.nextState);
  }
  shareState.pendingShareToast = null;
  roomSessionState.pendingSharedVideo = null;
  roomSessionState.pendingSharedPlayback = null;
}

function log(scope: DebugLogEntry["scope"], message: string): void {
  diagnosticsState.logs = appendLog(diagnosticsState.logs, scope, message);
  if (popupPorts.size > 0) {
    broadcastPopupState();
  }
}

function shouldLogHeartbeatMessage(
  logState: Map<string, number>,
  type: string,
  now = Date.now(),
): boolean {
  if (type !== "playback:update" && type !== "room:state") {
    return true;
  }

  const lastAt = logState.get(type) ?? 0;
  if (now - lastAt < HEARTBEAT_LOG_INTERVAL_MS) {
    return false;
  }
  logState.set(type, now);
  return true;
}

function maybeLogPopupStateRequest(): void {
  const key = `${roomSessionState.roomCode ?? "none"}|${connectionState.connected}|${roomSessionState.pendingJoinRoomCode ?? "none"}`;
  if (key === diagnosticsState.lastPopupStateLogKey) {
    return;
  }
  diagnosticsState.lastPopupStateLogKey = key;
  log(
    "background",
    `Popup requested state room=${roomSessionState.roomCode ?? "none"} connected=${connectionState.connected} pendingJoin=${roomSessionState.pendingJoinRoomCode ?? "none"}`,
  );
}

function rememberSharedSourceTab(tabId: number | undefined, url: string): void {
  const next = rememberSharedSource({
    currentSharedTabId: shareState.sharedTabId,
    tabId,
    url,
  });
  shareState.sharedTabId = next.sharedTabId;
  shareState.lastOpenedSharedUrl = next.lastOpenedSharedUrl;
  log("background", `Shared source tab=${tabId ?? "unknown"} url=${url}`);
}

function isActiveSharedTab(tabId: number | undefined, url: string): boolean {
  const decision = decideSharedPlaybackTab({
    tabId,
    sharedTabId: shareState.sharedTabId,
    normalizedRoomUrl: normalizeUrl(
      roomSessionState.roomState?.sharedVideo?.url,
    ),
    normalizedPayloadUrl: normalizeUrl(url),
  });
  shareState.sharedTabId = decision.nextSharedTabId;

  if (decision.reason === "accepted-first") {
    log("background", `Accepted first shared playback tab=${tabId}`);
  } else if (decision.reason === "room-mismatch") {
    log(
      "background",
      `Ignored playback from shared tab ${tabId} because url no longer matches room`,
    );
  } else if (
    decision.reason === "ignored-non-shared" &&
    decision.nextSharedTabId !== null
  ) {
    log("background", `Ignored playback from non-shared tab ${tabId}`);
  }

  return decision.accepted;
}

async function ensureSharedVideoOpen(state: RoomState): Promise<void> {
  if (!state.sharedVideo?.url) {
    return;
  }

  const targetUrl = state.sharedVideo.url;
  if (
    shareState.lastOpenedSharedUrl === targetUrl ||
    shareState.openingSharedUrl === targetUrl
  ) {
    return;
  }
  shareState.openingSharedUrl = targetUrl;

  try {
    if (shareState.sharedTabId !== null) {
      try {
        const existingTab = await chrome.tabs.get(shareState.sharedTabId);
        if (normalizeUrl(existingTab.url) === normalizeUrl(targetUrl)) {
          shareState.lastOpenedSharedUrl = targetUrl;
          return;
        }
        await chrome.tabs.update(shareState.sharedTabId, {
          url: targetUrl,
          active: true,
        });
        shareState.lastOpenedSharedUrl = targetUrl;
        log(
          "background",
          `Reusing tab ${shareState.sharedTabId} for shared video`,
        );
        return;
      } catch {
        shareState.sharedTabId = null;
      }
    }

    const existingTabs = await chrome.tabs.query({
      url: BILIBILI_VIDEO_URL_PATTERNS,
    });
    const matched = existingTabs.find(
      (tab) => normalizeUrl(tab.url) === normalizeUrl(targetUrl),
    );
    if (matched?.id !== undefined) {
      shareState.sharedTabId = matched.id;
      await chrome.tabs.update(matched.id, { active: true });
      shareState.lastOpenedSharedUrl = targetUrl;
      log("background", `Activated existing shared tab ${matched.id}`);
      return;
    }

    const created = await chrome.tabs.create({ url: targetUrl, active: true });
    shareState.sharedTabId = created.id ?? null;
    shareState.lastOpenedSharedUrl = targetUrl;
    log(
      "background",
      `Opened shared video in new tab ${shareState.sharedTabId ?? "unknown"}`,
    );
  } finally {
    if (shareState.openingSharedUrl === targetUrl) {
      shareState.openingSharedUrl = null;
    }
  }
}

async function openSharedVideoFromPopup(): Promise<void> {
  const targetUrl = roomSessionState.roomState?.sharedVideo?.url;
  if (!targetUrl) {
    return;
  }

  const existingTabs = await chrome.tabs.query({
    url: BILIBILI_VIDEO_URL_PATTERNS,
  });
  const matched = existingTabs.find(
    (tab) => normalizeUrl(tab.url) === normalizeUrl(targetUrl),
  );
  if (matched?.id !== undefined) {
    shareState.sharedTabId = matched.id;
    shareState.lastOpenedSharedUrl = targetUrl;
    await chrome.tabs.update(matched.id, { active: true });
    log("background", `Popup activated shared tab ${matched.id}`);
    return;
  }

  const created = await chrome.tabs.create({ url: targetUrl, active: true });
  shareState.sharedTabId = created.id ?? null;
  shareState.lastOpenedSharedUrl = targetUrl;
  log(
    "background",
    `Popup opened shared video in new tab ${shareState.sharedTabId ?? "unknown"}`,
  );
}

function normalizeUrl(url: string | undefined | null): string | null {
  return normalizeBilibiliUrl(url);
}

async function notifyContentScripts(
  message: BackgroundToContentMessage,
): Promise<void> {
  await notifyContentTabs(message, BILIBILI_VIDEO_URL_PATTERNS);
}

function popupState(): BackgroundToPopupMessage {
  return createPopupStateSnapshot({
    state: syncRuntimeStateStore(),
    retryInMs: getRetryInMs(),
    retryAttemptMax: MAX_RECONNECT_ATTEMPTS,
  });
}

function broadcastPopupState(): void {
  const snapshot = popupState();
  for (const port of popupPorts) {
    try {
      port.postMessage(snapshot);
    } catch {
      popupPorts.delete(port);
    }
  }
}

function notifyAll(): void {
  broadcastPopupState();
  void notifyContentScripts({
    type: "background:sync-status",
    payload: {
      roomCode: roomSessionState.roomCode,
      connected: connectionState.connected,
      memberId: roomSessionState.memberId,
    },
  });
}

async function persistState(): Promise<void> {
  await persistBackgroundState(syncRuntimeStateStore());
}

function syncRuntimeStateStore() {
  return stateStore.patch({
    connection: {
      socket: connectionState.socket,
      serverUrl: connectionState.serverUrl,
      connected: connectionState.connected,
      lastError: connectionState.lastError,
      connectProbe: connectionState.connectProbe,
      reconnectTimer: connectionState.reconnectTimer,
      reconnectAttempt: connectionState.reconnectAttempt,
      reconnectDeadlineMs: connectionState.reconnectDeadlineMs,
    },
    room: {
      roomCode: roomSessionState.roomCode,
      joinToken: roomSessionState.joinToken,
      memberToken: roomSessionState.memberToken,
      memberId: roomSessionState.memberId,
      displayName: roomSessionState.displayName,
      roomState: roomSessionState.roomState,
      pendingCreateRoom: roomSessionState.pendingCreateRoom,
      pendingJoinRoomCode: roomSessionState.pendingJoinRoomCode,
      pendingJoinToken: roomSessionState.pendingJoinToken,
      pendingJoinRequestSent: roomSessionState.pendingJoinRequestSent,
      pendingSharedVideo: roomSessionState.pendingSharedVideo,
      pendingSharedPlayback: roomSessionState.pendingSharedPlayback,
    },
    share: {
      sharedTabId: shareState.sharedTabId,
      lastOpenedSharedUrl: shareState.lastOpenedSharedUrl,
      openingSharedUrl: shareState.openingSharedUrl,
      pendingLocalShareUrl: shareState.pendingLocalShareUrl,
      pendingLocalShareExpiresAt: shareState.pendingLocalShareExpiresAt,
      pendingLocalShareTimer: shareState.pendingLocalShareTimer,
      pendingShareToast: shareState.pendingShareToast,
    },
    clock: {
      clockOffsetMs: clockState.clockOffsetMs,
      rttMs: clockState.rttMs,
      clockSyncTimer: clockState.clockSyncTimer,
    },
    diagnostics: {
      logs: diagnosticsState.logs,
      lastPopupStateLogKey: diagnosticsState.lastPopupStateLogKey,
    },
  });
}

async function updateServerUrl(nextServerUrl: string): Promise<void> {
  const serverUrlResult = validateServerUrl(nextServerUrl);
  if (!serverUrlResult.ok) {
    connectionState.lastError = serverUrlResult.message;
    logInvalidServerUrl(
      "update-server-url",
      nextServerUrl.trim() || DEFAULT_SERVER_URL,
    );
    notifyAll();
    return;
  }

  const normalized = serverUrlResult.normalizedUrl;
  if (normalized === connectionState.serverUrl) {
    return;
  }

  if (
    shouldClearPendingLocalShareOnServerUrlChange({
      currentServerUrl: connectionState.serverUrl,
      nextServerUrl: normalized,
      pendingLocalShareUrl: shareState.pendingLocalShareUrl,
    })
  ) {
    clearPendingLocalShare("server URL changed");
  }

  connectionState.serverUrl = normalized;
  connectionState.lastError = null;
  await persistState();
  log("background", `Server URL updated to ${connectionState.serverUrl}`);

  if (connectionState.socket) {
    resetReconnectState();
    stopClockSyncTimer();
    const currentSocket = connectionState.socket;
    connectionState.socket = null;
    connectionState.connected = false;
    currentSocket.close();
  }

  if (roomSessionState.roomCode || roomSessionState.pendingCreateRoom) {
    connect();
  }
  notifyAll();
}

chrome.runtime.onMessage.addListener(
  (
    message: PopupToBackgroundMessage | ContentToBackgroundMessage,
    sender,
    sendResponse,
  ) => {
    void (async () => {
      switch (message.type) {
        case "popup:create-room":
          resetReconnectState();
          roomSessionState.roomCode = null;
          roomSessionState.joinToken = null;
          roomSessionState.memberToken = null;
          roomSessionState.memberId = null;
          roomSessionState.roomState = null;
          roomSessionState.pendingJoinRoomCode = null;
          roomSessionState.pendingJoinToken = null;
          resetRoomLifecycleTransientState(
            "create-room",
            "create room requested",
          );
          shareState.lastOpenedSharedUrl = null;
          await persistState();
          connect();
          if (connectionState.connected) {
            roomSessionState.pendingCreateRoom = false;
            sendToServer({
              type: "room:create",
              payload: {
                displayName: roomSessionState.displayName ?? undefined,
              },
            });
          } else {
            roomSessionState.pendingCreateRoom = true;
          }
          sendResponse(popupState());
          return;
        case "popup:join-room":
          resetReconnectState();
          roomSessionState.pendingCreateRoom = false;
          roomSessionState.pendingJoinRoomCode = message.roomCode
            .trim()
            .toUpperCase();
          roomSessionState.pendingJoinToken = message.joinToken.trim();
          roomSessionState.pendingJoinRequestSent = false;
          log(
            "background",
            `Popup requested join for ${roomSessionState.pendingJoinRoomCode}`,
          );
          roomSessionState.roomCode = null;
          roomSessionState.joinToken = null;
          roomSessionState.memberToken = null;
          roomSessionState.memberId = null;
          roomSessionState.roomState = null;
          resetRoomLifecycleTransientState("join-room", "join room requested");
          shareState.lastOpenedSharedUrl = null;
          connectionState.lastError = null;
          await persistState();
          await connect();
          if (!connectionState.connected) {
            sendResponse(popupState());
            return;
          }
          if (
            connectionState.connected &&
            roomSessionState.pendingJoinRoomCode &&
            roomSessionState.pendingJoinToken
          ) {
            const targetRoomCode = roomSessionState.pendingJoinRoomCode;
            const targetJoinToken = roomSessionState.pendingJoinToken;
            if (!roomSessionState.pendingJoinRequestSent) {
              sendJoinRequest(targetRoomCode, targetJoinToken);
            }
          }
          await waitForJoinAttemptResult();
          sendResponse(popupState());
          return;
        case "popup:leave-room":
          log(
            "background",
            `Popup requested leave for ${roomSessionState.roomCode ?? "none"}`,
          );
          if (connectionState.connected) {
            sendToServer({
              type: "room:leave",
              payload: roomSessionState.memberToken
                ? { memberToken: roomSessionState.memberToken }
                : undefined,
            });
          }
          roomSessionState.roomCode = null;
          roomSessionState.joinToken = null;
          roomSessionState.memberToken = null;
          roomSessionState.memberId = null;
          roomSessionState.roomState = null;
          roomSessionState.pendingJoinRoomCode = null;
          roomSessionState.pendingJoinToken = null;
          roomSessionState.pendingJoinRequestSent = false;
          resetRoomLifecycleTransientState(
            "leave-room",
            "leave room requested",
          );
          shareState.lastOpenedSharedUrl = null;
          roomSessionState.pendingCreateRoom = false;
          disconnectSocket();
          await persistState();
          notifyAll();
          sendResponse(popupState());
          return;
        case "popup:debug-log":
          log("popup", message.message);
          sendResponse({ ok: true });
          return;
        case "popup:get-state":
          maybeLogPopupStateRequest();
          if (roomSessionState.roomCode && !connectionState.connected) {
            connect();
          }
          sendResponse(popupState());
          return;
        case "popup:get-active-video": {
          const response = await getActiveVideoPayload();
          if (!response.ok && response.error) {
            connectionState.lastError = response.error;
          } else {
            connectionState.lastError = null;
          }
          notifyAll();
          sendResponse(response);
          return;
        }
        case "popup:share-current-video": {
          const response = await getActiveVideoPayload();
          if (!response.ok || !response.payload) {
            connectionState.lastError =
              response.error ?? t("popupErrorCannotReadCurrentVideo");
            notifyAll();
            sendResponse({ ok: false, error: connectionState.lastError });
            return;
          }
          connectionState.lastError = null;
          await queueOrSendSharedVideo(response.payload, response.tabId);
          await persistState();
          notifyAll();
          sendResponse({ ok: true });
          return;
        }
        case "popup:open-shared-video":
          await openSharedVideoFromPopup();
          sendResponse({ ok: true });
          return;
        case "popup:set-server-url":
          await updateServerUrl(message.serverUrl);
          sendResponse(popupState());
          return;
        case "content:report-user":
          if (roomSessionState.displayName !== message.payload.displayName) {
            roomSessionState.displayName = message.payload.displayName;
            await persistState();
            if (
              connectionState.connected &&
              roomSessionState.roomCode &&
              roomSessionState.memberToken
            ) {
              sendToServer({
                type: "profile:update",
                payload: {
                  memberToken: roomSessionState.memberToken,
                  displayName: roomSessionState.displayName,
                },
              });
            }
          }
          sendResponse({ ok: true });
          return;
        case "content:playback-update":
          if (
            connectionState.connected &&
            roomSessionState.memberToken &&
            isActiveSharedTab(sender.tab?.id, message.payload.url)
          ) {
            sendToServer({
              type: "playback:update",
              payload: {
                memberToken: roomSessionState.memberToken,
                playback: {
                  ...message.payload,
                  serverTime: 0,
                  actorId: roomSessionState.memberId ?? message.payload.actorId,
                },
              },
            });
          }
          sendResponse({ ok: true });
          return;
        case "content:get-room-state":
          if (roomSessionState.roomCode && !connectionState.connected) {
            connect();
          }
          if (
            connectionState.connected &&
            roomSessionState.roomCode &&
            roomSessionState.memberToken
          ) {
            sendToServer({
              type: "sync:request",
              payload: { memberToken: roomSessionState.memberToken },
            });
          }
          sendResponse(
            roomSessionState.roomState
              ? {
                  ok: true,
                  roomState: compensateRoomState(roomSessionState.roomState),
                  memberId: roomSessionState.memberId,
                  roomCode: roomSessionState.roomCode,
                }
              : {
                  ok: false,
                  memberId: roomSessionState.memberId,
                  roomCode: roomSessionState.roomCode,
                },
          );
          return;
        case "content:debug-log":
          log(
            "content",
            `[${formatContentLogSource(sender)}] ${message.payload.message}`,
          );
          sendResponse({ ok: true });
          return;
        default:
          sendResponse({ ok: false });
      }
    })();

    return true;
  },
);

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "popup-state") {
    return;
  }

  popupPorts.add(port);
  port.postMessage({
    type: "background:popup-connected",
    payload: {
      connectedAt: Date.now(),
    },
  } satisfies BackgroundToPopupMessage);
  port.postMessage(popupState());

  port.onDisconnect.addListener(() => {
    popupPorts.delete(port);
  });
});
