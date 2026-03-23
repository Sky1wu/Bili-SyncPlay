import type { DebugLogEntry } from "../shared/messages";

export const MAX_LOGS = 200;

export function appendLog(
  logs: DebugLogEntry[],
  scope: DebugLogEntry["scope"],
  message: string,
  now = Date.now(),
): DebugLogEntry[] {
  return [{ at: now, scope, message }, ...logs].slice(0, MAX_LOGS);
}

export function formatContentLogSource(
  sender: chrome.runtime.MessageSender,
): string {
  const tabId = sender.tab?.id;
  const rawUrl = sender.tab?.url ?? sender.url ?? null;
  if (!rawUrl) {
    return tabId !== undefined ? `tab=${tabId}` : "tab=unknown";
  }

  try {
    const parsed = new URL(rawUrl);
    const conciseUrl = `${parsed.origin}${parsed.pathname}`;
    return tabId !== undefined ? `tab=${tabId} ${conciseUrl}` : conciseUrl;
  } catch {
    return tabId !== undefined ? `tab=${tabId} ${rawUrl}` : rawUrl;
  }
}
