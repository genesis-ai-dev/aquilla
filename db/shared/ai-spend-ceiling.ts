// Platform-wide daily AI spend ceiling — AQU-1869.
//
// A hard floor in DOLLARS that protects the SHARED vendor keys (OpenRouter,
// Inworld, Modal). Every paid AI path checks it before calling a provider:
// the chat proxy, the translation agent, autopilot, DraftCells, brief render,
// smart edits, import classification, the import sandbox, hosted
// transcription, TTS, voice-convert and diarization.
//
// Why this exists alongside the guards we already had:
//   - lib/ai-budget.ts counts REQUESTS per user/day and is log-only unless
//     AI_BUDGET_ENFORCE=true (it isn't, in any deployed environment).
//   - lib/credits.ts caps an ORG's credits and is log-only unless
//     CREDIT_ENFORCE=true (likewise).
//   - tts-budget.ts counts AUDIO SECONDS, also log-only.
// So with open self-registration the only live control was a per-user request
// count, and one scripted account on a Sonnet-class model is ~$17k/day on the
// shared key (scaling audit, 2026-10-10). A request count cannot express that
// risk: the cost of a request varies 1000× with model and prompt size.
//
// This ceiling is therefore deliberately NOT behind an enforce flag and is
// independent of the per-org enforce decision — flipping org enforcement on is
// a product call, keeping the shared key solvent is not. Operators move the
// ceiling (or switch it off explicitly); they do not choose whether it runs.
//
// Spend source: `org_credit_usage_daily.raw_cost_cents` — RAW provider cost,
// not customer-facing credits, because the thing being protected is the real
// vendor bill. Negative rows (complimentary grants written by
// credits.ts::grantCredits) are floored at zero per row: a goodwill grant is
// not money the platform got back from the vendor.
//
// Accuracy caveat: the ceiling is exactly as accurate as that ledger. The
// legacy streamed-chat path records a flat 1¢ per call regardless of real cost
// (AQU-1871), so until that is fixed the measured total under-reports and the
// ceiling trips later than the true dollar figure. The ceiling is still the
// only control that reads dollars at all.

import type { AquillaDb } from "../shim/postgres"

/** Error code returned to the client when the ceiling has been reached. */
export const AI_SPEND_CEILING_ERROR = "ai_spend_ceiling_reached"

/**
 * User-facing copy. Phrased as a platform outage rather than a personal quota,
 * because that is what it is — nothing the user can do changes it, and they
 * must not be told to upgrade a plan or wait out their own limit.
 */
export const AI_SPEND_CEILING_MESSAGE =
  "AI is temporarily unavailable: the platform's daily AI spend ceiling has been reached. It resets at midnight UTC."

/**
 * Ceiling used when nothing configures one. Finite on purpose — an unset
 * variable in a new environment must not mean "unlimited", or the protection
 * exists only where someone remembered to switch it on.
 */
export const DEFAULT_AI_DAILY_SPEND_CEILING_USD = 500

/** Values of AI_DAILY_SPEND_CEILING_USD that switch the ceiling off entirely. */
const OFF_VALUES = new Set(["off", "none", "unlimited", "disabled"])

/** How long a spend/ceiling read is reused in-isolate. */
const TTL_MS = 15_000

export interface AiSpendCeilingEnv {
  /**
   * Daily platform ceiling in US dollars. Unset → DEFAULT_AI_DAILY_SPEND_CEILING_USD.
   * `0` means "no paid AI at all" (a usable panic position). `off` / `none` /
   * `unlimited` / `disabled` switch the ceiling off. A negative number also
   * switches it off, so a misconfigured `-1` degrades to today's behaviour
   * rather than blocking every AI feature.
   */
  AI_DAILY_SPEND_CEILING_USD?: string
  /** "test" bypasses the in-isolate cache (PGlite truncates between tests). */
  ENVIRONMENT?: string
}

/** Effective ceiling in USD, or `null` when the ceiling is switched off. */
export type EffectiveCeilingUsd = number | null

/**
 * Resolve the effective ceiling. An admin-set `platform_settings`
 * value wins over the env var, which wins over the built-in default — the same
 * precedence lib/ai-budget.ts uses for its request counters.
 */
export function resolveAiSpendCeilingUsd(
  envValue: string | undefined,
  settingsValue?: number,
): EffectiveCeilingUsd {
  if (typeof settingsValue === "number" && Number.isFinite(settingsValue)) {
    return settingsValue < 0 ? null : settingsValue
  }
  const raw = envValue?.trim()
  if (!raw) return DEFAULT_AI_DAILY_SPEND_CEILING_USD
  if (OFF_VALUES.has(raw.toLowerCase())) return null
  const parsed = Number(raw)
  if (!Number.isFinite(parsed)) {
    console.warn(
      `[ai-spend-ceiling] AI_DAILY_SPEND_CEILING_USD="${raw}" is not a number; using $${DEFAULT_AI_DAILY_SPEND_CEILING_USD}/day`,
    )
    return DEFAULT_AI_DAILY_SPEND_CEILING_USD
  }
  return parsed < 0 ? null : parsed
}

export interface AiSpendSnapshot {
  /** Raw provider spend recorded for `day` across all orgs, in cents. */
  spendCents: number
  /** Effective ceiling in USD, or null when switched off. */
  ceilingUsd: EffectiveCeilingUsd
  /** The UTC day (YYYY-MM-DD) this snapshot covers. */
  day: string
}

/** True when `spendCents` has reached the ceiling. */
export function isOverAiSpendCeiling(snapshot: AiSpendSnapshot): boolean {
  if (snapshot.ceilingUsd === null) return false
  return snapshot.spendCents >= snapshot.ceilingUsd * 100
}

export function utcDayKey(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10)
}

/**
 * One statement reads both halves of the decision: today's platform spend and
 * the admin-set ceiling. Keeping them in a single round trip means sync-worker
 * (which has no platform-settings cache of its own) honours an admin lowering
 * the ceiling exactly as auth-worker does — a kill switch that only half the
 * paid paths obey is not a kill switch.
 */
async function readSnapshot(db: AquillaDb, env: AiSpendCeilingEnv): Promise<AiSpendSnapshot> {
  const day = utcDayKey()
  const row = await db
    .prepare(
      `SELECT
         (SELECT COALESCE(SUM(GREATEST(raw_cost_cents, 0)), 0)::float8
            FROM org_credit_usage_daily
           WHERE date_utc = ?) AS spend_cents,
         (SELECT settings FROM platform_settings WHERE id = 1) AS platform_settings`,
    )
    .bind(day)
    .first<{ spend_cents: number | string | null; platform_settings: string | null }>()

  return {
    spendCents: Number(row?.spend_cents ?? 0) || 0,
    ceilingUsd: resolveAiSpendCeilingUsd(
      env.AI_DAILY_SPEND_CEILING_USD,
      parseCeilingFromSettings(row?.platform_settings),
    ),
    day,
  }
}

/**
 * Pull just `aiDailySpendCeilingUsd` out of the platform_settings blob. A local
 * one-key parse rather than an import of auth-worker's PlatformSettings parser,
 * because this module is shared with sync-worker, which cannot import from
 * auth-worker's src tree.
 */
function parseCeilingFromSettings(raw: string | null | undefined): number | undefined {
  if (!raw) return undefined
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined
    const value = (parsed as Record<string, unknown>).aiDailySpendCeilingUsd
    return typeof value === "number" && Number.isFinite(value) ? value : undefined
  } catch {
    return undefined
  }
}

// ── In-isolate cache + once-per-day alert ────────────────────────────────────

let cache: { value: AiSpendSnapshot; at: number } | null = null
let inflight: Promise<AiSpendSnapshot> | null = null
let alertedDay: string | null = null

/** Drop the cache and the alert latch. For tests only. */
export function __resetAiSpendCeilingStateForTests(): void {
  cache = null
  inflight = null
  alertedDay = null
}

async function snapshotCached(db: AquillaDb, env: AiSpendCeilingEnv): Promise<AiSpendSnapshot> {
  if (env.ENVIRONMENT === "test") return readSnapshot(db, env)
  const now = Date.now()
  if (cache && now - cache.at < TTL_MS && cache.value.day === utcDayKey()) return cache.value
  if (inflight) return inflight
  inflight = readSnapshot(db, env)
    .then((snapshot) => {
      cache = { value: snapshot, at: Date.now() }
      return snapshot
    })
    .finally(() => {
      inflight = null
    })
  return inflight
}

export type AiSpendCeilingOutcome =
  | { ok: true }
  | {
      ok: false
      status: 503
      body: { error: typeof AI_SPEND_CEILING_ERROR; message: string }
    }

/**
 * Check the ceiling before a paid provider call. `surface` names the caller
 * ("chat", "agent", "tts", …) and is reported in the alert and error lines, so
 * a log says which path first hit the floor.
 *
 * Alerting: exactly one line per UTC day per isolate, emitted the first time
 * the ceiling is seen as reached — not one per blocked request, which would
 * bury the signal in the flood it is reporting. (Several isolates may each emit
 * once; the line is `[ai-spend-ceiling] ALERT`, so it still greps to a handful.)
 *
 * Fails OPEN on a read error, with an error log: the same choice every other
 * guard here makes, because a Postgres blip must not take every AI feature
 * down. AQU-1843 tracks moving paid-route guards to fail-closed; when that
 * lands, this is one of the call sites it covers.
 */
export async function checkAiSpendCeiling(
  db: AquillaDb | undefined,
  env: AiSpendCeilingEnv,
  surface: string,
): Promise<AiSpendCeilingOutcome> {
  if (!db) return { ok: true }

  let snapshot: AiSpendSnapshot
  try {
    snapshot = await snapshotCached(db, env)
  } catch (err) {
    console.error(`[ai-spend-ceiling] read failed for ${surface} (allowing through):`, err)
    return { ok: true }
  }

  if (!isOverAiSpendCeiling(snapshot)) return { ok: true }

  if (alertedDay !== snapshot.day) {
    alertedDay = snapshot.day
    console.error(
      `[ai-spend-ceiling] ALERT platform daily AI spend ceiling reached on ${snapshot.day} ` +
        `(first refused surface: ${surface}): ` +
        `$${(snapshot.spendCents / 100).toFixed(2)} of $${snapshot.ceilingUsd} — paid AI calls are now refused ` +
        `until the next UTC day. Raise AI_DAILY_SPEND_CEILING_USD (or platform_settings.aiDailySpendCeilingUsd) to restore service.`,
    )
  }

  return {
    ok: false,
    status: 503,
    body: { error: AI_SPEND_CEILING_ERROR, message: AI_SPEND_CEILING_MESSAGE },
  }
}
