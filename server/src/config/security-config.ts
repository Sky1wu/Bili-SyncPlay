import { getDefaultSecurityConfig, type SecurityConfig } from "../app.js";
import type { EnvSource } from "./env.js";
import {
  loadSectionConfigFromEnv,
  SECURITY_CONFIG_FIELDS,
} from "./runtime-config-schema.js";

export function loadSecurityConfig(
  env: EnvSource = process.env,
): SecurityConfig {
  return loadSectionConfigFromEnv(
    env,
    getDefaultSecurityConfig(),
    SECURITY_CONFIG_FIELDS,
  );
}
