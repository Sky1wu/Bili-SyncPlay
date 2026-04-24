import { getDefaultSecurityConfig, type SecurityConfig } from "../app.js";
import type { EnvSource } from "./env.js";
import {
  loadSectionConfigFromEnv,
  SECURITY_CONFIG_FIELDS,
} from "./runtime-config-schema.js";

const SUPPORTED_ORIGIN_PROTOCOLS = new Set([
  "http:",
  "https:",
  "chrome-extension:",
]);

export class SecurityConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SecurityConfigError";
  }
}

export function validateAllowedOriginValues(origins: readonly string[]): void {
  for (const origin of origins) {
    if (typeof origin !== "string" || origin.length === 0) {
      throw new SecurityConfigError(
        `ALLOWED_ORIGINS contains an empty or non-string entry.`,
      );
    }
    if (origin.includes("*")) {
      throw new SecurityConfigError(
        `ALLOWED_ORIGINS entry "${origin}" uses a wildcard, which is not supported.`,
      );
    }

    let parsed: URL;
    try {
      parsed = new URL(origin);
    } catch {
      throw new SecurityConfigError(
        `ALLOWED_ORIGINS entry "${origin}" is not a valid absolute URL.`,
      );
    }

    if (!SUPPORTED_ORIGIN_PROTOCOLS.has(parsed.protocol)) {
      throw new SecurityConfigError(
        `ALLOWED_ORIGINS entry "${origin}" uses unsupported scheme "${parsed.protocol.replace(/:$/, "")}"; expected one of http, https, chrome-extension.`,
      );
    }

    if (parsed.host.length === 0) {
      throw new SecurityConfigError(
        `ALLOWED_ORIGINS entry "${origin}" must include a host.`,
      );
    }

    const canonical = `${parsed.protocol}//${parsed.host}`;
    if (origin !== canonical) {
      throw new SecurityConfigError(
        `ALLOWED_ORIGINS entry "${origin}" must be a bare origin like "${canonical}" — no path, query, fragment, userinfo, trailing slash, or mixed-case host (HTTP Origin headers are exact-matched).`,
      );
    }
  }
}

export function assertAllowedOriginsStartupPolicy(
  config: SecurityConfig,
): void {
  if (config.allowedOrigins.length === 0 && !config.allowMissingOriginInDev) {
    throw new SecurityConfigError(
      "ALLOWED_ORIGINS is empty; set ALLOW_MISSING_ORIGIN_IN_DEV=true to run without origin restrictions in development, or configure ALLOWED_ORIGINS for production.",
    );
  }
}

export type OriginPolicyLogger = (message: string) => void;

export function logEffectiveOriginPolicy(
  config: SecurityConfig,
  log: OriginPolicyLogger = (message) => {
    console.log(message);
  },
): void {
  const origins =
    config.allowedOrigins.length === 0
      ? "<none>"
      : config.allowedOrigins.join(", ");
  log(
    `[security] ALLOWED_ORIGINS=${origins}; ALLOW_MISSING_ORIGIN_IN_DEV=${String(config.allowMissingOriginInDev)}`,
  );
}

export function loadSecurityConfig(
  env: EnvSource = process.env,
): SecurityConfig {
  const config = loadSectionConfigFromEnv(
    env,
    getDefaultSecurityConfig(),
    SECURITY_CONFIG_FIELDS,
  );
  validateAllowedOriginValues(config.allowedOrigins);
  return config;
}
