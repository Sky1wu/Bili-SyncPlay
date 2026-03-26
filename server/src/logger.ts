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
    if (eventStore) {
      void Promise.resolve(eventStore.append({ event, timestamp, data })).catch(
        (error: unknown) => {
          console.error("Failed to append runtime event", error);
        },
      );
    }
    runtimeRegistry?.recordEvent(event, Date.parse(timestamp));
  };
}
