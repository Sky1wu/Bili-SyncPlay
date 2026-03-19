import type { DebugLogEntry } from "../shared/messages";
import { appendLog, formatContentLogSource } from "./logger";
import type {
  ConnectionState,
  DiagnosticsState,
  RoomSessionState,
} from "./runtime-state";

const HEARTBEAT_LOG_INTERVAL_MS = 10000;

export interface DiagnosticsController {
  log(scope: DebugLogEntry["scope"], message: string): void;
  maybeLogPopupStateRequest(): void;
  shouldLogOutgoingMessage(type: string, now?: number): boolean;
  shouldLogIncomingMessage(type: string, now?: number): boolean;
  formatContentSource(sender: chrome.runtime.MessageSender): string;
}

export function createDiagnosticsController(args: {
  diagnosticsState: DiagnosticsState;
  roomSessionState: RoomSessionState;
  connectionState: ConnectionState;
  onLog: () => void;
}): DiagnosticsController {
  const outgoingMessageLogState = new Map<string, number>();
  const incomingMessageLogState = new Map<string, number>();

  function log(scope: DebugLogEntry["scope"], message: string): void {
    args.diagnosticsState.logs = appendLog(
      args.diagnosticsState.logs,
      scope,
      message,
    );
    args.onLog();
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
    const key = `${args.roomSessionState.roomCode ?? "none"}|${args.connectionState.connected}|${args.roomSessionState.pendingJoinRoomCode ?? "none"}`;
    if (key === args.diagnosticsState.lastPopupStateLogKey) {
      return;
    }
    args.diagnosticsState.lastPopupStateLogKey = key;
    log(
      "background",
      `Popup requested state room=${args.roomSessionState.roomCode ?? "none"} connected=${args.connectionState.connected} pendingJoin=${args.roomSessionState.pendingJoinRoomCode ?? "none"}`,
    );
  }

  return {
    log,
    maybeLogPopupStateRequest,
    shouldLogOutgoingMessage: (type, now) =>
      shouldLogHeartbeatMessage(outgoingMessageLogState, type, now),
    shouldLogIncomingMessage: (type, now) =>
      shouldLogHeartbeatMessage(incomingMessageLogState, type, now),
    formatContentSource: formatContentLogSource,
  };
}
