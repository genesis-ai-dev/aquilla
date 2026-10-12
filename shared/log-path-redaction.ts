// Redact bearer credentials out of URL paths before they reach a log sink.
//
// [Pen test] Auth & session mgmt (2026-10-05, OPS-42). Eight API routes carry a
// live credential (D5) as a *path segment* rather than in a header or body:
// project and org invite tokens, and AQU-626 project access-link tokens. Both
// workers copy `url.pathname` verbatim into two sinks:
//
//   1. `shipErrorResponse` — every 4xx/5xx, shipped to PostHog Logs, a third
//      party (`POSTHOG_KEY` is blank in prod today, so this one is armed by a
//      config edit, not live).
//   2. `console.warn("[slow-request] …")` — any request over 5s, INCLUDING
//      successful ones, retained in Cloudflare Workers Logs ([observability]
//      enabled = true in every env).
//
// The 4xx cases are the ordinary ones, not the exotic ones: a mistyped PIN on
// `/access-links/:token/redeem` 401s while the link itself is still live, and a
// lapsed session on `/invites/:token/accept` 401s in authMiddleware before the
// route ever looks at the invite. Invite tokens are the one credential class
// still stored in plaintext (OPS-26), so a logged one is a working project
// grant at its stated role, not a hash of one.
//
// This is OPS-29's finding (2026-09-14) on the server side: that pass redacted
// credential-bearing URLs on their way out of the *browser* to PostHog and left
// the workers' own shipping alone.
//
// Shape list, not entropy heuristics: project ids are UUIDs and are wanted in
// logs, so "looks random" cannot be the test. `shared/log-path-redaction.test.ts`
// carries a drift guard that re-derives the mounted path of every route whose
// path declares a credential-ish parameter and fails if one is not covered here.

/** One route shape whose path carries a credential, and how to blank it. */
export interface CredentialPathShape {
  /** Human label, used in test failures. */
  readonly name: string
  readonly pattern: RegExp
  /** `String.replace` template; keeps the non-secret segments intact. */
  readonly replacement: string
}

/** Parameter names that denote a bearer credential in a route path. The drift
 *  guard requires every route declaring one of these to be covered below. */
export const CREDENTIAL_PARAM_NAMES: readonly string[] = [
  "token",
  "inviteToken",
  "linkToken",
  "code",
  "secret",
  "pin",
]

/** What a redacted segment reads as in a log line. */
export const REDACTED_SEGMENT = ":token"

/** Both workers are also mounted under a path prefix on `api.*.aquilla.app`
 *  (`/identity`, `/sync`). The prefix is stripped before routing, so a logged
 *  path normally arrives bare — tolerate both rather than depend on that. */
const MOUNT = "(?:/identity|/sync)?"

export const CREDENTIAL_PATH_SHAPES: readonly CredentialPathShape[] = [
  {
    // GET /api/v2/invites/:token/preview, POST /api/v2/invites/:token/accept
    name: "project invite token",
    pattern: new RegExp(`^(${MOUNT}/api/v[12]/invites/)[^/]+(/(?:preview|accept))$`),
    replacement: `$1${REDACTED_SEGMENT}$2`,
  },
  {
    // POST /api/v2/access-links/:token/redeem, .../revoke
    name: "project access-link token",
    pattern: new RegExp(`^(${MOUNT}/api/v[12]/access-links/)[^/]+(/(?:redeem|revoke))$`),
    replacement: `$1${REDACTED_SEGMENT}$2`,
  },
  {
    // GET /api/v2/orgs/invite-preview/:token, /api/v2/projects/invite-preview/:token
    name: "invite-preview token",
    pattern: new RegExp(`^(${MOUNT}/api/v[12]/(?:orgs|projects)/invite-preview/)[^/]+$`),
    replacement: `$1${REDACTED_SEGMENT}`,
  },
  {
    // DELETE /api/v2/orgs/:orgId/invites/:token,
    // DELETE /api/v2/projects/:projectId/invites/:token
    name: "invite-revoke token",
    pattern: new RegExp(`^(${MOUNT}/api/v[12]/(?:orgs|projects)/[^/]+/invites/)[^/]+$`),
    replacement: `$1${REDACTED_SEGMENT}`,
  },
]

/**
 * Blank any credential segment in `pathname`. Paths that carry no credential
 * come back byte-identical — the point of logging a path at all is to know
 * which route failed, and every non-secret segment (org id, project id) is
 * kept so that stays true.
 *
 * Takes a pathname, never a full URL: a query string can carry a credential
 * too (`routes/monday.ts`'s OAuth `?code=`), and nothing here is a licence to
 * start logging one. The test file pins that.
 */
export function redactLogPath(pathname: string): string {
  for (const shape of CREDENTIAL_PATH_SHAPES) {
    const redacted = pathname.replace(shape.pattern, shape.replacement)
    if (redacted !== pathname) return redacted
  }
  return pathname
}
