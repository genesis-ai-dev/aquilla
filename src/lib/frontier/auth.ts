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
export interface LoginOptions {
  onMigrationRequired?: () => void;
}
interface RegisterArgs { username: string; email: string; password: string; }

interface AuthResponse {
  access_token: string;
  token_type: string;
}

function requestLogin(args: LoginArgs, continueMigration = false): Promise<Response> {
  return fetch(`${AUTH_BASE}/api/v2/auth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      ...args,
      migration_handshake: true,
      ...(continueMigration ? { continue_migration: true } : {}),
    }),
  });
}

export async function login(
  args: LoginArgs,
  options: LoginOptions = {},
): Promise<FrontierSession> {
  let res = await requestLogin(args);
  if (res.status === 202) {
    const body = (await res.json()) as { status?: string };
    if (body.status !== "migration_required") {
      throw new FrontierAuthError("Login failed (202)", 202);
    }
    options.onMigrationRequired?.();
    res = await requestLogin(args, true);
  }
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

/**
 * Marketing/demo auto-login. Unlike devLogin this is NOT gated on
 * import.meta.env.DEV — the curated demo is meant to run in production-like
 * builds (the recording harness uses `vite build`, and a public demo build is
 * production). The real gate is server-side: /__marketing__/login 404s unless
 * the auth-worker has it enabled (WRANGLER_LOCAL / demo mode), so a normal
 * prod build simply gets null here and the route shows "demo unavailable".
 */
export async function marketingLogin(): Promise<FrontierSession | null> {
  let res: Response;
  try {
    res = await fetch(`${AUTH_BASE}/__marketing__/login`, { method: "POST" });
  } catch {
    return null;
  }
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new FrontierAuthError(`Marketing login failed (${res.status})`, res.status);
  }
  const data = (await res.json()) as AuthResponse & { username: string };
  return finalizeSession(data.username, data);
}

export interface AccessLinkResult {
  session: FrontierSession;
  /** The project the bound account should land in. */
  projectId: string;
}

/**
 * AQU-626: redeem a per-user deep link + PIN (fresh-browser / diode-zone flow).
 *
 * On success a session for the bound account is persisted (via finalizeSession,
 * like a normal login) and the target project id is returned so the caller can
 * land the fresh browser straight in the workspace, skipping onboarding.
 *
 * Any failure — unknown/expired/revoked/locked link, or a wrong PIN — surfaces
 * as one indistinguishable error. The link + PIN together ARE the credential,
 * so the client never reveals which half was wrong (mirrors the server, which
 * returns the same 401 for every failure path).
 */
export async function redeemAccessLink(token: string, pin: string): Promise<AccessLinkResult> {
  let res: Response;
  try {
    res = await fetch(`${AUTH_BASE}/api/v2/access-links/${encodeURIComponent(token)}/redeem`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pin }),
    });
  } catch {
    throw new FrontierAuthError("Couldn't reach the server. Check your connection and try again.", 0);
  }
  if (!res.ok) {
    let message = "This link is invalid or has expired.";
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) message = body.error;
    } catch {
      // keep generic
    }
    throw new FrontierAuthError(message, res.status);
  }
  const data = (await res.json()) as AuthResponse & { username: string; project_id: string };
  const session = await finalizeSession(data.username, data);
  return { session, projectId: data.project_id };
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
 * Verify an email-verification token (soft verification).
 * Server contract: POST /api/v2/auth/verify-email { token }
 *   200 → { verified: true }
 *   404 → invalid / already-used · 410 → expired
 */
export async function verifyEmail(token: string): Promise<void> {
  const res = await fetch(`${AUTH_BASE}/api/v2/auth/verify-email`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token }),
  });
  if (!res.ok) {
    let message = "This verification link is invalid or has expired.";
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

/**
 * True only when a JWT's `exp` claim is provably in the past. Lets the client
 * detect an expired session WITHOUT a network round-trip so flows like the
 * invite JoinPage can re-prompt login instead of mistaking an auth-expiry for
 * an invalid invite (the accept endpoint 401s on an expired token, which the
 * old code surfaced as "this invite link is no longer valid").
 *
 * Conservative by design: returns false whenever expiry can't be determined
 * (no token, malformed, missing/non-numeric `exp`) so a currently-working
 * session is never forced to re-login on a decode hiccup. A small skew avoids
 * accepting a token that's about to lapse mid-request.
 */
export function isJwtExpired(token: string | null | undefined, skewSeconds = 30): boolean {
  if (!token) return false;
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return false;
    // atob requires standard base64; JWT uses base64url — swap - and _
    const padded = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const payload = JSON.parse(atob(padded)) as { exp?: unknown };
    if (typeof payload.exp !== "number") return false;
    return Date.now() >= (payload.exp - skewSeconds) * 1000;
  } catch {
    return false;
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
