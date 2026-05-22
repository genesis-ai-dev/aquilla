// Workspace auth module — wraps the codex-auth-worker (/api/v2/auth/*).
//
// History: this file previously fetched /api/v1/auth/* against the legacy
// frontier-server (api.frontierrnd.com). Phase D cuts that dependency:
// codex-auth-worker is now the canonical identity surface and serves /api/v2/*.
//
// `AUTH_BASE` is re-exported so callers that construct identity URLs directly
// (orgs.ts, members.ts, useUserSearch, frontier-health) work unchanged.
//
// `||` (not `??`) so empty-string env values fall back too — `vi.stubEnv`
// uses "" to simulate "unset" in tests, and accidental empty values in a
// prod .env should also use the default rather than break network calls.
export const AUTH_BASE =
  ((import.meta.env.VITE_AUTH_BASE as string | undefined)?.replace(/\/+$/, "")) ||
  "https://aquilla-identity.blue-darkness-7674.workers.dev";

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

async function finalizeSession(username: string, data: AuthResponse): Promise<FrontierSession> {
  const session: FrontierSession = {
    jwt: data.access_token,
    username,
    createdAt: new Date().toISOString(),
  };
  await saveSession(session);
  return session;
}
