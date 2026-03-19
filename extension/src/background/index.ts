import {
  parseBilibiliVideoRef,
  type ClientMessage,
  type PlaybackState,
  type RoomState,
  type ServerMessage,
  type SharedVideo,
} from "@bili-syncplay/protocol";
import type {
  BackgroundToContentMessage,
  ContentToBackgroundMessage,
  PopupToBackgroundMessage,
} from "../shared/messages";
import { normalizeSharedVideoUrl } from "../shared/url";
import {
  createPendingLocalShareExpiry,
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
import { bootstrapBackground } from "./bootstrap";
import { createDiagnosticsController } from "./diagnostics-controller";
import { flushPendingShare as getPendingShareFlushPlan } from "./room-manager";
import { createPopupStateController } from "./popup-state-controller";
import { createRoomSessionController } from "./room-session-controller";
import {
  BILIBILI_VIDEO_URL_PATTERNS,
  DEFAULT_SERVER_URL,
  MAX_RECONNECT_ATTEMPTS,
  SHARE_TOAST_TTL_MS,
} from "./runtime-state";
import { createSocketController } from "./socket-controller";
import { createBackgroundStateStore } from "./state-store";
import { validateServerUrl } from "./server-url";
import {
  loadPersistedBackgroundSnapshot,
  persistBackgroundState,
} from "./storage-manager";
import { createTabController } from "./tab-controller";
import { t } from "../shared/i18n";

const stateStore = createBackgroundStateStore();
const connectionState = stateStore.getState().connection;
const roomSessionState = stateStore.getState().room;
const shareState = stateStore.getState().share;
const clockState = stateStore.getState().clock;
const diagnosticsState = stateStore.getState().diagnostics;
const diagnosticsController = createDiagnosticsController({
  diagnosticsState,
  roomSessionState,
  connectionState,
  onLog: () => {
    if (popupStateController?.hasPopupConnections()) {
      popupStateController.broadcastPopupState();
    }
  },
});
const tabController = createTabController({
  roomSessionState,
  shareState,
  log: (scope, message) => diagnosticsController.log(scope, message),
  normalizeUrl,
  bilibiliVideoUrlPatterns: BILIBILI_VIDEO_URL_PATTERNS,
});
const roomSessionController = createRoomSessionController({
  connectionState,
  roomSessionState,
  shareState,
  log: (scope, message) => diagnosticsController.log(scope, message),
  notifyAll,
  persistState,
  sendToServer,
  connect: () => socketController.connect(),
  disconnectSocket,
  resetReconnectState: () => socketController.resetReconnectState(),
  resetRoomLifecycleTransientState,
  flushPendingShare,
  ensureSharedVideoOpen: () => tabController.ensureSharedVideoOpen(),
  notifyContentScripts,
  compensateRoomState,
  clearPendingLocalShare,
  expirePendingLocalShareIfNeeded,
  normalizeUrl,
  logServerError,
  shareToastTtlMs: SHARE_TOAST_TTL_MS,
});
const socketController = createSocketController({
  connectionState,
  roomSessionState,
  maxReconnectAttempts: MAX_RECONNECT_ATTEMPTS,
  log: (scope, message) => diagnosticsController.log(scope, message),
  logInvalidServerUrl,
  logConnectionProbeFailure,
  notifyAll,
  stopClockSyncTimer,
  syncClock,
  startClockSyncTimer,
  clearPendingLocalShare,
  sendJoinRequest: (...args) => roomSessionController.sendJoinRequest(...args),
  sendToServer,
  handleServerMessage,
  buildConnectionCheckUrl,
  buildHealthcheckUrl,
  onOpen: () => undefined,
  onAdminSessionReset: (errorMessage) => {
    void roomSessionController.clearCurrentRoomContext(
      "socket closed by server",
      errorMessage,
    );
  },
  formatAdminSessionResetReason,
  reconnectFailedMessage: () =>
    t("popupErrorReconnectFailed", {
      attempts: MAX_RECONNECT_ATTEMPTS,
    }),
});
const popupStateController = createPopupStateController({
  createState: syncRuntimeStateStore,
  getRetryInMs: () => socketController.getRetryInMs(),
  retryAttemptMax: MAX_RECONNECT_ATTEMPTS,
  notifyContentScripts,
  getSyncStatus: () => ({
    roomCode: roomSessionState.roomCode,
    connected: connectionState.connected,
    memberId: roomSessionState.memberId,
  }),
});

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
      void socketController.connect();
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
  diagnosticsController.log(
    "background",
    `Invalid server URL (${context}): ${invalidUrl}`,
  );
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
  diagnosticsController.log("background", parts.join(" "));
}

function logServerError(code: string, message: string): void {
  diagnosticsController.log(
    "server",
    `Received server error code=${code} message=${JSON.stringify(message)}`,
  );
}

function sendToServer(message: ClientMessage): void {
  if (
    !connectionState.socket ||
    connectionState.socket.readyState !== WebSocket.OPEN
  ) {
    diagnosticsController.log(
      "background",
      `Socket not ready for ${message.type}`,
    );
    void socketController.connect();
    return;
  }
  if (diagnosticsController.shouldLogOutgoingMessage(message.type)) {
    diagnosticsController.log("background", `-> ${message.type}`);
  }
  connectionState.socket.send(JSON.stringify(message));
}

async function handleServerMessage(message: ServerMessage): Promise<void> {
  if (diagnosticsController.shouldLogIncomingMessage(message.type)) {
    diagnosticsController.log("server", `<- ${message.type}`);
  }
  if (message.type !== "sync:pong") {
    await roomSessionController.handleServerMessage(message);
    return;
  }
  updateClockOffset(
    message.payload.clientSendTime,
    message.payload.serverReceiveTime,
    message.payload.serverSendTime,
  );
  notifyAll();
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
  tabController.rememberSharedSourceTab(tabId ?? undefined, payload.video.url);
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
    void socketController.connect();
    return;
  }

  roomSessionState.roomCode = null;
  roomSessionState.joinToken = null;
  roomSessionState.memberToken = null;
  roomSessionState.memberId = null;
  roomSessionState.roomState = null;
  shareState.pendingShareToast = null;
  await persistState();
  void socketController.connect();
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
  diagnosticsController.log(
    "background",
    `Clock sync offset=${clockState.clockOffsetMs}ms rtt=${clockState.rttMs}ms`,
  );
}

function compensateRoomState(state: RoomState): RoomState {
  return compensateRoomStateForClock(state, clockState.clockOffsetMs);
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
  diagnosticsController.log(
    "background",
    `Cleared pending local share (${reason})`,
  );
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
  diagnosticsController.log(
    "background",
    `Waiting up to ${PENDING_LOCAL_SHARE_TIMEOUT_MS}ms for share confirmation ${url}`,
  );
  shareState.pendingLocalShareTimer = self.setTimeout(() => {
    expirePendingLocalShareIfNeeded();
    notifyAll();
  }, PENDING_LOCAL_SHARE_TIMEOUT_MS);
}

function disconnectSocket(): void {
  socketController.resetReconnectState();
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
    diagnosticsController.log(
      "background",
      `Cleared pending local share (${reason})`,
    );
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

const normalizeUrl = normalizeSharedVideoUrl;

async function notifyContentScripts(
  message: BackgroundToContentMessage,
): Promise<void> {
  await notifyContentTabs(message, BILIBILI_VIDEO_URL_PATTERNS);
}

function notifyAll(): void {
  popupStateController.notifyAll();
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
  diagnosticsController.log(
    "background",
    `Server URL updated to ${connectionState.serverUrl}`,
  );

  if (connectionState.socket) {
    socketController.resetReconnectState();
    stopClockSyncTimer();
    const currentSocket = connectionState.socket;
    connectionState.socket = null;
    connectionState.connected = false;
    currentSocket.close();
  }

  if (roomSessionState.roomCode || roomSessionState.pendingCreateRoom) {
    void socketController.connect();
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
          await roomSessionController.requestCreateRoom();
          sendResponse(popupStateController.popupState());
          return;
        case "popup:join-room":
          await roomSessionController.requestJoinRoom(
            message.roomCode,
            message.joinToken,
          );
          if (!connectionState.connected) {
            sendResponse(popupStateController.popupState());
            return;
          }
          await roomSessionController.waitForJoinAttemptResult();
          sendResponse(popupStateController.popupState());
          return;
        case "popup:leave-room":
          await roomSessionController.requestLeaveRoom();
          sendResponse(popupStateController.popupState());
          return;
        case "popup:debug-log":
          diagnosticsController.log("popup", message.message);
          sendResponse({ ok: true });
          return;
        case "popup:get-state":
          diagnosticsController.maybeLogPopupStateRequest();
          if (roomSessionState.roomCode && !connectionState.connected) {
            void socketController.connect();
          }
          sendResponse(popupStateController.popupState());
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
          await tabController.openSharedVideoFromPopup();
          sendResponse({ ok: true });
          return;
        case "popup:set-server-url":
          await updateServerUrl(message.serverUrl);
          sendResponse(popupStateController.popupState());
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
            tabController.isActiveSharedTab(sender.tab?.id, message.payload.url)
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
            void socketController.connect();
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
          diagnosticsController.log(
            "content",
            `[${diagnosticsController.formatContentSource(sender)}] ${message.payload.message}`,
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
  popupStateController.attachPort(port);
});
