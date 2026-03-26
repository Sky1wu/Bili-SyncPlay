import type { RuntimeEvent } from "./types.js";

export type GlobalEventStoreQuery = {
  event?: string;
  roomCode?: string;
  sessionId?: string;
  remoteAddress?: string;
  origin?: string;
  result?: string;
  from?: number;
  to?: number;
  page: number;
  pageSize: number;
};

export type GlobalEventStoreQueryResult = {
  items: RuntimeEvent[];
  total: number;
};

export type GlobalEventStoreAppendInput = {
  event: string;
  timestamp?: string;
  data: Record<string, unknown>;
};

export type GlobalEventStore = {
  append: (
    input: GlobalEventStoreAppendInput,
  ) => RuntimeEvent | Promise<RuntimeEvent>;
  query: (
    query: GlobalEventStoreQuery,
  ) => GlobalEventStoreQueryResult | Promise<GlobalEventStoreQueryResult>;
};
