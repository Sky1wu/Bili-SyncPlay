import type {
  BackgroundToContentMessage,
  BackgroundToPopupMessage,
} from "../shared/messages";
import { createPopupStateSnapshot } from "./popup-bus";

export interface PopupStateController {
  popupState(): BackgroundToPopupMessage;
  broadcastPopupState(): void;
  notifyAll(): void;
  hasPopupConnections(): boolean;
  attachPort(port: chrome.runtime.Port): void;
}

export function createPopupStateController(args: {
  createState: () => ReturnType<
    typeof createPopupStateSnapshot
  >["payload"]["state"];
  getRetryInMs: () => number | null;
  retryAttemptMax: number;
  notifyContentScripts: (message: BackgroundToContentMessage) => Promise<void>;
  getSyncStatus: () => {
    roomCode: string | null;
    connected: boolean;
    memberId: string | null;
  };
}): PopupStateController {
  const popupPorts = new Set<chrome.runtime.Port>();

  function popupState(): BackgroundToPopupMessage {
    return createPopupStateSnapshot({
      state: args.createState(),
      retryInMs: args.getRetryInMs(),
      retryAttemptMax: args.retryAttemptMax,
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
    void args.notifyContentScripts({
      type: "background:sync-status",
      payload: args.getSyncStatus(),
    });
  }

  function attachPort(port: chrome.runtime.Port): void {
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
  }

  return {
    popupState,
    broadcastPopupState,
    notifyAll,
    hasPopupConnections: () => popupPorts.size > 0,
    attachPort,
  };
}
