import type { BackgroundToPopupMessage } from "../shared/messages";

export async function queryPopupState(): Promise<
  BackgroundToPopupMessage["payload"]
> {
  const response = (await chrome.runtime.sendMessage({
    type: "popup:get-state",
  })) as BackgroundToPopupMessage;
  return response.payload;
}

export function connectPopupStatePort(args: {
  onState: (state: BackgroundToPopupMessage["payload"]) => void;
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
