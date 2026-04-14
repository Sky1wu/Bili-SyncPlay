import { getDefaultPersistenceConfig, type PersistenceConfig } from "../app.js";
import type { EnvSource } from "./env.js";
import {
  parseBooleanEnv,
  parsePositiveIntegerEnv,
  readTrimmedEnv,
} from "./env.js";

function parseProviderEnv(
  env: EnvSource,
  name: string,
  fallback: PersistenceConfig["provider"],
): PersistenceConfig["provider"] {
  const rawValue = env[name];
  if (rawValue === undefined || rawValue === "") {
    return fallback;
  }
  if (rawValue === "memory" || rawValue === "redis") {
    return rawValue;
  }
  throw new Error(`Environment variable ${name} must be "memory" or "redis".`);
}

function parseRoomEventBusProviderEnv(
  env: EnvSource,
  fallback: PersistenceConfig["roomEventBusProvider"],
): PersistenceConfig["roomEventBusProvider"] {
  const rawValue = env.ROOM_EVENT_BUS_PROVIDER;
  if (rawValue === undefined || rawValue === "") {
    return fallback;
  }
  if (rawValue === "none" || rawValue === "memory" || rawValue === "redis") {
    return rawValue;
  }
  throw new Error(
    'Environment variable ROOM_EVENT_BUS_PROVIDER must be "none", "memory", or "redis".',
  );
}

function parseAdminCommandBusProviderEnv(
  env: EnvSource,
  fallback: PersistenceConfig["adminCommandBusProvider"],
): PersistenceConfig["adminCommandBusProvider"] {
  const rawValue = env.ADMIN_COMMAND_BUS_PROVIDER;
  if (rawValue === undefined || rawValue === "") {
    return fallback;
  }
  if (rawValue === "none" || rawValue === "memory" || rawValue === "redis") {
    return rawValue;
  }
  throw new Error(
    'Environment variable ADMIN_COMMAND_BUS_PROVIDER must be "none", "memory", or "redis".',
  );
}

export function loadPersistenceConfig(
  env: EnvSource = process.env,
): PersistenceConfig {
  const defaults = getDefaultPersistenceConfig();
  const provider = parseProviderEnv(
    env,
    "ROOM_STORE_PROVIDER",
    defaults.provider,
  );
  const runtimeStoreProvider = parseProviderEnv(
    env,
    "RUNTIME_STORE_PROVIDER",
    provider === "redis" ? "redis" : defaults.runtimeStoreProvider,
  );
  const roomEventBusProvider = parseRoomEventBusProviderEnv(
    env,
    runtimeStoreProvider === "redis" ? "redis" : defaults.roomEventBusProvider,
  );
  const adminCommandBusProvider = parseAdminCommandBusProviderEnv(
    env,
    runtimeStoreProvider === "redis"
      ? "redis"
      : defaults.adminCommandBusProvider,
  );

  return {
    provider,
    runtimeStoreProvider,
    roomEventBusProvider,
    adminCommandBusProvider,
    nodeHeartbeatEnabled: parseBooleanEnv(
      env,
      "NODE_HEARTBEAT_ENABLED",
      defaults.nodeHeartbeatEnabled,
    ),
    nodeHeartbeatIntervalMs: parsePositiveIntegerEnv(
      env,
      "NODE_HEARTBEAT_INTERVAL_MS",
      defaults.nodeHeartbeatIntervalMs,
    ),
    nodeHeartbeatTtlMs: parsePositiveIntegerEnv(
      env,
      "NODE_HEARTBEAT_TTL_MS",
      defaults.nodeHeartbeatTtlMs,
    ),
    emptyRoomTtlMs: parsePositiveIntegerEnv(
      env,
      "EMPTY_ROOM_TTL_MS",
      defaults.emptyRoomTtlMs,
    ),
    roomCleanupIntervalMs: parsePositiveIntegerEnv(
      env,
      "ROOM_CLEANUP_INTERVAL_MS",
      defaults.roomCleanupIntervalMs,
    ),
    redisUrl: readTrimmedEnv(env, "REDIS_URL") ?? defaults.redisUrl,
    redisNamespace:
      readTrimmedEnv(env, "REDIS_NAMESPACE") ?? defaults.redisNamespace,
    instanceId: readTrimmedEnv(env, "INSTANCE_ID") ?? defaults.instanceId,
  };
}
