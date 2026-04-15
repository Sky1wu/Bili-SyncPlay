export interface StateStore<T> {
  getState(): T;
  patch(patch: Partial<T>): T;
  replace(nextState: T): T;
  reset(): T;
}

/**
 * Creates a lightweight store for flat (non-nested) state objects.
 * All mutations are in-place via Object.assign so existing references remain valid.
 */
export function createStore<T extends object>(
  createInitialState: () => T,
): StateStore<T> {
  const state = createInitialState();

  return {
    getState() {
      return state;
    },
    patch(patch) {
      Object.assign(state, patch);
      return state;
    },
    replace(nextState) {
      Object.assign(state, nextState);
      return state;
    },
    reset() {
      Object.assign(state, createInitialState());
      return state;
    },
  };
}
