import type { FrontierSession } from "./types";
import { saveSession } from "./session-store";

export const FRONTIER_BASE = "https://api.frontierrnd.com";

export class FrontierAuthError extends Error {
  constructor(message: string, public status: number) { super(message); }
}

interface LoginArgs { username: string; password: string; }

interface LoginResponse {
  access_token: string;
  token_type: string;
  gitlab_token: string;
  gitlab_url: string;
}

export async function login(args: LoginArgs): Promise<FrontierSession> {
  const res = await fetch(`${FRONTIER_BASE}/api/v1/auth/token`, {
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
  const data = (await res.json()) as LoginResponse;
  const session: FrontierSession = {
    jwt: data.access_token,
    gitlabToken: data.gitlab_token,
    gitlabUrl: data.gitlab_url.replace(/\/+$/, ""),
    username: args.username,
    createdAt: new Date().toISOString(),
  };
  await saveSession(session);
  return session;
}
