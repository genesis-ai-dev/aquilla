// [Pen test] Auth & session mgmt (2026-07-20): throttling for the two
// unauthenticated auth endpoints that had none — POST /api/v2/auth/token
// (credential stuffing / password guessing) and POST
// /api/v2/auth/password-reset/request (email bombing a victim's inbox).
//
// Backed by auth_rate_limit_events (migration 0066) rather than a Cloudflare
// KV/DO binding: no new infra binding to provision across four wrangler
// environments, and the counts only need to be roughly right (a sliding
// window over a handful of minutes), which a plain indexed COUNT(*) handles
// fine at this traffic level. Revisit with a Durable Object or Cloudflare
// Rate Limiting rule if login volume ever makes the DB round-trip a problem.

const WINDOW_MINUTES = 15

// Failed logins allowed per identifier (lowercased username/email) and per
// IP inside the window before POST /token starts rejecting with 429. Wide
// enough that a real user fat-fingering their password repeatedly never
// hits it; tight enough to blunt automated guessing.
export const LOGIN_MAX_FAILURES_PER_IDENTIFIER = 8
export const LOGIN_MAX_FAILURES_PER_IP = 20

// Reset-request emails allowed per target address inside the window before
// POST /password-reset/request stops actually sending (it still returns the
// same 200 either way — see routes/auth.ts — so the throttle itself isn't
// observable to a caller probing for it).
export const RESET_REQUEST_MAX_PER_IDENTIFIER = 3

// Public "book a call" contact-form submissions allowed per IP inside the
// window before POST /api/v2/contact/book-call rejects with 429 — the endpoint
// is unauthenticated and sends email, so without this it's an inbox-bombing
// primitive (see routes/contact.ts).
export const CONTACT_MAX_PER_IP = 5

// [Pen test] Auth & session mgmt (2026-07-27): POST /api/v2/admin/elevation/verify
// had no attempt limiting at all — a caller already holding a valid (e.g.
// stolen) platform-admin JWT could brute-force the 6-digit step-up code with
// unlimited guesses inside its 10-minute lifetime. Scoped per-user (only an
// ADMIN_EMAILS-allowlisted account can reach this route in the first place),
// counting failures only so a legitimate admin retyping a code never locks
// themselves out.
export const ADMIN_ELEVATION_VERIFY_MAX_FAILURES = 10

// [Pen test] Auth & session mgmt (2026-07-27): POST /api/v2/auth/register had
// no throttle at all — scriptable account-creation flooding and, combined
// with the 409 "User already exists" response, a fast email/username
// enumeration oracle. Scoped per-IP rather than per-identifier (the whole
// point of the abuse is trying many identifiers), wide enough that a shared
// office/campus IP signing up several real accounts never trips it.
export const REGISTER_MAX_PER_IP = 15

export type RateLimitKind =
  | "login"
  | "password_reset_request"
  | "contact"
  | "admin_elevation_verify"
  | "register"

/** Roughly 1-in-50 calls also prunes stale rows so the table stays bounded
 *  without a scheduled job. Cheap (indexed on created_at via the lookup
 *  index's leading columns being kind/identifier — this scan is intentionally
 *  unindexed-but-rare) and safe to skip on any given call. */
async function pruneOldEventsOccasionally(db: AquillaDb): Promise<void> {
  if (Math.random() >= 0.02) return
  try {
    await db
      .prepare("DELETE FROM auth_rate_limit_events WHERE created_at < now() - interval '1 day'")
      .bind()
      .run()
  } catch (err) {
    console.warn("[rate-limit] prune failed (non-fatal):", err)
  }
}

function scopedIdentifier(prefix: "user" | "ip", value: string): string {
  return `${prefix}:${value.trim().toLowerCase()}`
}

export function loginIdentifier(usernameOrEmail: string): string {
  return scopedIdentifier("user", usernameOrEmail)
}

export function ipIdentifier(ip: string): string {
  return scopedIdentifier("ip", ip)
}

/** Best-effort: a logging failure must never block the auth flow it's throttling. */
export async function recordAuthEvent(
  db: AquillaDb,
  kind: RateLimitKind,
  identifier: string,
  success: boolean,
): Promise<void> {
  try {
    await db
      .prepare(
        "INSERT INTO auth_rate_limit_events (kind, identifier, success) VALUES (?, ?, ?)",
      )
      .bind(kind, identifier, success ? 1 : 0)
      .run()
  } catch (err) {
    console.warn("[rate-limit] record failed (non-fatal):", err)
  }
  await pruneOldEventsOccasionally(db)
}

/**
 * Count events in the trailing window. `onlyFailures` narrows to
 * success=0 rows — used for login lockout, where successful attempts
 * shouldn't count against the caller. Reset-request throttling counts every
 * request regardless of outcome (there's no failure state to distinguish).
 */
export async function countRecentEvents(
  db: AquillaDb,
  kind: RateLimitKind,
  identifier: string,
  opts: { onlyFailures: boolean },
): Promise<number> {
  try {
    const row = await db
      .prepare(
        `SELECT COUNT(*)::int AS n FROM auth_rate_limit_events
         WHERE kind = ? AND identifier = ?
           AND created_at > now() - interval '${WINDOW_MINUTES} minutes'
           ${opts.onlyFailures ? "AND success = 0" : ""}`,
      )
      .bind(kind, identifier)
      .first<{ n: number }>()
    return row?.n ?? 0
  } catch (err) {
    // Fail open: a throttling-infrastructure error must not lock everyone out.
    console.warn("[rate-limit] count failed, failing open:", err)
    return 0
  }
}
