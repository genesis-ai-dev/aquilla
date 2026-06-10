// Workspace auth module — wraps the aquilla-identity (/api/v2/auth/*).
//
// History: this file previously fetched /api/v1/auth/* against the legacy
// frontier-server (api.frontierrnd.com). Phase D cuts that dependency:
// aquilla-identity is now the canonical identity surface and serves /api/v2/*.
//
// `AUTH_BASE` is re-exported so callers that construct identity URLs directly
// (orgs.ts, members.ts, useUserSearch, frontier-health) work unchanged.
//
// `||` (not `??`) so empty-string env values fall back too — `vi.stubEnv`
// uses "" to simulate "unset" in tests, and accidental empty values in a
// prod .env should also use the default rather than break network calls.
export const AUTH_BASE =
  ((import.meta.env.VITE_AUTH_BASE as string | undefined)?.replace(/\/+$/, "")) ||
  "https://api.aquilla.app/identity";

/** @deprecated Use AUTH_BASE directly. Kept as an alias so existing callers
 *  (orgs.ts, members.ts, useUserSearch) compile without churn. */
export const FRONTIER_BASE = AUTH_BASE;

import type { FrontierSession } from "./types";
import { saveSession } from "./session-store";

export class FrontierAuthError extends Error {
  public status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

interface LoginArgs { username: string; password: string; }
interface RegisterArgs { username: string; email: string; password: string; }

interface AuthResponse {
  access_token: string;
  token_type: string;
}

export async function login(args: LoginArgs): Promise<FrontierSession> {
  const res = await fetch(`${AUTH_BASE}/api/v2/auth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(args),
  });
  if (res.status === 401) {
    throw new FrontierAuthError("Invalid username or password", 401);
  }
  if (!res.ok) {
    throw new FrontierAuthError(`Login failed (${res.status})`, res.status);
  }
  const data = (await res.json()) as AuthResponse;
  return finalizeSession(args.username, data);
}

export async function register(args: RegisterArgs): Promise<FrontierSession> {
  const res = await fetch(`${AUTH_BASE}/api/v2/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(args),
  });
  if (!res.ok) {
    // The server returns { detail, error } for validation/conflict errors.
    let message = `Sign up failed (${res.status})`;
    try {
      const body = (await res.json()) as { detail?: string; error?: string };
      message = body.detail || body.error || message;
    } catch {
      // keep generic
    }
    throw new FrontierAuthError(message, res.status);
  }
  const data = (await res.json()) as AuthResponse;
  return finalizeSession(args.username, data);
}

/**
 * Dev-only bypass: hits `/__dev__/login` on the local auth-worker, which
 * upserts a seed user/org/project and mints a JWT. Returns null if the
 * endpoint 404s (i.e. WRANGLER_LOCAL is not set — production), so callers
 * can fall back silently. NEVER call this from a prod build.
 */
export async function devLogin(): Promise<FrontierSession | null> {
  if (!import.meta.env.DEV) return null;
  let res: Response;
  try {
    res = await fetch(`${AUTH_BASE}/__dev__/login`, { method: "POST" });
  } catch {
    return null;
  }
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new FrontierAuthError(`Dev login failed (${res.status})`, res.status);
  }
  const data = (await res.json()) as AuthResponse & { username: string };
  return finalizeSession(data.username, data);
}

export async function requestPasswordReset(email: string): Promise<void> {
  const res = await fetch(`${AUTH_BASE}/api/v2/auth/password-reset/request`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email }),
  });
  if (!res.ok) {
    let message = `Reset request failed (${res.status})`;
    try {
      const body = (await res.json()) as { detail?: string; error?: string };
      message = body.detail || body.error || message;
    } catch {
      // keep generic
    }
    throw new FrontierAuthError(message, res.status);
  }
}

/**
 * Verify a password-reset token before showing the new-password form.
 * Returns normally on success; throws FrontierAuthError on invalid/expired.
 *
 * Server contract: POST /api/v2/auth/password-reset/verify { token, username }
 *   200 → { message: "Token is valid" }
 *   400 → { error: "Invalid token" | "Token expired" }
 */
export async function verifyResetToken(token: string, username: string): Promise<void> {
  const res = await fetch(`${AUTH_BASE}/api/v2/auth/password-reset/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token, username }),
  });
  if (!res.ok) {
    let message = "Invalid or expired reset link";
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) message = body.error;
    } catch {
      // keep generic
    }
    throw new FrontierAuthError(message, res.status);
  }
}

/**
 * Perform the actual password reset.
 * Server contract: POST /api/v2/auth/password-reset/reset { token, username, new_password }
 *   200 → { message: "Password reset successful" }
 *   400 → { error: "Invalid token" | "Token expired" }
 *   500 → { error: "Failed to reset password" }
 */
export async function resetPassword(
  token: string,
  username: string,
  newPassword: string,
): Promise<void> {
  const res = await fetch(`${AUTH_BASE}/api/v2/auth/password-reset/reset`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token, username, new_password: newPassword }),
  });
  if (!res.ok) {
    let message = "Failed to reset password";
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) message = body.error;
    } catch {
      // keep generic
    }
    throw new FrontierAuthError(message, res.status);
  }
}

/**
 * Decode the `sub` claim from a JWT (base64url payload, no signature
 * verification needed here — the server already verified the password before
 * issuing it). Returns null if the token is malformed.
 */
function jwtClaims(token: string): { sub?: string; email?: string } {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return {};
    // atob requires standard base64; JWT uses base64url — swap - and _
    const padded = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const json = atob(padded);
    const payload = JSON.parse(json) as { sub?: unknown; email?: unknown };
    return {
      sub: typeof payload.sub === "string" ? payload.sub : undefined,
      email: typeof payload.email === "string" ? payload.email : undefined,
    };
  } catch {
    return {};
  }
}

async function finalizeSession(loginIdentifier: string, data: AuthResponse): Promise<FrontierSession> {
  // Resolve the canonical username from the JWT's `sub` claim.
  // The server always mints the token with the user record's username (not
  // the email the caller may have typed). Falling back to loginIdentifier
  // preserves backward-compat for any edge case where decoding fails.
  const claims = jwtClaims(data.access_token);
  const resolvedUsername = claims.sub ?? loginIdentifier;
  const session: FrontierSession = {
    jwt: data.access_token,
    username: resolvedUsername,
    createdAt: new Date().toISOString(),
    ...(claims.email ? { email: claims.email } : {}),
  };
  await saveSession(session);
  return session;
}
