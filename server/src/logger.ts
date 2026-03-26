import type { LogEvent } from "./types.js";
import type { GlobalEventStore } from "./admin/global-event-store.js";
import type { RuntimeRegistry } from "./admin/runtime-registry.js";

export function createStructuredLogger(
  writeLine?: (line: string) => void,
  eventStore?: GlobalEventStore,
  runtimeRegistry?: RuntimeRegistry,
): LogEvent {
  return (event, data) => {
    const timestamp = new Date().toISOString();
    (writeLine ?? console.log)(JSON.stringify({ event, timestamp, ...data }));
    eventStore?.append({ event, timestamp, data });
    runtimeRegistry?.recordEvent(event, Date.parse(timestamp));
  };
}
