// Parent-domain cookie reader/writer for the JWT (AD-11 navigation handoff).
//
// Per spec §"Navigation handoff contract":
//   > JWT lives in a cookie scoped to the parent domain (HttpOnly, Secure,
//   > SameSite=Lax). The auth app is the only writer; every other app is a
//   > reader.
//
// We can't actually set HttpOnly from client-side JS — Set-Cookie via
// document.cookie is necessarily JS-readable. The intended end state is for
// the auth-worker itself to return a Set-Cookie header with HttpOnly; until
// the worker grows that surface (tracked under 3e + identity rework), the
// apps/login/ app writes the cookie client-side so the SPA can keep using
// it for fetch Authorization headers. That tradeoff is recorded here so the
// next pass doesn't re-derive it.
//
// Cookie name fixed at `aquilla_jwt`. Domain attribute is derived from the
// current hostname so the same code works on:
//   localhost                         → no domain attr  (host-only cookie)
//   pr-123.aquilla.app               → .aquilla.app
//   dev.aquilla.app                  → .aquilla.app
//   aquilla.app                      → .aquilla.app
//   foo.aquilla-web-4ih.pages.dev      → .aquilla-web-4ih.pages.dev
//
// The derivation is purely string-shape; it does not consult the public
// suffix list (we don't ship one to the browser). The convention works for
// every aquilla.app subdomain plus *.pages.dev under our project.

export const COOKIE_NAME = "aquilla_jwt"

// 30 days; matches the JWT TTL we issue for SPA sessions today. The cookie
// outlives a single tab close but not an OS lifetime.
const DEFAULT_MAX_AGE_SECONDS = 60 * 60 * 24 * 30
const STALE_COOKIE_PATHS = [
  "/",
  "/login/",
  "/projects/",
  "/signup/",
  "/reset/",
  "/w/",
  "/org/",
  "/billing/",
  "/import/",
  "/export/",
  "/migrate/",
]

/**
 * Pure function: given a hostname (e.g. "pr-7.aquilla.app"), return the
 * cookie-domain attribute we should set (e.g. ".aquilla.app") or null for
 * host-only cookies (localhost, raw IPs, single-label hostnames).
 *
 * Exported so callers in tests can exercise it without touching
 * document.cookie.
 */
export function deriveCookieDomain(hostname: string): string | null {
  if (!hostname) return null
  // IPv4 dotted-quad: every label is digits.
  if (/^\d+\.\d+\.\d+\.\d+$/.test(hostname)) return null
  // localhost or bare label — host-only cookie.
  const parts = hostname.split(".")
  if (parts.length < 2) return null
  if (hostname === "localhost") return null
  // pages.dev project hosts have three labels (<project>.pages.dev). Keep
  // them at the project level so previews of the same project share the
  // cookie.
  if (hostname.endsWith(".pages.dev")) {
    // <subdomain>.<project>.pages.dev → .<project>.pages.dev
    if (parts.length >= 3) {
      return "." + parts.slice(-3).join(".")
    }
    return "." + hostname
  }
  // Default: drop the leftmost label if the hostname has 3+ parts (treat as
  // subdomain). Otherwise use the bare 2-label hostname.
  if (parts.length >= 3) {
    return "." + parts.slice(1).join(".")
  }
  return "." + hostname
}

interface SetJwtOptions {
  /** Override `window.location.hostname`; primarily used by tests. */
  hostname?: string
  /** Override the document target; primarily used by tests. */
  doc?: { cookie: string }
  /** Override the cookie TTL in seconds. */
  maxAgeSeconds?: number
  /** Force `Secure` on/off. Defaults to: on whenever location.protocol === "https:". */
  secure?: boolean
}

/**
 * Writes the JWT cookie. Called by `login()` / `signup()` after a successful
 * response. Idempotent — calling twice just refreshes the cookie.
 *
 * Before writing, also wipes any host-only `aquilla_jwt` cookie that might
 * be left over from a previous login. Without this, the host-only cookie
 * sticks around alongside the new parent-domain one and can be returned
 * by getJwt() instead of the fresh JWT — causing the dreaded sign-in /
 * sign-out loop.
 */
export function setJwt(jwt: string, opts: SetJwtOptions = {}): void {
  if (typeof document === "undefined" && !opts.doc) {
    throw new Error("setJwt: no document available")
  }
  const doc = opts.doc ?? document
  const hostname =
    opts.hostname ??
    (typeof window !== "undefined" ? window.location.hostname : "")
  const domain = deriveCookieDomain(hostname)
  const maxAge = opts.maxAgeSeconds ?? DEFAULT_MAX_AGE_SECONDS
  const secure =
    opts.secure ??
    (typeof window !== "undefined" && window.location.protocol === "https:")

  // Wipe stale duplicates first. Browsers keep one cookie per (name,
  // Domain, Path) tuple, so a previous login could have left several
  // `aquilla_jwt` cookies under different shapes that all coexist
  // with whatever we write below — and getJwt() can return any of
  // them on the next read.
  //
  // Cover the variants we've seen in the wild: host-only at /, the
  // parent-domain at /, and path-scoped variants on the per-app
  // mounts. HttpOnly cookies set by a previous server are unreachable
  // from JS — those have to be cleared by the server explicitly (no
  // single API for that today).
  for (const p of STALE_COOKIE_PATHS) {
    // Host-only.
    doc.cookie = [
      `${COOKIE_NAME}=`,
      `Path=${p}`,
      "Max-Age=0",
      "SameSite=Lax",
    ].join("; ")
    // Parent-domain.
    if (domain) {
      doc.cookie = [
        `${COOKIE_NAME}=`,
        `Path=${p}`,
        "Max-Age=0",
        "SameSite=Lax",
        `Domain=${domain}`,
      ].join("; ")
    }
  }

  const parts: string[] = [
    `${COOKIE_NAME}=${encodeURIComponent(jwt)}`,
    "Path=/",
    `Max-Age=${maxAge}`,
    "SameSite=Lax",
  ]
  if (domain) parts.push(`Domain=${domain}`)
  if (secure) parts.push("Secure")
  doc.cookie = parts.join("; ")
}

interface GetJwtOptions {
  /** Override the document target; primarily used by tests. */
  doc?: { cookie: string }
}

/**
 * Reads the current JWT cookie or null if missing/empty.
 *
 * If multiple cookies share the same name, pick the JWT with the newest
 * `iat` claim. Browsers can keep separate cookies for the same name across
 * Domain/Path variants, and `document.cookie` does not expose which variant
 * each value came from. Using `iat` keeps the latest successful login from
 * losing to a previous path-scoped cookie.
 */
export function getJwt(opts: GetJwtOptions = {}): string | null {
  if (typeof document === "undefined" && !opts.doc) return null
  const doc = opts.doc ?? document
  const raw = doc.cookie || ""
  let best: string | null = null
  let bestIssuedAt = Number.NEGATIVE_INFINITY
  for (const segment of raw.split(";")) {
    const eq = segment.indexOf("=")
    if (eq < 0) continue
    const key = segment.slice(0, eq).trim()
    if (key !== COOKIE_NAME) continue
    const valueRaw = segment.slice(eq + 1).trim()
    if (!valueRaw) continue
    let value: string
    try {
      value = decodeURIComponent(valueRaw)
    } catch {
      value = valueRaw
    }
    const issuedAt = jwtIssuedAt(value)
    if (
      best === null ||
      issuedAt > bestIssuedAt ||
      (issuedAt === bestIssuedAt && value.length > best.length)
    ) {
      best = value
      bestIssuedAt = issuedAt
    }
  }
  return best
}

function jwtIssuedAt(jwt: string): number {
  const payload = decodeJwtPayload(jwt)
  const iat = payload?.iat
  return typeof iat === "number" && Number.isFinite(iat)
    ? iat
    : Number.NEGATIVE_INFINITY
}

function decodeJwtPayload(jwt: string): Record<string, unknown> | null {
  const payload = jwt.split(".")[1]
  if (!payload) return null
  try {
    const base64 = payload.replace(/-/g, "+").replace(/_/g, "/")
    const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), "=")
    const decoded = atob(padded)
    const parsed = JSON.parse(decoded) as unknown
    return parsed && typeof parsed === "object"
      ? parsed as Record<string, unknown>
      : null
  } catch {
    return null
  }
}

interface ClearJwtOptions {
  hostname?: string
  doc?: { cookie: string }
}

/**
 * Clears the JWT cookie — issues a Set-Cookie at every (Path, Domain)
 * shape we've seen in the wild. Browsers keep one cookie per
 * (name, Domain, Path) tuple, and the previous implementation only cleared one of them.
 */
export function clearJwt(opts: ClearJwtOptions = {}): void {
  if (typeof document === "undefined" && !opts.doc) return
  const doc = opts.doc ?? document
  const hostname =
    opts.hostname ??
    (typeof window !== "undefined" ? window.location.hostname : "")
  const domain = deriveCookieDomain(hostname)

  for (const p of STALE_COOKIE_PATHS) {
    doc.cookie = [
      `${COOKIE_NAME}=`,
      `Path=${p}`,
      "Max-Age=0",
      "SameSite=Lax",
    ].join("; ")
    if (domain) {
      doc.cookie = [
        `${COOKIE_NAME}=`,
        `Path=${p}`,
        "Max-Age=0",
        "SameSite=Lax",
        `Domain=${domain}`,
      ].join("; ")
    }
  }
}
