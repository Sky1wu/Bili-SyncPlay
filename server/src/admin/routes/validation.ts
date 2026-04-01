import { AdminActionError } from "../action-service.js";

function throwBadRequest(
  code: string,
  message: string,
  details?: Record<string, unknown>,
): never {
  throw new AdminActionError(400, code, message, details);
}

export function requireSegment(
  segments: string[],
  index: number,
  name: string,
): string {
  const value = segments[index];
  if (!value) {
    throwBadRequest("invalid_path_param", `Missing ${name}.`, { name });
  }
  return value;
}

export function requireNonEmptyString(value: string, name: string): string {
  const trimmed = decodeURIComponent(value).trim();
  if (!trimmed) {
    throwBadRequest("invalid_path_param", `Invalid ${name}.`, { name });
  }
  return trimmed;
}

export function assertMaxLength(
  value: string,
  maxLength: number,
  name: string,
): string {
  if (value.length > maxLength) {
    throwBadRequest("input_too_long", `${name} is too long.`, {
      name,
      maxLength,
    });
  }
  return value;
}
