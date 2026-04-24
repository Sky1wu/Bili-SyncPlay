import {
  ADMIN_AUTH_UNAVAILABLE_MESSAGE,
  INVALID_CREDENTIALS_MESSAGE,
  TOO_MANY_LOGIN_ATTEMPTS_MESSAGE,
  UNAUTHORIZED_MESSAGE,
} from "../../messages.js";
import { InvalidCredentialsError } from "../auth-service.js";
import { getBearerToken, readJsonBody } from "../request.js";
import { sendError, sendOk } from "../response.js";
import type { AdminRouteHandler } from "../router-types.js";
import { assertMaxLength } from "./validation.js";

const MAX_ADMIN_USERNAME_LENGTH = 128;
const MAX_ADMIN_PASSWORD_LENGTH = 512;
const MAX_ADMIN_TOKEN_LENGTH = 1024;

// Admin sessions are issued as opaque bearer tokens delivered via the
// `Authorization` header. Cookies are intentionally not used for admin auth,
// which avoids the need to maintain cookie security attributes and neutralizes
// classic CSRF against session cookies. The regression tests cover this policy.
export const handleAuthRoutes: AdminRouteHandler = async ({
  request,
  response,
  pathname,
  helpers,
  options,
}) => {
  if (request.method === "POST" && pathname === "/api/admin/auth/login") {
    if (!helpers.requireWriteOrigin(request, response)) {
      return true;
    }
    if (!options.authService) {
      sendError(
        response,
        503,
        "admin_auth_unavailable",
        ADMIN_AUTH_UNAVAILABLE_MESSAGE,
      );
      return true;
    }
    const body = await readJsonBody<{
      username?: string;
      password?: string;
    }>(request);
    const username = assertMaxLength(
      body.username?.trim() ?? "",
      MAX_ADMIN_USERNAME_LENGTH,
      "username",
    );
    const password = assertMaxLength(
      body.password ?? "",
      MAX_ADMIN_PASSWORD_LENGTH,
      "password",
    );
    const ipKey = helpers.getIpKey(request);
    if (options.loginRateLimiter) {
      const limitCheck = options.loginRateLimiter.check({ ipKey, username });
      if (!limitCheck.ok) {
        const retryAfterSeconds = Math.max(
          1,
          Math.ceil(limitCheck.retryAfterMs / 1000),
        );
        response.setHeader("retry-after", String(retryAfterSeconds));
        sendError(
          response,
          429,
          "too_many_login_attempts",
          TOO_MANY_LOGIN_ATTEMPTS_MESSAGE,
          { dimension: limitCheck.dimension, retryAfterSeconds },
        );
        return true;
      }
    }
    try {
      const result = await options.authService.login(username, password);
      options.loginRateLimiter?.registerSuccess({ ipKey, username });
      sendOk(response, {
        token: result.token,
        expiresAt: result.expiresAt,
        admin: {
          id: result.admin.adminId,
          username: result.admin.username,
          role: result.admin.role,
        },
      });
    } catch (error) {
      // Only count credential mismatches toward the rate limiter. Backend
      // failures (session store outages, etc.) must not inflate the counter,
      // otherwise a transient outage can lock legitimate admins out after it
      // recovers.
      if (error instanceof InvalidCredentialsError) {
        options.loginRateLimiter?.registerFailure({ ipKey, username });
        sendError(
          response,
          401,
          "invalid_credentials",
          INVALID_CREDENTIALS_MESSAGE,
        );
        return true;
      }
      throw error;
    }
    return true;
  }

  if (request.method === "POST" && pathname === "/api/admin/auth/logout") {
    if (!helpers.requireWriteOrigin(request, response)) {
      return true;
    }
    const token = getBearerToken(request);
    if (token) {
      assertMaxLength(token, MAX_ADMIN_TOKEN_LENGTH, "token");
    }
    if (!token || !options.authService) {
      sendError(response, 401, "unauthorized", UNAUTHORIZED_MESSAGE);
      return true;
    }
    await options.authService.logout(token);
    sendOk(response, { success: true });
    return true;
  }

  if (request.method === "GET" && pathname === "/api/admin/me") {
    const session = await helpers.requireAdmin(request, response);
    if (!session) {
      return true;
    }
    sendOk(response, {
      id: session.adminId,
      username: session.username,
      role: session.role,
      expiresAt: session.expiresAt,
      lastSeenAt: session.lastSeenAt,
    });
    return true;
  }

  return false;
};
