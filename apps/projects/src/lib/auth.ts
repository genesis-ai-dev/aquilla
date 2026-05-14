// Parent-domain JWT cookie reader.
//
// Per AD-11 navigation-handoff contract: the auth JWT lives in a cookie
// scoped to the parent domain (aquilla.app), HttpOnly+Secure+SameSite=Lax.
// The login app is the only writer; every other discrete app is a reader.
//
// This module exists as a *local* shim until 3b populates
// `packages/auth-client/`. Once that lands, this file becomes a
// re-export wrapper:
//
//   export { getJwt, useFrontierSession } from "@aquilla/auth-client"
//
// Cookie name + domain assumptions:
//   - cookie name: `aquilla_jwt`
//   - prod domain:    .aquilla.app
//   - staging domain: .dev.aquilla.app
//   - preview domain: .pr-<N>.aquilla.app  (set by the PR auth-worker)
//   - dev (localhost): no cookie; the JWT is read out of localStorage
//     under `aquilla:dev-jwt` instead. The login app writes that key.

const COOKIE_NAME = "aquilla_jwt"
const DEV_LOCALSTORAGE_KEY = "aquilla:dev-jwt"

function readCookie(name: string): string | null {
  if (typeof document === "undefined") return null
  const prefix = `${name}=`
  const parts = document.cookie.split(";")
  for (const raw of parts) {
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

/** Return the current JWT or null. Reads cookie first, falls back to dev
 *  localStorage for the localhost case (no cross-app cookie domain). */
export function getJwt(): string | null {
  return readCookie(COOKIE_NAME) ?? readDevJwt()
}

/** Decode the username field from a JWT without verifying the signature.
 *  Used for header/avatar UI only; never for authz decisions. */
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

/** Bounce to the login app with `?return=<current-url>`. */
export function redirectToLogin(): void {
  if (typeof window === "undefined") return
  const here = window.location.href
  window.location.assign(`/login/?return=${encodeURIComponent(here)}`)
}
