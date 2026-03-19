import type { BackgroundToPopupMessage } from "../shared/messages";
import { bindPopupActions } from "./popup-actions";
import {
  connectPopupStatePort as createPopupStatePort,
  queryPopupState,
} from "./popup-port";
import {
  applyRoomActionControlState as applyRoomActionControlStateToRefs,
  renderPopup,
} from "./popup-render";
import { renderPopupTemplate } from "./popup-template";
import { collectPopupRefs, type PopupRefs } from "./popup-view";
import { createServerUrlDraftState } from "./server-url-draft";
import {
  applyIncomingPopupState,
  createPopupStateSyncState,
} from "./state-sync";
import { getDocumentLanguage, t } from "../shared/i18n";

const app = document.getElementById("app");

let refs: PopupRefs | null = null;
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
  bindPopupActions({
    refs,
    leaveGuardMs: LEAVE_GUARD_MS,
    serverUrlDraft,
    queryState,
    applyActionState,
    render,
    sendPopupLog,
    getRoomActionPending: () => roomActionPending,
    setRoomActionPending,
    applyRoomActionControlState,
    setRoomCodeDraft: (value) => {
      roomCodeDraft = value;
    },
    getLocalStatusMessage: () => localStatusMessage,
    setLocalStatusMessage,
    getLastKnownRoomCode: () => lastKnownRoomCode,
    getLastRoomEnteredAt: () => lastRoomEnteredAt,
    getPopupState: () => popupStateSync.popupState,
  });
  connectPort();
  const initialState = await queryState();
  if (applyState(initialState, "query")) {
    render();
  }
}

async function queryState(): Promise<BackgroundToPopupMessage["payload"]> {
  return queryPopupState();
}

function applyActionState(state: BackgroundToPopupMessage["payload"]): void {
  applyState(state, "port");
  render();
}

function connectPort(): void {
  popupPort?.disconnect();
  popupPort = createPopupStatePort({
    onState: (state) => {
      if (applyState(state, "port")) {
        render();
      }
    },
    onDisconnect: () => {
      popupPort = null;
    },
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
  applyRoomActionControlStateToRefs({
    refs: nodes,
    roomActionPending,
    lastKnownPendingCreateRoom,
    lastKnownPendingJoinRoomCode,
    lastKnownRoomCode,
  });
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
  renderPopup({
    refs,
    state: popupStateSync.popupState,
    serverUrlDraft,
    roomCodeDraft,
    setRoomCodeDraft: (value) => {
      roomCodeDraft = value;
    },
    localStatusMessage,
    roomActionPending,
    lastKnownPendingCreateRoom,
    lastKnownPendingJoinRoomCode,
    lastKnownRoomCode,
    sendPopupLog,
  });
}
