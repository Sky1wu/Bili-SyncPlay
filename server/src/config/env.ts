export type EnvSource = Record<string, string | undefined>;

export function readTrimmedEnv(
  env: EnvSource,
  name: string,
): string | undefined {
  const rawValue = env[name];
  const trimmedValue = rawValue?.trim();
  return trimmedValue ? trimmedValue : undefined;
}

export function parseCsvEnv(
  env: EnvSource,
  name: string,
  fallback: string[],
): string[] {
  const rawValue = env[name];
  if (!rawValue) {
    return fallback;
  }

  return rawValue
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export function parseBooleanEnv(
  env: EnvSource,
  name: string,
  fallback: boolean,
): boolean {
  const rawValue = env[name];
  if (rawValue === undefined) {
    return fallback;
  }

  if (rawValue === "true") {
    return true;
  }
  if (rawValue === "false") {
    return false;
  }

  throw new Error(`Environment variable ${name} must be "true" or "false".`);
}

export function parseIntegerEnv(
  env: EnvSource,
  name: string,
  fallback: number,
): number {
  const rawValue = env[name];
  if (rawValue === undefined) {
    return fallback;
  }

  const parsedValue = Number(rawValue);
  if (!Number.isInteger(parsedValue)) {
    throw new Error(`Environment variable ${name} must be an integer.`);
  }
  return parsedValue;
}

export function parsePositiveIntegerEnv(
  env: EnvSource,
  name: string,
  fallback: number,
): number {
  const parsedValue = parseIntegerEnv(env, name, fallback);
  if (parsedValue <= 0) {
    throw new Error(`Environment variable ${name} must be greater than 0.`);
  }
  return parsedValue;
}
