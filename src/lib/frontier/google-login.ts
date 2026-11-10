import { AUTH_BASE } from "./auth"
import { safeLoginNext } from "../navigation/login-path"
import { readSignupAnalyticsChoice, type SignupAnalyticsChoice } from "../signup-analytics-choice"
const KEY = `aquilla:google-login:${AUTH_BASE}`
export interface GoogleAttempt { verifier: string; next: string; expires: number; choice: SignupAnalyticsChoice | null }
export interface GooglePending { continuation: string; step: "signup" | "link"; email: string; username?: string }
export interface GoogleSession { access_token: string; token_type: string; username: string; created: boolean }
export async function googleRequest<T>(path: string, body?: object): Promise<T> {
  const response = await fetch(`${AUTH_BASE}/api/v2/auth/oauth/google/${path}`, {
    method: body ? "POST" : "GET", credentials: "omit", cache: "no-store", signal: AbortSignal.timeout(20_000),
    ...(body ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}),
  })
  const data = await response.json()
  if (!response.ok) throw new Error(data.code === "dev_access_restricted" ? data.code : typeof data.error === "string" ? data.error : "unavailable")
  return data as T
}
export async function startGoogleLogin(next: string, signup: boolean): Promise<void> {
  if (!navigator.onLine) throw new Error("offline")
  const verifier = Array.from(crypto.getRandomValues(new Uint8Array(32)), b => b.toString(16).padStart(2, "0")).join("")
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)))
  const challenge = btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
  // Storage must survive the redirect. If unavailable, stay here without ever
  // contacting Google; password login remains usable.
  const attempt: GoogleAttempt = { verifier, next: safeLoginNext(next), expires: Date.now() + 10 * 60_000, choice: signup ? readSignupAnalyticsChoice() : null }
  sessionStorage.setItem(KEY, JSON.stringify(attempt))
  const result = await googleRequest<{ authorization_url: string }>("start", { challenge })
  const url = new URL(result.authorization_url)
  if (url.origin !== "https://accounts.google.com" || url.pathname !== "/o/oauth2/v2/auth") throw new Error("invalid_request")
  window.location.assign(url.href)
}
export function readGoogleAttempt(): GoogleAttempt | null {
  try {
    const value = JSON.parse(sessionStorage.getItem(KEY) ?? "null") as GoogleAttempt | null
    return value && /^[a-f0-9]{64}$/.test(value.verifier) && value.expires > Date.now() ? { ...value, next: safeLoginNext(value.next) } : null
  } catch { return null }
}
export function clearGoogleAttempt(): void { try { sessionStorage.removeItem(KEY) } catch { /* already unusable */ } }
