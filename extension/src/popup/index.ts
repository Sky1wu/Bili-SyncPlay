import { normalizeBilibiliUrl, type RoomMember } from "@bili-syncplay/protocol";
import type { BackgroundToPopupMessage } from "../shared/messages";
import { escapeHtml, parseInviteValue } from "./helpers";
import { renderPopupTemplate } from "./popup-template";
import { collectPopupRefs, type PopupRefs } from "./popup-view";
import {
  createServerUrlDraftState,
  getRenderedServerUrlValue,
  syncServerUrlDraft,
  updateServerUrlDraft,
} from "./server-url-draft";
import {
  applyIncomingPopupState,
  createPopupStateSyncState,
} from "./state-sync";
import { getDocumentLanguage, getUiLanguage, t } from "../shared/i18n";

const app = document.getElementById("app");

let refs: PopupRefs | null = null;
let copyRoomResetTimer: number | null = null;
let copyLogsResetTimer: number | null = null;
let roomActionPending = false;
let lastKnownPendingCreateRoom = false;
let lastKnownPendingJoinRoomCode: string | null = null;
let lastKnownRoomCode: string | null = null;
let lastRoomEnteredAt = 0;
let roomCodeDraft = "";
const serverUrlDraft = createServerUrlDraftState();
let localStatusMessage: string | null = null;
let popupPort: chrome.runtime.Port | null = null;
const popupStateSync = createPopupStateSyncState();

const LEAVE_GUARD_MS = 1500;

void init();

async function init(): Promise<void> {
  if (!app) {
    return;
  }

  document.documentElement.lang = getDocumentLanguage();
  document.title = t("popupTitle");
  app.innerHTML = renderPopupTemplate();

  refs = collectPopupRefs();
  bindActions(refs);
  connectPopupStatePort();
  const initialState = await queryState();
  if (applyState(initialState, "query")) {
    render();
  }
}

async function queryState(): Promise<BackgroundToPopupMessage["payload"]> {
  const response = (await chrome.runtime.sendMessage({
    type: "popup:get-state",
  })) as BackgroundToPopupMessage;
  return response.payload;
}

function applyActionState(state: BackgroundToPopupMessage["payload"]): void {
  applyState(state, "port");
  render();
}

function connectPopupStatePort(): void {
  popupPort?.disconnect();
  popupPort = chrome.runtime.connect({ name: "popup-state" });
  popupPort.onMessage.addListener((message: BackgroundToPopupMessage) => {
    if (message.type !== "background:state") {
      return;
    }
    if (applyState(message.payload, "port")) {
      render();
    }
  });
  popupPort.onDisconnect.addListener(() => {
    popupPort = null;
  });
}

async function sendPopupLog(message: string): Promise<void> {
  try {
    await chrome.runtime.sendMessage({ type: "popup:debug-log", message });
  } catch {
    // Ignore popup debug logging failures.
  }
}

function applyRoomActionControlState(nodes: PopupRefs): void {
  const isRoomTransitioning =
    roomActionPending ||
    lastKnownPendingCreateRoom ||
    Boolean(lastKnownPendingJoinRoomCode);
  nodes.createRoomButton.disabled = isRoomTransitioning;
  nodes.joinRoomButton.disabled =
    isRoomTransitioning || !nodes.roomCodeInput.value.trim();
  nodes.leaveRoomButton.disabled = isRoomTransitioning;
  nodes.roomCodeInput.disabled =
    isRoomTransitioning || Boolean(lastKnownRoomCode);
}

function setRoomActionPending(nextPending: boolean): void {
  roomActionPending = nextPending;
  if (refs) {
    applyRoomActionControlState(refs);
  }
}

function setLocalStatusMessage(message: string | null): void {
  localStatusMessage = message;
  if (popupStateSync.popupState) {
    render();
  }
}

function formatInviteDraft(
  roomCode: string | null,
  joinToken: string | null,
): string {
  if (!roomCode) {
    return "";
  }
  return joinToken ? `${roomCode}:${joinToken}` : roomCode;
}

function applyState(
  state: BackgroundToPopupMessage["payload"],
  source: "port" | "query" = "port",
): boolean {
  if (!applyIncomingPopupState(popupStateSync, state, source)) {
    return false;
  }
  const previousRoomCode = lastKnownRoomCode;
  lastKnownPendingCreateRoom = state.pendingCreateRoom;
  lastKnownPendingJoinRoomCode = state.pendingJoinRoomCode;
  lastKnownRoomCode = state.roomCode;
  if (!previousRoomCode && state.roomCode) {
    lastRoomEnteredAt = Date.now();
  }
  return true;
}

function render(): void {
  if (!refs || !popupStateSync.popupState) {
    return;
  }

  const state = popupStateSync.popupState;
  const roomCodeFocused = document.activeElement === refs.roomCodeInput;
  const serverUrlFocused = document.activeElement === refs.serverUrlInput;

  refs.serverStatus.textContent = state.connected
    ? t("statusConnected")
    : t("statusDisconnected");
  refs.roomStatus.textContent = state.roomCode ?? "-";
  refs.membersStatus.textContent = t("membersOnline", {
    count: state.roomState?.members.length ?? 0,
  });
  refs.debugMemberStatus.textContent =
    state.displayName ?? state.memberId ?? "-";
  refs.retryStatusValue.textContent =
    state.retryInMs !== null
      ? t("retrySeconds", { seconds: Math.ceil(state.retryInMs / 1000) })
      : "-";
  refs.retryStatusCount.textContent =
    state.retryAttempt > 0
      ? `(${state.retryAttempt}/${state.retryAttemptMax})`
      : "";
  refs.clockStatus.textContent = t("clockStatus", {
    offset: state.clockOffsetMs ?? "-",
    rtt: state.rttMs ?? "-",
  });
  const visibleMessage = localStatusMessage ?? state.error;
  refs.message.textContent = visibleMessage ?? "";
  refs.message.hidden = !visibleMessage;

  if (!roomCodeFocused) {
    if (state.roomCode) {
      roomCodeDraft = formatInviteDraft(state.roomCode, state.joinToken);
      refs.roomCodeInput.value = roomCodeDraft;
    } else {
      refs.roomCodeInput.value = roomCodeDraft;
    }
  }
  refs.serverUrlInput.value = getRenderedServerUrlValue(
    serverUrlDraft,
    state.serverUrl,
    serverUrlFocused,
  );

  refs.copyRoomButton.disabled = !state.roomCode;
  refs.roomPanelJoined.hidden = !state.roomCode;
  refs.roomPanelIdle.hidden = Boolean(state.roomCode);
  applyRoomActionControlState(refs);

  refs.sharedVideoTitle.textContent =
    state.roomState?.sharedVideo?.title ?? t("stateNoSharedVideo");
  refs.sharedVideoMeta.textContent = formatVideoMeta(
    state.roomState?.sharedVideo?.url ?? null,
  );
  const ownerText = formatVideoOwner(
    state.roomState?.members ?? [],
    state.roomState?.sharedVideo?.sharedByMemberId ?? null,
  );
  refs.sharedVideoOwner.textContent = ownerText;
  refs.sharedVideoOwner.hidden =
    !state.roomState?.sharedVideo?.url || !ownerText;
  refs.sharedVideoCard.disabled = !state.roomState?.sharedVideo?.url;

  renderMemberList(refs.memberList, state.roomState?.members ?? []);
  renderLogs(refs.logs, state.logs);

  if (state.pendingJoinRoomCode || roomActionPending) {
    void sendPopupLog(
      `Render room=${state.roomCode ?? "none"} connected=${state.connected} pendingJoin=${state.pendingJoinRoomCode ?? "none"} pendingAction=${roomActionPending}`,
    );
  }
}

function formatVideoMeta(url: string | null): string {
  if (!url) {
    return t("actionOpenSharedVideoHint");
  }
  const match = url.match(/\/video\/([^/?]+)/);
  return match ? match[1] : t("actionOpenSharedVideo");
}

function formatVideoOwner(
  members: RoomMember[],
  actorId: string | null,
): string {
  if (!actorId) {
    return "";
  }
  const owner = members.find((member) => member.id === actorId)?.name;
  return owner ? t("ownerSharedBy", { owner }) : "";
}

function renderLogs(
  container: HTMLElement,
  logs: BackgroundToPopupMessage["payload"]["logs"],
): void {
  if (logs.length === 0) {
    container.innerHTML = `<div class="muted">${escapeHtml(t("stateNoLogs"))}</div>`;
    return;
  }

  container.innerHTML = logs
    .map((entry) => {
      const time = new Date(entry.at).toLocaleTimeString(getUiLanguage(), {
        hour12: false,
      });
      return `<div class="log-line">[${time}] [${entry.scope}] ${escapeHtml(entry.message)}</div>`;
    })
    .join("");
}

function renderMemberList(container: HTMLElement, members: RoomMember[]): void {
  if (members.length === 0) {
    container.innerHTML = `<span class="member-chip">${escapeHtml(t("stateNoMembers"))}</span>`;
    return;
  }

  container.innerHTML = members
    .map(
      (member) => `<span class="member-chip">${escapeHtml(member.name)}</span>`,
    )
    .join("");
}

async function handleShareCurrentVideo(): Promise<void> {
  if (!refs) {
    return;
  }

  const state = popupStateSync.popupState ?? (await queryState());
  const activeVideo = await chrome.runtime.sendMessage({
    type: "popup:get-active-video",
  });
  if (!activeVideo?.ok || !activeVideo.payload?.video) {
    if (popupStateSync.popupState) {
      render();
    }
    return;
  }

  const currentVideo = activeVideo.payload.video as {
    title: string;
    url: string;
  };
  if (!state.roomCode) {
    const shouldCreateRoom = window.confirm(t("confirmCreateRoomBeforeShare"));
    if (!shouldCreateRoom) {
      return;
    }
  } else if (
    state.roomState?.sharedVideo?.url &&
    normalizeUrl(state.roomState.sharedVideo.url) !==
      normalizeUrl(currentVideo.url)
  ) {
    const shouldReplace = window.confirm(
      t("confirmReplaceSharedVideo", {
        currentTitle: state.roomState.sharedVideo.title,
        nextTitle: currentVideo.title,
      }),
    );
    if (!shouldReplace) {
      return;
    }
  }

  await chrome.runtime.sendMessage({ type: "popup:share-current-video" });
  if (popupStateSync.popupState) {
    render();
  }
}

function normalizeUrl(url: string | null | undefined): string | null {
  return normalizeBilibiliUrl(url);
}

function bindActions(nodes: PopupRefs): void {
  nodes.joinRoomButton.addEventListener("pointerdown", () => {
    void sendPopupLog(
      `Join button pointerdown disabled=${nodes.joinRoomButton.disabled} pending=${roomActionPending} inputDisabled=${nodes.roomCodeInput.disabled}`,
    );
  });

  nodes.leaveRoomButton.addEventListener("pointerdown", () => {
    void sendPopupLog(
      `Leave button pointerdown disabled=${nodes.leaveRoomButton.disabled} pending=${roomActionPending} room=${lastKnownRoomCode ?? "none"}`,
    );
  });

  nodes.createRoomButton.addEventListener("click", async () => {
    if (roomActionPending) {
      void sendPopupLog(
        "Create room click ignored because room action is pending",
      );
      return;
    }
    void sendPopupLog("Create room button clicked");
    setLocalStatusMessage(null);
    setRoomActionPending(true);
    try {
      const response = (await chrome.runtime.sendMessage({
        type: "popup:create-room",
      })) as BackgroundToPopupMessage;
      applyActionState(response.payload);
      void sendPopupLog("Create room message resolved");
      setRoomActionPending(false);
    } finally {
      if (roomActionPending) {
        setRoomActionPending(false);
      }
    }
  });

  nodes.joinRoomButton.addEventListener("click", async () => {
    if (roomActionPending) {
      void sendPopupLog("Join click ignored because room action is pending");
      return;
    }
    const inviteText = nodes.roomCodeInput.value.trim();
    const invite = parseInviteValue(inviteText);
    if (!invite) {
      setLocalStatusMessage(t("errorInvalidInviteFormat"));
      void sendPopupLog("Join click ignored because invite string is invalid");
      return;
    }
    setLocalStatusMessage(null);
    roomCodeDraft = `${invite.roomCode}:${invite.joinToken}`;
    void sendPopupLog(`Join button clicked room=${invite.roomCode}`);
    setRoomActionPending(true);
    try {
      const response = (await chrome.runtime.sendMessage({
        type: "popup:join-room",
        roomCode: invite.roomCode,
        joinToken: invite.joinToken,
      })) as BackgroundToPopupMessage;
      applyActionState(response.payload);
      void sendPopupLog(`Join message resolved room=${invite.roomCode}`);
      setRoomActionPending(false);
    } finally {
      if (roomActionPending) {
        setRoomActionPending(false);
      }
    }
  });

  nodes.leaveRoomButton.addEventListener("click", async () => {
    if (roomActionPending) {
      void sendPopupLog("Leave click ignored because room action is pending");
      return;
    }
    if (Date.now() - lastRoomEnteredAt < LEAVE_GUARD_MS) {
      void sendPopupLog(
        `Leave click ignored by recent-join guard ${Date.now() - lastRoomEnteredAt}ms`,
      );
      return;
    }
    void sendPopupLog("Leave room button clicked");
    setLocalStatusMessage(null);
    roomCodeDraft = formatInviteDraft(
      lastKnownRoomCode,
      popupStateSync.popupState?.joinToken ?? null,
    );
    setRoomActionPending(true);
    try {
      const response = (await chrome.runtime.sendMessage({
        type: "popup:leave-room",
      })) as BackgroundToPopupMessage;
      applyActionState(response.payload);
      void sendPopupLog("Leave room message resolved");
      setRoomActionPending(false);
    } finally {
      if (roomActionPending) {
        setRoomActionPending(false);
      }
    }
  });

  nodes.copyRoomButton.addEventListener("click", async () => {
    const roomCode = nodes.roomStatus.textContent?.trim();
    const state = await queryState();
    if (!roomCode || roomCode === "-" || !state.joinToken) {
      return;
    }

    await navigator.clipboard.writeText(`${roomCode}:${state.joinToken}`);
    nodes.copyRoomButton.classList.add("success-button");
    if (copyRoomResetTimer !== null) {
      window.clearTimeout(copyRoomResetTimer);
    }
    copyRoomResetTimer = window.setTimeout(() => {
      copyRoomResetTimer = null;
      nodes.copyRoomButton.classList.remove("success-button");
    }, 1400);
  });

  nodes.copyLogsButton.addEventListener("click", async () => {
    const state = await queryState();
    const text = state.logs
      .slice()
      .reverse()
      .map((entry) => {
        const time = new Date(entry.at).toLocaleTimeString(getUiLanguage(), {
          hour12: false,
        });
        return `[${time}] [${entry.scope}] ${entry.message}`;
      })
      .join("\n");

    await navigator.clipboard.writeText(text || t("stateNoLogs"));
    nodes.copyLogsButton.classList.add("success-button");
    if (copyLogsResetTimer !== null) {
      window.clearTimeout(copyLogsResetTimer);
    }
    copyLogsResetTimer = window.setTimeout(() => {
      copyLogsResetTimer = null;
      nodes.copyLogsButton.classList.remove("success-button");
    }, 1400);
  });

  nodes.shareCurrentVideoButton.addEventListener("click", () => {
    void handleShareCurrentVideo();
  });

  nodes.sharedVideoCard.addEventListener("click", async () => {
    await chrome.runtime.sendMessage({ type: "popup:open-shared-video" });
    window.close();
  });

  nodes.roomCodeInput.addEventListener("keydown", async (event) => {
    if (event.key !== "Enter" || roomActionPending) {
      if (event.key === "Enter" && roomActionPending) {
        void sendPopupLog(
          "Join by Enter ignored because room action is pending",
        );
      }
      return;
    }
    const inviteText = nodes.roomCodeInput.value.trim();
    const invite = parseInviteValue(inviteText);
    if (!invite) {
      setLocalStatusMessage(t("errorInvalidInviteFormat"));
      void sendPopupLog(
        "Join by Enter ignored because invite string is invalid",
      );
      return;
    }
    setLocalStatusMessage(null);
    roomCodeDraft = `${invite.roomCode}:${invite.joinToken}`;
    void sendPopupLog(`Join by Enter room=${invite.roomCode}`);
    setRoomActionPending(true);
    try {
      const response = (await chrome.runtime.sendMessage({
        type: "popup:join-room",
        roomCode: invite.roomCode,
        joinToken: invite.joinToken,
      })) as BackgroundToPopupMessage;
      applyActionState(response.payload);
      void sendPopupLog(`Join by Enter resolved room=${invite.roomCode}`);
      setRoomActionPending(false);
    } finally {
      if (roomActionPending) {
        setRoomActionPending(false);
      }
    }
  });

  nodes.roomCodeInput.addEventListener("input", () => {
    applyRoomActionControlState(nodes);
    const inviteText = nodes.roomCodeInput.value.trim();
    const invite = parseInviteValue(inviteText);
    roomCodeDraft = invite
      ? `${invite.roomCode}:${invite.joinToken}`
      : inviteText;
    if (localStatusMessage) {
      setLocalStatusMessage(null);
    }
    if (invite) {
      void sendPopupLog(`Invite input changed room=${invite.roomCode}`);
    }
  });

  const saveServerUrl = async () => {
    setLocalStatusMessage(null);
    const requestedServerUrl = serverUrlDraft.value.trim();
    const response = (await chrome.runtime.sendMessage({
      type: "popup:set-server-url",
      serverUrl: requestedServerUrl,
    })) as BackgroundToPopupMessage;
    applyState(response.payload);
    syncServerUrlDraft(serverUrlDraft, response.payload.serverUrl);
    nodes.serverUrlInput.value = response.payload.serverUrl;
    render();
  };

  nodes.saveServerUrlButton.addEventListener("click", () => {
    void saveServerUrl();
  });

  nodes.serverUrlInput.addEventListener("input", () => {
    updateServerUrlDraft(
      serverUrlDraft,
      nodes.serverUrlInput.value,
      popupStateSync.popupState?.serverUrl ?? "",
    );
    if (localStatusMessage) {
      setLocalStatusMessage(null);
    }
  });

  nodes.serverUrlInput.addEventListener("keydown", async (event) => {
    if (event.key !== "Enter") {
      return;
    }
    event.preventDefault();
    await saveServerUrl();
  });
}
