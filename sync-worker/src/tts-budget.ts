// TTS audio-seconds budget guard — mirrors auth-worker/src/lib/ai-budget.ts
// but meters SECONDS (floating-point) rather than request counts.
//
// Table: tts_usage_daily(user_id, org_id, date_utc, request_count, audio_seconds)
//   - Real user row: (userId, orgId, today) — per-user with org attribution.
//   - Global sentinel: (0, 0, today)        — O(1) platform total.
//   - Org totals are derived at read time via SUM WHERE org_id = ?
//
// Enforcement default: LOG-ONLY (TTS_BUDGET_ENFORCE !== "true").
// The caller always hears { ok:true } while log-only, so the Modal round-trip
// is never blocked while limits are being sized.

// AquillaDb is a global type declared in db/shim/postgres.ts
// Env is the Cloudflare.Env namespace augmented in index.ts

function utcDateKey(): string {
  return new Date().toISOString().slice(0, 10) // "YYYY-MM-DD"
}

export interface TtsBudgetCheck {
  /** True when today's recorded seconds ≥ limit. */
  over: boolean
  /** Total audio seconds recorded for this user today (before this request). */
  seconds: number
  /** The daily limit that was compared against. */
  limit: number
}

/**
 * PRE-CHECK: read today's total audio seconds for the user (no write).
 * Used before calling Modal so we can 429 without incurring GPU cost.
 *
 * Why a SUM over (userId, today) across all org rows, rather than a
 * per-org query? The limit is per-user, not per-org. A user who belongs to
 * two orgs has one combined quota; reading all rows for that userId gives
 * the correct aggregate even if they switch org context mid-day.
 */
export async function checkTtsBudget(
  db: AquillaDb,
  userId: number,
  env: Pick<Cloudflare.Env, "TTS_USER_DAILY_SECONDS_LIMIT">,
): Promise<TtsBudgetCheck> {
  const today = utcDateKey()
  const limit = Number(env.TTS_USER_DAILY_SECONDS_LIMIT ?? 36000) // 10 h default while sizing

  const row = await db
    .prepare(
      `SELECT COALESCE(SUM(audio_seconds), 0) AS total_seconds
       FROM tts_usage_daily
       WHERE user_id = ? AND date_utc = ?`,
    )
    .bind(userId, today)
    .first<{ total_seconds: number }>()

  const seconds = row?.total_seconds ?? 0
  return { over: seconds >= limit, seconds, limit }
}

/**
 * POST-RECORD: upsert two rows after a successful synthesis:
 *   1. Per-user row  (userId, orgId, today) — +1 request, +seconds.
 *   2. Global sentinel (0, 0, today)        — +1 request, +seconds.
 *
 * Gracefully degrades (logs, does NOT throw) on any DB error so a counter
 * failure never blocks a user who already received valid audio.
 */
export async function recordTtsUsage(
  db: AquillaDb,
  userId: number,
  orgId: number,
  seconds: number,
  env?: Pick<Cloudflare.Env, "TTS_USER_DAILY_SECONDS_LIMIT">, // unused here; kept for symmetry with ai-budget.ts
): Promise<void> {
  const today = utcDateKey()
  const upsertSql = `
    INSERT INTO tts_usage_daily (user_id, org_id, date_utc, request_count, audio_seconds)
    VALUES (?, ?, ?, 1, ?)
    ON CONFLICT (user_id, org_id, date_utc)
    DO UPDATE SET
      request_count = tts_usage_daily.request_count + 1,
      audio_seconds = tts_usage_daily.audio_seconds + EXCLUDED.audio_seconds`

  try {
    // Two separate upserts so each is its own statement (no batch dependency).
    await db.prepare(upsertSql).bind(userId, orgId, today, seconds).run()
    await db.prepare(upsertSql).bind(0, 0, today, seconds).run() // global sentinel
  } catch (err) {
    // Never surface a counter failure to the caller — the audio was already
    // written to R2 and the response sent. Log for ops visibility only.
    console.error("[tts-budget] counter write failed (degrading gracefully):", err)
  }
}

export type TtsGuardOutcome =
  | { ok: true }
  | { ok: false; status: 429; body: { error: string } }

/**
 * Run the pre-check and optionally enforce the limit.
 *
 * In LOG-ONLY mode (TTS_BUDGET_ENFORCE !== "true", the default):
 *   - Over-budget requests are logged as a warning but allowed through.
 * In ENFORCE mode (TTS_BUDGET_ENFORCE === "true"):
 *   - Returns { ok: false, status: 429 } when the user is over budget.
 *
 * Mirroring ai-budget.ts: a DB error during the pre-check degrades
 * gracefully and lets the request through rather than blocking valid users.
 */
export async function runTtsGuard(
  db: AquillaDb,
  userId: number,
  env: Pick<Cloudflare.Env, "TTS_USER_DAILY_SECONDS_LIMIT" | "TTS_BUDGET_ENFORCE">,
): Promise<TtsGuardOutcome> {
  let check: TtsBudgetCheck
  try {
    check = await checkTtsBudget(db, userId, env)
  } catch (err) {
    // DB unavailable → degrade gracefully (allow the synthesis request).
    console.error("[tts-budget] pre-check error (allowing through):", err)
    return { ok: true }
  }

  if (check.over) {
    const enforce = env.TTS_BUDGET_ENFORCE === "true"
    console.warn(
      `[tts-budget] user ${userId} over daily limit: ${check.seconds}/${check.limit}s on ${utcDateKey()}`,
      enforce ? "(enforcing)" : "(log-only)",
    )
    if (enforce) {
      return {
        ok: false,
        status: 429,
        body: { error: "tts_daily_limit_exceeded" },
      }
    }
  }

  return { ok: true }
}
