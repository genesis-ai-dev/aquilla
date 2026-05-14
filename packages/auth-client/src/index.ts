// @aquilla/auth-client — parent-domain JWT cookie reader.
//
// CONTRACT (AD-11 navigation handoff): the auth JWT lives in a cookie
// scoped to the parent domain so every discrete app under aquilla.app
// reads the same value. The login app (apps/login/) is the only writer.
//
// COOKIE ASSUMPTIONS:
//   - cookie name:    aquilla_jwt
//   - prod domain:    .aquilla.app
//   - staging domain: .dev.aquilla.app
//   - preview domain: .pr-<N>.aquilla.app  (set by the per-PR auth-worker)
//   - dev localhost:  no cookie writeable (no parent-domain on `localhost`);
//                     login app writes localStorage['aquilla:dev-jwt'] instead.
//
// NOTE (Phase 3c): this is a pre-3b minimal stub so the projects/billing/org
// apps can compile and run. 3b's auth-client PR replaces this with the full
// implementation (login/logout side, refresh-token handling, useFrontierSession
// hook, etc). Keep the signature surface stable so the swap doesn't break
// every consumer; in particular: `getJwt(): string | null` and
// `decodeUsername(jwt): string | null` are the load-bearing exports.

const COOKIE_NAME = "aquilla_jwt"
const DEV_LOCALSTORAGE_KEY = "aquilla:dev-jwt"

function readCookie(name: string): string | null {
  if (typeof document === "undefined") return null
  const prefix = `${name}=`
  for (const raw of document.cookie.split(";")) {
    const trimmed = raw.trim()
    if (trimmed.startsWith(prefix)) {
      return decodeURIComponent(trimmed.slice(prefix.length))
    }
  }
  return null
}

function readDevJwt(): string | null {
  if (typeof window === "undefined") return null
  try {
    return window.localStorage.getItem(DEV_LOCALSTORAGE_KEY)
  } catch {
    return null
  }
}

/** Return the current JWT or null. Reads cookie first, falls back to the
 *  dev-localStorage key for localhost. Apps must accept null and route to
 *  /login/?return=<current-url>. */
export function getJwt(): string | null {
  return readCookie(COOKIE_NAME) ?? readDevJwt()
}

/** Decode the username claim (no signature verification — UI only). */
export function decodeUsername(jwt: string): string | null {
  try {
    const payload = jwt.split(".")[1]
    if (!payload) return null
    const padded = payload.padEnd(payload.length + ((4 - (payload.length % 4)) % 4), "=")
    const json = JSON.parse(atob(padded.replace(/-/g, "+").replace(/_/g, "/")))
    return typeof json.username === "string" ? json.username : null
  } catch {
    return null
  }
}

/** Bounce to apps/login/ with a return URL so the user lands back here. */
export function redirectToLogin(): void {
  if (typeof window === "undefined") return
  const here = window.location.href
  window.location.assign(`/login/?return=${encodeURIComponent(here)}`)
}

/** A minimal "session" shape — mirrors `useFrontierSession()` from
 *  src/hooks/useFrontierSession.ts so consumer code can be ported with a
 *  one-line import swap. */
export interface FrontierSession {
  jwt: string
  username: string | null
}

/** Read-once accessor. Apps that need reactivity should poll on mount or
 *  rely on the full hook in @aquilla/auth-client once 3b lands. */
export function getSession(): FrontierSession | null {
  const jwt = getJwt()
  if (!jwt) return null
  return { jwt, username: decodeUsername(jwt) }
}
