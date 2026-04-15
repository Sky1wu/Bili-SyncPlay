import { createStore, type StateStore } from "../shared/create-store";
import {
  createContentRuntimeState,
  type ContentRuntimeState,
} from "./runtime-state";

export type ContentStateStore = StateStore<ContentRuntimeState>;

export function createContentStateStore(): ContentStateStore {
  return createStore<ContentRuntimeState>(createContentRuntimeState);
}
