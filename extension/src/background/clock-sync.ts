import type { RoomState } from "@bili-syncplay/protocol";

export const CLOCK_SYNC_INTERVAL_MS = 15000;

export function toHealthcheckUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "ws:") {
      parsed.protocol = "http:";
    } else if (parsed.protocol === "wss:") {
      parsed.protocol = "https:";
    } else {
      return null;
    }
    parsed.pathname = "/";
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return null;
  }
}

export function toConnectionCheckUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "ws:") {
      parsed.protocol = "http:";
    } else if (parsed.protocol === "wss:") {
      parsed.protocol = "https:";
    } else {
      return null;
    }
    parsed.pathname = "/api/connection-check";
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return null;
  }
}

export function updateClockSample(args: {
  clientSendTime: number;
  serverReceiveTime: number;
  serverSendTime: number;
  now: number;
  previousRttMs: number | null;
  previousClockOffsetMs: number | null;
}): {
  rttMs: number;
  clockOffsetMs: number;
} {
  const sampleRtt = args.now - args.clientSendTime - (args.serverSendTime - args.serverReceiveTime);
  const sampleOffset = ((args.serverReceiveTime - args.clientSendTime) + (args.serverSendTime - args.now)) / 2;

  return {
    rttMs: args.previousRttMs === null ? sampleRtt : Math.round(args.previousRttMs * 0.7 + sampleRtt * 0.3),
    clockOffsetMs:
      args.previousClockOffsetMs === null
        ? sampleOffset
        : Math.round(args.previousClockOffsetMs * 0.7 + sampleOffset * 0.3)
  };
}

export function compensateRoomStateForClock(state: RoomState, clockOffsetMs: number | null, now = Date.now()): RoomState {
  if (!state.playback || clockOffsetMs === null || state.playback.playState !== "playing") {
    return state;
  }

  const estimatedServerNow = now + clockOffsetMs;
  const elapsedMs = Math.max(0, estimatedServerNow - state.playback.serverTime);
  return {
    ...state,
    playback: {
      ...state.playback,
      currentTime: state.playback.currentTime + elapsedMs / 1000 * state.playback.playbackRate
    }
  };
}
