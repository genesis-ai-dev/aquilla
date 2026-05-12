import type { FrontierSession } from "./types";
import { saveSession } from "./session-store";

// `||` (not `??`) so empty-string env values fall back too — `vi.stubEnv` sets
// "" to simulate "unset" in tests, and an accidental empty value in a prod
// .env should also use the default rather than break network calls.
export const FRONTIER_BASE =
  ((import.meta.env.VITE_FRONTIER_BASE as string | undefined)?.replace(/\/+$/, "")) ||
  "https://api.frontierrnd.com";

// Auth + sync-token + invite routes have been ported into the codex-auth-worker
// in this repo. Default to FRONTIER_BASE so unconfigured environments still hit
// the legacy frontier-server. CI wires VITE_AUTH_BASE per-branch.
export const AUTH_BASE =
  ((import.meta.env.VITE_AUTH_BASE as string | undefined)?.replace(/\/+$/, "")) ||
  FRONTIER_BASE;

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
  gitlab_token: string;
  gitlab_url: string;
}

export async function login(args: LoginArgs): Promise<FrontierSession> {
  const res = await fetch(`${AUTH_BASE}/api/v1/auth/token`, {
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
  const res = await fetch(`${AUTH_BASE}/api/v1/auth/register`, {
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
  const res = await fetch(`${AUTH_BASE}/api/v1/auth/password-reset/request`, {
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
    gitlabToken: data.gitlab_token,
    gitlabUrl: data.gitlab_url.replace(/\/+$/, ""),
    username,
    createdAt: new Date().toISOString(),
  };
  await saveSession(session);
  return session;
}
