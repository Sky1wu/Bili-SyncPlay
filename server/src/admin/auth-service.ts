import {
  createHash,
  randomBytes,
  randomUUID,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";
import type { AdminSessionStore } from "../admin-session-store.js";
import type { AdminRole, AdminSession } from "./types.js";

export type AdminAuthConfig = {
  username: string;
  passwordHash: string;
  sessionSecret: string;
  sessionTtlMs: number;
  role: AdminRole;
};

export type AdminAuthService = {
  login: (
    username: string,
    password: string,
  ) => Promise<{ token: string; expiresAt: number; admin: AdminSession }>;
  authenticate: (token: string) => Promise<AdminSession | null>;
  logout: (token: string) => Promise<void>;
};

export class InvalidCredentialsError extends Error {
  constructor() {
    super("invalid_credentials");
    this.name = "InvalidCredentialsError";
  }
}

function sha256(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

function verifyPassword(password: string, passwordHash: string): boolean {
  if (passwordHash.startsWith("sha256:")) {
    const expected = Buffer.from(passwordHash.slice("sha256:".length), "hex");
    const actual = sha256(password);
    return (
      expected.length === actual.length && timingSafeEqual(actual, expected)
    );
  }

  if (passwordHash.startsWith("scrypt:")) {
    const [, salt, hash] = passwordHash.split(":");
    if (!salt || !hash) {
      return false;
    }
    const expected = Buffer.from(hash, "base64url");
    const actual = scryptSync(password, salt, expected.length);
    return timingSafeEqual(actual, expected);
  }

  return false;
}

function tokenIdOf(secret: string, token: string): string {
  return createHash("sha256")
    .update(secret)
    .update(":")
    .update(token)
    .digest("hex");
}

export function createAdminAuthService(
  config: AdminAuthConfig,
  store: AdminSessionStore,
  now: () => number = Date.now,
): AdminAuthService {
  return {
    async login(username, password) {
      if (
        username !== config.username ||
        !verifyPassword(password, config.passwordHash)
      ) {
        throw new InvalidCredentialsError();
      }

      const currentTime = now();
      const token = randomBytes(32).toString("base64url");
      const session: AdminSession = {
        id: randomUUID(),
        adminId: "admin-1",
        username: config.username,
        role: config.role,
        createdAt: currentTime,
        expiresAt: currentTime + config.sessionTtlMs,
        lastSeenAt: currentTime,
      };
      await store.save(tokenIdOf(config.sessionSecret, token), session);
      return { token, expiresAt: session.expiresAt, admin: session };
    },
    async authenticate(token) {
      const tokenId = tokenIdOf(config.sessionSecret, token);
      const session = await store.get(tokenId);
      if (!session) {
        return null;
      }
      const currentTime = now();
      if (session.expiresAt <= currentTime) {
        await store.delete(tokenId);
        return null;
      }
      const nextSession: AdminSession = {
        ...session,
        lastSeenAt: currentTime,
      };
      await store.save(tokenId, nextSession);
      return nextSession;
    },
    async logout(token) {
      await store.delete(tokenIdOf(config.sessionSecret, token));
    },
  };
}
