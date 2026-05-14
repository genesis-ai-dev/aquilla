// Auth client for apps/login, apps/signup, apps/reset (Phase 3b).
//
// Wraps the identity-service REST endpoints currently served by
// auth-worker (`/api/v2/auth/*`). The auth-worker is being renamed to
// `aquilla-frontier-server` in Phase 3e, but every callsite goes through
// `VITE_AUTH_BASE`, so flipping the env var at deploy time is the only
// change required when the rename lands.
//
// All HTTP plumbing here follows the same `readJson`/`AuthClientError`
// pattern as `src/lib/sync/*-read.ts` so callers can `instanceof`-narrow on
// the error and surface the server's response body verbatim.

import { setJwt, getJwt, clearJwt } from "./cookie"

export { setJwt, getJwt, clearJwt, COOKIE_NAME } from "./cookie"
export { deriveCookieDomain } from "./cookie"

// ---------------------------------------------------------------------------
// Base URL resolution
// ---------------------------------------------------------------------------

// Vite-style env access. `import.meta.env` is undefined under Node/vitest
// happy-dom unless someone stubs it; treat the lookup as best-effort and
// fall back to the prod auth-worker.
//
// `||` (not `??`) so empty-string values fall back too — matches the
// existing src/lib/frontier/auth.ts convention so tests can pass `""` to
// simulate "unset".
function readBase(): string {
  // import.meta.env is the Vite shape; tests may stub it on the module.
  const meta = (import.meta as { env?: Record<string, string | undefined> })
    .env
  const base = meta?.VITE_AUTH_BASE
  const trimmed = base ? base.replace(/\/+$/, "") : ""
  return (
    trimmed ||
    "https://aquilla-frontier-server.blue-darkness-7674.workers.dev"
  )
}

export const AUTH_BASE = readBase()

// ---------------------------------------------------------------------------
// Errors + helpers
// ---------------------------------------------------------------------------

export class AuthClientError extends Error {
  status: number
  body: string
  /** Parsed JSON body if the response was JSON; null otherwise. */
  detail: { detail?: string; error?: string; message?: string } | null

  constructor(
    status: number,
    body: string,
    detail: { detail?: string; error?: string; message?: string } | null,
  ) {
    const friendly =
      detail?.detail ||
      detail?.error ||
      detail?.message ||
      `auth-client failed: HTTP ${status}`
    super(friendly)
    this.name = "AuthClientError"
    this.status = status
    this.body = body
    this.detail = detail
  }
}

async function readJson<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = await res.text().catch(() => "")
    let detail: AuthClientError["detail"] = null
    try {
      detail = body ? (JSON.parse(body) as typeof detail) : null
    } catch {
      detail = null
    }
    throw new AuthClientError(res.status, body, detail)
  }
  return (await res.json()) as T
}

interface AuthResponse {
  access_token: string
  token_type: string
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface LoginArgs {
  /** Server accepts either username or email in this field. */
  usernameOrEmail: string
  password: string
}

export interface LoginResult {
  jwt: string
  username: string
}

/**
 * POST /api/v2/auth/token. On success, also writes the JWT to the parent-
 * domain cookie so other apps on the same parent domain can read it.
 */
export async function login(
  args: LoginArgs,
  base: string = AUTH_BASE,
): Promise<LoginResult> {
  const res = await fetch(`${base}/api/v2/auth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      username: args.usernameOrEmail,
      password: args.password,
    }),
  })
  const data = await readJson<AuthResponse>(res)
  setJwt(data.access_token)
  return { jwt: data.access_token, username: args.usernameOrEmail }
}

export interface SignupArgs {
  username: string
  email: string
  password: string
}

export interface SignupResult {
  jwt: string
  username: string
}

/**
 * POST /api/v2/auth/register. The legacy `displayName` notion isn't
 * supported by the auth-worker today — we surface `username` + `email` and
 * leave display-name fields for a future settings flow.
 */
export async function signup(
  args: SignupArgs,
  base: string = AUTH_BASE,
): Promise<SignupResult> {
  const res = await fetch(`${base}/api/v2/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(args),
  })
  const data = await readJson<AuthResponse>(res)
  setJwt(data.access_token)
  return { jwt: data.access_token, username: args.username }
}

/**
 * POST /api/v2/auth/password-reset/request. The server intentionally
 * always returns 200 (never discloses whether the email is registered);
 * we resolve to void on any 2xx.
 */
export async function requestPasswordReset(
  email: string,
  base: string = AUTH_BASE,
): Promise<void> {
  const res = await fetch(`${base}/api/v2/auth/password-reset/request`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email }),
  })
  await readJson<{ message: string }>(res)
}

export interface SubmitPasswordResetArgs {
  token: string
  /**
   * The username the token is bound to. Reset links carry both `token` and
   * `username` query params (see auth-worker `/password-reset/request`),
   * and the server enforces the binding.
   */
  username: string
  newPassword: string
}

/**
 * POST /api/v2/auth/password-reset/reset. Note: the auth-worker route is
 * literally `/reset`, not `/submit` — the spec's "submit" name is mapped
 * here to keep callers reading nicely.
 */
export async function submitPasswordReset(
  args: SubmitPasswordResetArgs,
  base: string = AUTH_BASE,
): Promise<void> {
  const res = await fetch(`${base}/api/v2/auth/password-reset/reset`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      token: args.token,
      username: args.username,
      new_password: args.newPassword,
    }),
  })
  await readJson<{ message: string }>(res)
}

/**
 * POST /api/v2/auth/password-reset/verify. Returns true if the reset
 * token is still valid; false on any 4xx. Lets the reset app surface
 * "this link is expired" before showing the password form.
 */
export async function verifyPasswordResetToken(
  args: { token: string; username: string },
  base: string = AUTH_BASE,
): Promise<boolean> {
  const res = await fetch(`${base}/api/v2/auth/password-reset/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(args),
  })
  if (res.ok) return true
  if (res.status >= 400 && res.status < 500) return false
  // 5xx → real error; surface it.
  const body = await res.text().catch(() => "")
  throw new AuthClientError(res.status, body, null)
}

/**
 * Clears the JWT cookie. Apps that need to fully drop server-side state
 * should additionally call any per-app cleanup; this function is the
 * minimum "user is no longer authenticated in this browser" surface.
 */
export function logout(): void {
  clearJwt()
}

/**
 * Best-effort accessor for the current JWT (cookie read).
 */
export function currentJwt(): string | null {
  return getJwt()
}

/**
 * Hard-navigate the browser to the login app, preserving the current URL
 * as the post-login `next` target. Apps call this when they detect a
 * missing JWT — login lives in a different Worker so we can't use
 * react-router's <Navigate />. Trailing slash on `/login/` is required:
 * Workers Routes claims `aquilla.app/login/*`, which doesn't match the
 * bare `/login`. Without the slash, the bare path falls through to
 * Pages and renders the wrong app.
 */
export function redirectToLogin(): void {
  if (typeof window === "undefined") return
  const next = encodeURIComponent(
    window.location.pathname + window.location.search,
  )
  window.location.replace(`/login/?next=${next}`)
}

/**
 * Self-healing 401 handler. Apps wrap their api-client calls so that any
 * 401 — `Invalid or expired token`, `User not found`, etc. — clears the
 * stale JWT cookie and bounces to the login app. Without this, a server
 * SECRET_KEY rotation (or any signature mismatch) leaves users stuck on
 * a blank page with no recovery path.
 *
 * Idempotent in practice: multiple parallel 401s call clearJwt() →
 * redirectToLogin(); the second redirect is a no-op once `replace`
 * lands.
 */
export function handleAuthExpiredAndRedirect(): void {
  clearJwt()
  redirectToLogin()
}

/**
 * Convenience wrapper: invokes `fn`, and if it throws an error whose
 * `status` is 401 (matches the `*ReadError` pattern used by
 * @aquilla/api-client), self-heals and rethrows so the caller can break
 * out of the current effect. Other errors pass through unchanged.
 */
export async function withAuthRetry<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (err) {
    if (err && typeof err === "object" && (err as { status?: unknown }).status === 401) {
      handleAuthExpiredAndRedirect()
    }
    throw err
  }
}
