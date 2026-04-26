import type { BackgroundPopupState } from "../shared/messages";

export interface PopupRoomTrackingState {
  roomActionPending: boolean;
  lastKnownPendingCreateRoom: boolean;
  lastKnownPendingJoinRoomCode: string | null;
  lastKnownRoomCode: string | null;
  lastRoomEnteredAt: number;
}

export interface PopupStateSyncState {
  popupState: BackgroundPopupState | null;
  hasReceivedPortState: boolean;
}

export function createPopupStateSyncState(): PopupStateSyncState {
  return {
    popupState: null,
    hasReceivedPortState: false,
  };
}

export function applyIncomingPopupState(
  state: PopupStateSyncState,
  nextState: BackgroundPopupState,
  source: "port" | "query",
): boolean {
  if (source === "query" && state.hasReceivedPortState) {
    return false;
  }

  state.popupState = nextState;
  if (source === "port") {
    state.hasReceivedPortState = true;
  }
  return true;
}

export function getNextPopupRoomTrackingState(
  currentState: PopupRoomTrackingState,
  nextState: BackgroundPopupState,
  now = Date.now(),
): Pick<
  PopupRoomTrackingState,
  | "lastKnownPendingCreateRoom"
  | "lastKnownPendingJoinRoomCode"
  | "lastKnownRoomCode"
  | "lastRoomEnteredAt"
> {
  const enteredRoomFromLocalAction =
    !currentState.lastKnownRoomCode &&
    Boolean(nextState.roomCode) &&
    (currentState.roomActionPending ||
      currentState.lastKnownPendingCreateRoom ||
      Boolean(currentState.lastKnownPendingJoinRoomCode));

  return {
    lastKnownPendingCreateRoom: nextState.pendingCreateRoom,
    lastKnownPendingJoinRoomCode: nextState.pendingJoinRoomCode,
    lastKnownRoomCode: nextState.roomCode,
    lastRoomEnteredAt: enteredRoomFromLocalAction
      ? now
      : currentState.lastRoomEnteredAt,
  };
}
