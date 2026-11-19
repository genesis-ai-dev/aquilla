import { parseDesktopGoogleCallback } from "../../../shared/desktop-google"
import { ANALYTICS_DISCLOSURE_VERSION } from "../../../shared/analytics-consent"
import { AUTH_BASE } from "./auth"
import { isTauriRuntime } from "../offline/is-tauri"
import { safeLoginNext } from "../navigation/login-path"
import { readSignupAnalyticsChoice, type SignupAnalyticsChoice } from "../signup-analytics-choice"
const KEY = `aquilla:google-login:${AUTH_BASE}`
export const GOOGLE_ATTEMPT_LIFETIME_MS = 10 * 60_000
export interface GoogleAttempt { verifier: string; next: string; expires: number; choice: SignupAnalyticsChoice | null; desktopChallenge?: string; desktopReturned?: boolean; connectUsername?: string; emailChange?: boolean; pending?: GooglePending; connectCode?: string }
export interface GooglePending { continuation: string; step: "signup" | "link" | "legacy"; email: string; username?: string }
export interface GoogleSession { access_token: string; token_type: string; username: string; created: boolean }
export async function googleRequest<T>(path: string, body?: object, jwt?: string): Promise<T> {
  let response: Response
  try { response = await fetch(`${AUTH_BASE}/api/v2/auth/oauth/google/${path}`, {
    method: body ? "POST" : "GET", credentials: "omit", cache: "no-store", signal: AbortSignal.timeout(20_000),
    headers: { ...(body ? { "Content-Type": "application/json" } : {}), ...(jwt ? { Authorization: `Bearer ${jwt}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  } catch (error) {
    if (path === "start") throw new Error(error instanceof Error && error.name === "TimeoutError" ? "timeout" : "network_error", { cause: error })
    throw new Error("unavailable", { cause: error })
  }
  // Only this read endpoint's 401 unambiguously means the session is invalid.
  // Link/disconnect can also return 401 for an incorrect password proof.
  if (path === "methods" && jwt && response.status === 401) throw new Error("session_expired")
  // Gateways may return HTML, so classify HTTP failures before parsing JSON.
  if (path === "start" && response.status === 429) throw new Error("rate_limited")
  if (path === "start" && response.status >= 500) throw new Error("service_unavailable")
  let data
  try { data = await response.json() } catch { throw new Error("unavailable") }
  if (!data || typeof data !== "object") throw new Error("unavailable")
  if (!response.ok) throw new Error(data.code === "dev_access_restricted" ? data.code : typeof data.error === "string" ? data.error : "unavailable")
  return data as T
}
export async function startGoogleLogin(next: string, signup: boolean, connectUsername?: string, emailChange = false, signal?: AbortSignal, privateSession = false): Promise<void> {
  const desktop = isTauriRuntime()
  if (desktop) {
    const { invoke } = await import("@tauri-apps/api/core")
    if (!await invoke<boolean>("google_login_supported").catch(() => false)) throw new Error("desktop_unsupported")
  }
  if (!navigator.onLine) throw new Error("offline")
  const verifier = Array.from(crypto.getRandomValues(new Uint8Array(32)), b => b.toString(16).padStart(2, "0")).join("")
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)))
  const challenge = btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
  if (signal?.aborted) return
  // Storage must survive the redirect. If unavailable, stay here without ever
  // contacting Google; password login remains usable.
  const attempt: GoogleAttempt = { ...(desktop ? { desktopChallenge: challenge } : {}), verifier, next: safeLoginNext(next), expires: Date.now() + GOOGLE_ATTEMPT_LIFETIME_MS, choice: signup ? readSignupAnalyticsChoice() : null, ...(connectUsername ? { connectUsername, emailChange } : {}) }
  try { sessionStorage.setItem(KEY, JSON.stringify(attempt)) }
  catch { throw new Error("storage_unavailable") }
  if (desktop) signal?.addEventListener("abort", () => {
    const current = readGoogleAttempt()
    if (current?.verifier === verifier && !current.desktopReturned) clearGoogleAttempt()
  }, { once: true })
  const result = await googleRequest<{ authorization_url: string; desktop?: boolean }>("start", { challenge, ...(desktop ? { desktop: true } : {}) })
  if (signal?.aborted) return
  if (desktop && result.desktop !== true) { clearGoogleAttempt(); throw new Error("desktop_unsupported") }
  const url = new URL(result.authorization_url)
  if (url.origin !== "https://accounts.google.com" || url.pathname !== "/o/oauth2/v2/auth") throw new Error("invalid_request")
  if (desktop) {
    // Cancellation/replacement while the request was in flight must not open a
    // browser for an obsolete attempt.
    if (signal?.aborted || readGoogleAttempt()?.verifier !== verifier) return
    try {
      const { invoke } = await import("@tauri-apps/api/core")
      if (signal?.aborted || readGoogleAttempt()?.verifier !== verifier) return
      const cancel = () => { void invoke("cancel_auth_browser", { attempt: challenge }).catch(() => {}) }
      signal?.addEventListener("abort", cancel, { once: true })
      try { await invoke("open_auth_browser", { authUrl: url.href, attempt: challenge, privateSession }) }
      finally { signal?.removeEventListener("abort", cancel) }
    } catch (cause) { if (readGoogleAttempt()?.verifier === verifier) clearGoogleAttempt(); throw new Error(cause === "cancelled" ? "cancelled" : "browser_open_failed", { cause }) }
  } else window.location.assign(url.href)
}
export function readGoogleAttempt(): GoogleAttempt | null {
  try {
    const value = JSON.parse(sessionStorage.getItem(KEY) ?? "null") as GoogleAttempt | null
    if (!value || !/^[a-f0-9]{64}$/.test(value.verifier) || !Number.isFinite(value.expires) || value.expires <= Date.now()) { clearGoogleAttempt(); return null }
    if (value.pending && (!/^[a-f0-9]{64}$/.test(value.pending.continuation) || !["signup","link","legacy"].includes(value.pending.step) || typeof value.pending.email !== "string")) { clearGoogleAttempt(); return null }
    if (value.connectCode && !/^[a-f0-9]{64}$/.test(value.connectCode)) { clearGoogleAttempt(); return null }
    const choice = value.choice?.version === ANALYTICS_DISCLOSURE_VERSION && typeof value.choice.allowed === "boolean" && typeof value.choice.revision === "string" ? value.choice : null
    return { ...value, choice, next: safeLoginNext(value.next) }
  } catch { return null }
}
export function clearGoogleAttempt(): void { try { sessionStorage.removeItem(KEY) } catch { /* already unusable */ } }

/** Short-lived, tab-local continuation only. No password, JWT or provider token.
 * The server still enforces one-use redemption, PKCE and its own expiry. */
export function saveGoogleProgress(verifier: string, update: { pending?: GooglePending; choice?: SignupAnalyticsChoice | null; connectCode?: string }): void {
  const attempt = readGoogleAttempt()
  if (!attempt || attempt.verifier !== verifier) throw new Error("expired_request")
  sessionStorage.setItem(KEY, JSON.stringify({ ...attempt, ...update, expires: Math.min(attempt.expires, Date.now() + 4 * 60_000) }))
}

/** Accept only a callback for this window's unexpired native attempt. Codes
 * remain PKCE-bound server-side; no JWTs or passwords enter through deep links. */
export function acceptDesktopGoogleReturn(value: string): URLSearchParams | null {
  if (!isTauriRuntime()) return null
  try {
    const result = parseDesktopGoogleCallback(value), attempt = readGoogleAttempt()
    if (!result || !attempt?.desktopChallenge || attempt.desktopReturned || result.state !== attempt.desktopChallenge) return null
    sessionStorage.setItem(KEY, JSON.stringify({ ...attempt, desktopReturned: true }))
    return new URLSearchParams(result.code ? { code: result.code } : { error: result.error! })
  } catch { return null }
}
