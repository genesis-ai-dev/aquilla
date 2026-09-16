/**
 * AQU-995: sliding session refresh on the client.
 *
 * Access tokens carry a fixed 30-day lifetime and the app never looked at
 * `exp` before deciding to fire a request. The result was a session that died
 * on a silent timer no matter how actively it was being used: someone
 * translating every day still got dropped exactly 30 days after logging in,
 * mid-edit, with their outbox unable to flush until they re-authenticated.
 *
 * This rolls the stored credential forward *before* it lapses. Combined with
 * the server's half-life gate (POST /api/v2/auth/refresh), an active client
 * stays signed in indefinitely while an idle one still ages out normally —
 * and stale tabs stop retry-looping with a dead token, which is where the
 * chronic 401 volume in the identity logs comes from.
 *
 * Deliberately quiet: every failure path leaves the stored session untouched
 * and returns false. A refresh that doesn't happen costs nothing (the token is
 * still valid — that's the precondition for trying), so there is never a
 * reason to surface an error or evict the user from here. A genuinely dead
 * session is still caught where it always was: the fetch-layer 401 → banner
 * path (lib/errors/session-expired-signal) and the boot gate
 * (components/ExpiredSessionGate).
 */

import { AUTH_BASE } from "./auth"
import { loadActiveSession, saveSession } from "./session-store"

/** `iat`/`exp`, in seconds, from a JWT's unverified payload. */
interface JwtLifetime {
  iat: number
  exp: number
}

/**
 * Read `iat`/`exp` without verifying the signature — this only ever decides
 * *when to ask the server*, never whether to trust the token. Returns null
 * whenever the answer isn't knowable, so callers stay on the do-nothing path.
 */
export function jwtLifetime(token: string | null | undefined): JwtLifetime | null {
  if (!token) return null
  try {
    const parts = token.split(".")
    if (parts.length !== 3) return null
    // atob requires standard base64; JWT uses base64url — swap - and _
    const padded = parts[1].replace(/-/g, "+").replace(/_/g, "/")
    const payload = JSON.parse(atob(padded)) as { iat?: unknown; exp?: unknown }
    if (typeof payload.iat !== "number" || typeof payload.exp !== "number") return null
    return { iat: payload.iat, exp: payload.exp }
  } catch {
    return null
  }
}

/**
 * True when `token` is past the half-way point of its lifetime but has not yet
 * lapsed — the window in which a refresh both is worth doing and can still be
 * authenticated.
 *
 * The half-life threshold matches the server's gate, so a client that asks
 * early is a no-op rather than a wasted mint. Past `exp` we deliberately stop
 * asking: the request would 401, and hammering it is the exact log noise this
 * change exists to remove.
 */
export function shouldRefreshJwt(
  token: string | null | undefined,
  nowMs: number = Date.now(),
): boolean {
  const life = jwtLifetime(token)
  if (!life) return false
  const nowSeconds = nowMs / 1000
  if (nowSeconds >= life.exp) return false
  const lifetime = life.exp - life.iat
  if (lifetime <= 0) return false
  return nowSeconds - life.iat >= lifetime / 2
}

/**
 * In-flight de-dupe. Mount-time, focus and interval triggers can all land at
 * once (a tab restored from background fires visibilitychange and the interval
 * together); without this they'd each mint a separate token and the last write
 * would win, orphaning the others.
 */
let inFlight: Promise<boolean> | null = null

/**
 * Refresh the active session's JWT if it's due. Resolves true when the stored
 * credential was replaced, false in every other case (nothing stored, not due
 * yet, server declined, offline, session changed underneath us).
 *
 * Never rejects — callers fire-and-forget this from effects.
 */
export function refreshActiveSession(): Promise<boolean> {
  inFlight ??= runRefresh().finally(() => {
    inFlight = null
  })
  return inFlight
}

async function runRefresh(): Promise<boolean> {
  let session
  try {
    session = await loadActiveSession()
  } catch {
    return false
  }
  if (!session?.jwt || !shouldRefreshJwt(session.jwt)) return false
  const previousJwt = session.jwt

  let nextJwt: string
  try {
    const res = await fetch(`${AUTH_BASE}/api/v2/auth/refresh`, {
      method: "POST",
      headers: { Authorization: `Bearer ${previousJwt}` },
    })
    if (!res.ok) return false
    const body = (await res.json()) as { access_token?: unknown }
    if (typeof body.access_token !== "string" || body.access_token.length === 0) {
      return false
    }
    nextJwt = body.access_token
  } catch {
    // Offline or the request was cut short. The current token is still valid —
    // that was the precondition for getting here — so there is nothing to do
    // but try again on the next trigger.
    return false
  }

  // Below the server's half-life gate the endpoint echoes the same token back.
  if (nextJwt === previousJwt) return false

  // Re-read before writing. The user may have logged out, switched accounts or
  // re-authenticated while the request was in flight; writing blind would
  // resurrect a session they just left, or clobber a newer credential with a
  // token minted from the older one.
  try {
    const current = await loadActiveSession()
    if (current?.jwt !== previousJwt) return false
    await saveSession({ ...current, jwt: nextJwt })
  } catch {
    return false
  }
  return true
}
