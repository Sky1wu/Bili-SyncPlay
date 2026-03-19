import {
  getDefaultPersistenceConfig,
  type PersistenceConfig,
} from "../app.js";
import type { EnvSource } from "./env.js";
import {
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

export function loadPersistenceConfig(
  env: EnvSource = process.env,
): PersistenceConfig {
  const defaults = getDefaultPersistenceConfig();
  const provider = parseProviderEnv(env, "ROOM_STORE_PROVIDER", defaults.provider);

  return {
    provider,
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
    instanceId: readTrimmedEnv(env, "INSTANCE_ID") ?? defaults.instanceId,
  };
}
