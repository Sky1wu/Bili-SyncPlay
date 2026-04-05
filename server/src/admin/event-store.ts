import { randomUUID } from "node:crypto";
import { shouldIncludeRuntimeEvent } from "./event-visibility.js";
import type { RuntimeEvent } from "./types.js";
import type {
  GlobalEventStore,
  GlobalEventStoreQuery,
} from "./global-event-store.js";

export type EventStore = GlobalEventStore;
export type EventStoreQuery = GlobalEventStoreQuery;

export function createEventStore(capacity = 1_000): EventStore {
  const events: RuntimeEvent[] = [];

  function eventTime(event: RuntimeEvent): number {
    return Date.parse(event.timestamp);
  }

  return {
    async append(input) {
      const event: RuntimeEvent = {
        id: randomUUID(),
        timestamp: input.timestamp ?? new Date().toISOString(),
        event: input.event,
        roomCode:
          typeof input.data.roomCode === "string" ? input.data.roomCode : null,
        sessionId:
          typeof input.data.sessionId === "string"
            ? input.data.sessionId
            : null,
        remoteAddress:
          typeof input.data.remoteAddress === "string"
            ? input.data.remoteAddress
            : null,
        origin:
          typeof input.data.origin === "string" ? input.data.origin : null,
        result:
          typeof input.data.result === "string" ? input.data.result : null,
        details: { ...input.data },
      };

      events.push(event);
      if (events.length > capacity) {
        events.shift();
      }
      return event;
    },
    async query(query) {
      const filtered = events.filter((event) => {
        const timestamp = eventTime(event);
        if (
          !shouldIncludeRuntimeEvent(event.event, query.includeSystem === true)
        ) {
          return false;
        }
        if (query.event && event.event !== query.event) {
          return false;
        }
        if (query.roomCode && event.roomCode !== query.roomCode) {
          return false;
        }
        if (query.sessionId && event.sessionId !== query.sessionId) {
          return false;
        }
        if (
          query.remoteAddress &&
          event.remoteAddress !== query.remoteAddress
        ) {
          return false;
        }
        if (query.origin && event.origin !== query.origin) {
          return false;
        }
        if (query.result && event.result !== query.result) {
          return false;
        }
        if (query.from !== undefined && timestamp < query.from) {
          return false;
        }
        if (query.to !== undefined && timestamp > query.to) {
          return false;
        }
        return true;
      });

      filtered.sort((left, right) => eventTime(right) - eventTime(left));
      const start = (query.page - 1) * query.pageSize;
      return {
        items: filtered.slice(start, start + query.pageSize),
        total: filtered.length,
      };
    },
  };
}
