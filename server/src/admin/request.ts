import type { IncomingMessage } from "node:http";
import { INVALID_JSON_REQUEST_BODY_MESSAGE } from "../messages.js";

export class JsonBodyParseError extends Error {
  constructor(message = INVALID_JSON_REQUEST_BODY_MESSAGE) {
    super(message);
  }
}

export function parseRequestUrl(request: IncomingMessage): URL {
  const host = request.headers.host ?? "localhost";
  return new URL(request.url ?? "/", `http://${host}`);
}

export function getPathSegments(request: IncomingMessage): string[] {
  return parseRequestUrl(request).pathname.split("/").filter(Boolean);
}

export function getQueryParams(request: IncomingMessage): URLSearchParams {
  return parseRequestUrl(request).searchParams;
}

export function getBearerToken(request: IncomingMessage): string | null {
  const authorization = request.headers.authorization;
  if (typeof authorization !== "string") {
    return null;
  }

  const match = authorization.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
}

export async function readJsonBody<T>(request: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];

  for await (const chunk of request) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }

  const rawBody = Buffer.concat(chunks).toString("utf8").trim();
  if (rawBody.length === 0) {
    return {} as T;
  }

  try {
    return JSON.parse(rawBody) as T;
  } catch {
    throw new JsonBodyParseError();
  }
}

export function parsePositiveInt(value: string | null, fallback: number): number {
  if (!value) {
    return fallback;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}
