import { createStore, type StateStore } from "../shared/create-store";

export interface PopupUiState {
  roomActionPending: boolean;
  localRoomEntryPending: boolean;
  lastKnownPendingCreateRoom: boolean;
  lastKnownPendingJoinRoomCode: string | null;
  lastKnownRoomCode: string | null;
  lastRoomEnteredAt: number;
  roomCodeDraft: string;
  localStatusMessage: string | null;
  copyRoomSuccess: boolean;
  copyLogsSuccess: boolean;
  popupPort: chrome.runtime.Port | null;
}

export type PopupUiStateStore = StateStore<PopupUiState>;

export function createPopupUiState(): PopupUiState {
  return {
    roomActionPending: false,
    localRoomEntryPending: false,
    lastKnownPendingCreateRoom: false,
    lastKnownPendingJoinRoomCode: null,
    lastKnownRoomCode: null,
    lastRoomEnteredAt: 0,
    roomCodeDraft: "",
    localStatusMessage: null,
    copyRoomSuccess: false,
    copyLogsSuccess: false,
    popupPort: null,
  };
}

export function createPopupUiStateStore(): PopupUiStateStore {
  return createStore<PopupUiState>(createPopupUiState);
}
