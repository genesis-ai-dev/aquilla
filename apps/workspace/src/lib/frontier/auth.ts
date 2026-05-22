// Workspace-local wrapper around the shared @aquilla/auth-client.
//
// History: this file used to fetch /api/v1/auth/* against aquilla-identity
// directly. aquilla-identity still serves those as a legacy alias, but the
// canonical surface is /api/v2/auth/*, which @aquilla/auth-client wraps.
// apps/login, apps/signup and apps/reset already go through auth-client;
// the workspace now does too, so every entry point uses the same identity
// provider through the same v2 endpoints.
//
// The wrapper survives because workspace callers depend on:
//   - `FrontierAuthError`     (instanceof checks in the Frontier* forms)
//   - `AUTH_BASE`             (used by orgs.ts, members.ts, useUserSearch,
//     frontier-health — they construct identity URLs directly off this
//     constant)
//   - `FrontierSession`       (IDB envelope shape used by useAccounts)
//   - `saveSession`-backed login/register so the multi-account picker
//     keeps seeing the new session immediately
//
// Re-exporting AUTH_BASE from auth-client keeps the env-var fallback rules
// (VITE_AUTH_BASE, empty-string ⇒ default) in one place.

import {
  AuthClientError,
  login as authClientLogin,
  signup as authClientSignup,
  requestPasswordReset as authClientRequestPasswordReset,
} from "@aquilla/auth-client";
import type { FrontierSession } from "./types";
import { saveSession } from "./session-store";

// Read VITE_AUTH_BASE here (rather than re-exporting auth-client's
// captured constant) so callers that import { AUTH_BASE } from this
// module pick up the same env-var fallback rules and tests that use
// vi.stubEnv + vi.resetModules see the override on re-import.
export const AUTH_BASE =
  ((import.meta.env.VITE_AUTH_BASE as string | undefined)?.replace(/\/+$/, "")) ||
  "https://aquilla-identity.blue-darkness-7674.workers.dev";

export class FrontierAuthError extends Error {
  public status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

interface LoginArgs { username: string; password: string; }
interface RegisterArgs { username: string; email: string; password: string; }

function toFrontierAuthError(err: unknown, fallback: string): FrontierAuthError {
  if (err instanceof AuthClientError) {
    return new FrontierAuthError(err.message, err.status);
  }
  if (err instanceof Error) {
    return new FrontierAuthError(err.message || fallback, 0);
  }
  return new FrontierAuthError(fallback, 0);
}

export async function login(args: LoginArgs): Promise<FrontierSession> {
  try {
    const { jwt, username } = await authClientLogin({
      usernameOrEmail: args.username,
      password: args.password,
    });
    return finalizeSession(username, jwt);
  } catch (err) {
    // Preserve the historical 401 message for callers that surface it raw.
    if (err instanceof AuthClientError && err.status === 401) {
      throw new FrontierAuthError("Invalid username or password", 401);
    }
    throw toFrontierAuthError(err, "Login failed");
  }
}

export async function register(args: RegisterArgs): Promise<FrontierSession> {
  try {
    const { jwt, username } = await authClientSignup({
      username: args.username,
      email: args.email,
      password: args.password,
    });
    return finalizeSession(username, jwt);
  } catch (err) {
    throw toFrontierAuthError(err, "Sign up failed");
  }
}

export async function requestPasswordReset(email: string): Promise<void> {
  try {
    await authClientRequestPasswordReset(email);
  } catch (err) {
    throw toFrontierAuthError(err, "Reset request failed");
  }
}

async function finalizeSession(username: string, jwt: string): Promise<FrontierSession> {
  const session: FrontierSession = {
    jwt,
    username,
    createdAt: new Date().toISOString(),
  };
  await saveSession(session);
  return session;
}
