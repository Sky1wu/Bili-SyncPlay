import { getDefaultPersistenceConfig, type PersistenceConfig } from "../app.js";
import type { EnvSource } from "./env.js";
import {
  loadSectionConfigFromEnv,
  parseConfigEnvFieldValue,
  PERSISTENCE_ADMIN_COMMAND_BUS_PROVIDER_FIELD,
  PERSISTENCE_CONFIG_FIELDS,
  PERSISTENCE_PROVIDER_FIELD,
  PERSISTENCE_ROOM_EVENT_BUS_PROVIDER_FIELD,
  PERSISTENCE_RUNTIME_STORE_PROVIDER_FIELD,
} from "./runtime-config-schema.js";

export function loadPersistenceConfig(
  env: EnvSource = process.env,
): PersistenceConfig {
  const defaults = getDefaultPersistenceConfig();
  const provider = parseConfigEnvFieldValue(
    PERSISTENCE_PROVIDER_FIELD,
    env,
    defaults.provider,
  );
  const runtimeStoreProvider = parseConfigEnvFieldValue(
    PERSISTENCE_RUNTIME_STORE_PROVIDER_FIELD,
    env,
    provider === "redis" ? "redis" : defaults.runtimeStoreProvider,
  );
  const roomEventBusProvider = parseConfigEnvFieldValue(
    PERSISTENCE_ROOM_EVENT_BUS_PROVIDER_FIELD,
    env,
    runtimeStoreProvider === "redis" ? "redis" : defaults.roomEventBusProvider,
  );
  const adminCommandBusProvider = parseConfigEnvFieldValue(
    PERSISTENCE_ADMIN_COMMAND_BUS_PROVIDER_FIELD,
    env,
    runtimeStoreProvider === "redis"
      ? "redis"
      : defaults.adminCommandBusProvider,
  );

  return loadSectionConfigFromEnv(env, defaults, PERSISTENCE_CONFIG_FIELDS, {
    "persistence.provider": provider,
    "persistence.runtimeStoreProvider": runtimeStoreProvider,
    "persistence.roomEventBusProvider": roomEventBusProvider,
    "persistence.adminCommandBusProvider": adminCommandBusProvider,
  });
}
