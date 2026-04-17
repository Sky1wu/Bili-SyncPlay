import type {
  ActiveVideoResponse,
  BackgroundPopupState,
  BackgroundToPopupMessage,
  PopupToBackgroundMessage,
} from "../shared/messages";
import {
  isActiveVideoResponse,
  isBackgroundPopupStateMessage,
} from "../shared/messages";

export async function queryPopupState(): Promise<BackgroundPopupState> {
  const response: unknown = await chrome.runtime.sendMessage({
    type: "popup:get-state",
  });
  if (!isBackgroundPopupStateMessage(response)) {
    throw new Error(
      `Unexpected popup state response: ${JSON.stringify(response)}`,
    );
  }
  return response.payload;
}

export async function sendPopupAction(
  message: PopupToBackgroundMessage,
): Promise<BackgroundPopupState> {
  const response: unknown = await chrome.runtime.sendMessage(message);
  if (!isBackgroundPopupStateMessage(response)) {
    throw new Error(
      `Unexpected response to ${message.type}: ${JSON.stringify(response)}`,
    );
  }
  return response.payload;
}

export async function sendPopupActiveVideoQuery(): Promise<ActiveVideoResponse> {
  const response: unknown = await chrome.runtime.sendMessage({
    type: "popup:get-active-video",
  });
  if (!isActiveVideoResponse(response)) {
    throw new Error(
      `Unexpected response to popup:get-active-video: ${JSON.stringify(response)}`,
    );
  }
  return response;
}

export function connectPopupStatePort(args: {
  onState: (state: BackgroundPopupState) => void;
  onDisconnect?: () => void;
}): chrome.runtime.Port {
  const port = chrome.runtime.connect({ name: "popup-state" });
  port.onMessage.addListener((message: BackgroundToPopupMessage) => {
    if (message.type !== "background:state") {
      return;
    }
    args.onState(message.payload);
  });
  port.onDisconnect.addListener(() => {
    args.onDisconnect?.();
  });
  return port;
}
