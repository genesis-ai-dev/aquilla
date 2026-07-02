// Model A/B experiment — arm assignment + event logging + outcome recording.
//
// Scope (v1): the platform-default chat model only. When the client asks for
// the default model (""/"default"/"free-tier") and platform_settings.abTest is
// enabled, `trafficPct`% of those requests are served by the challenger model
// instead of the champion (defaultLlmModel). Every assigned request gets a row
// in model_ab_events; the SPA reports what the user did with the output
// (accepted = validated the cell, edited = overwrote the draft) via
// POST /chat/ab-feedback, keyed by the X-AB-Request-Id response header.
//
// Statistical honesty: rows are written ONLY while an experiment is enabled,
// so both arms always share the same time window; requests that explicitly
// name a model are never reassigned or logged. Assignment is per-request
// random — cross-session feedback loss affects both arms equally, so the
// acceptance-rate comparison stays unbiased.
//
// Every DB write here degrades gracefully (log + continue): the experiment
// must never break chat.

import type { PlatformSettings } from "./platform-settings"

export type AbArm = "champion" | "challenger"
export const AB_OUTCOMES = ["accepted", "edited", "rejected"] as const
export type AbOutcome = (typeof AB_OUTCOMES)[number]

export interface AbAssignment {
  requestId: string
  arm: AbArm
  model: string
}

/**
 * The experiment config in force, or null when off/misconfigured. A challenger
 * equal to the champion (or empty) never runs — the roll would be meaningless.
 */
export function activeAbTest(
  settings: PlatformSettings,
  championModel: string,
): { challengerModel: string; trafficPct: number } | null {
  const ab = settings.abTest
  if (!ab?.enabled) return null
  const challenger = ab.challengerModel.trim()
  if (!challenger || challenger === championModel) return null
  const pct = Math.min(100, Math.max(0, ab.trafficPct))
  return { challengerModel: challenger, trafficPct: pct }
}

/**
 * Roll an arm for one default-model request. `random` is injectable for
 * deterministic tests (defaults to Math.random).
 */
export function pickAbArm(
  settings: PlatformSettings,
  championModel: string,
  random: () => number = Math.random,
): AbAssignment | null {
  const ab = activeAbTest(settings, championModel)
  if (!ab) return null
  const challenger = random() * 100 < ab.trafficPct
  return {
    requestId: crypto.randomUUID(),
    arm: challenger ? "challenger" : "champion",
    model: challenger ? ab.challengerModel : championModel,
  }
}

/** Set the assignment headers the SPA correlates feedback with. */
export function setAbHeaders(headers: Headers, ab: AbAssignment): void {
  headers.set("X-AB-Request-Id", ab.requestId)
  headers.set("X-AB-Arm", ab.arm)
  headers.set("X-AB-Model", ab.model)
}

/** Log one assigned request. Graceful-degrade: never throws. */
export async function recordAbEvent(
  db: AquillaDb,
  ab: AbAssignment,
  userId: number,
  opts: { error: boolean; latencyMs: number },
): Promise<void> {
  try {
    await db
      .prepare(
        `INSERT INTO model_ab_events (id, user_id, arm, model, source, error, latency_ms)
         VALUES (?, ?, ?, ?, 'chat', ?, ?)`,
      )
      .bind(ab.requestId, userId, ab.arm, ab.model, opts.error ? 1 : 0, Math.round(opts.latencyMs))
      .run()
  } catch (err) {
    console.error("[model-ab] failed to record event (continuing):", err)
  }
}

/**
 * Record the user's gesture on an assigned request. The OUTCOME is
 * first-write-wins — a validate after an edit never flips 'edited' back to
 * 'accepted'. The EDIT DISTANCE (normalized Levenshtein [0,1] between the AI
 * draft and the human's text, computed client-side) is last-write-wins: it
 * refines as the translator keeps editing toward the final text. Only the
 * requester may report. Returns whether a row matched.
 */
export async function recordAbOutcome(
  db: AquillaDb,
  requestId: string,
  userId: number,
  outcome: AbOutcome,
  editDistance?: number,
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE model_ab_events
          SET outcome = COALESCE(outcome, ?),
              edit_distance = COALESCE(?, edit_distance),
              outcome_at = COALESCE(outcome_at, now())
        WHERE id = ? AND user_id = ?`,
    )
    .bind(outcome, editDistance ?? null, requestId, userId)
    .run()
  const changes = result.meta?.changes
  return typeof changes === "number" && changes > 0
}

export interface AbResultRow {
  model: string
  arm: AbArm
  requests: number
  errors: number
  accepted: number
  edited: number
  rejected: number
  avgLatencyMs: number | null
  /** Mean normalized edit distance [0,1] over decided drafts — lower = better. */
  avgEditDistance: number | null
}

/** Per-model/arm aggregates over the trailing `days` window (admin console). */
export async function aggregateAbResults(db: AquillaDb, days: number): Promise<AbResultRow[]> {
  const { results } = await db
    .prepare(
      `SELECT model, arm,
              COUNT(*)::int                                        AS requests,
              COALESCE(SUM(error), 0)::int                         AS errors,
              COUNT(*) FILTER (WHERE outcome = 'accepted')::int    AS accepted,
              COUNT(*) FILTER (WHERE outcome = 'edited')::int      AS edited,
              COUNT(*) FILTER (WHERE outcome = 'rejected')::int    AS rejected,
              AVG(latency_ms) FILTER (WHERE error = 0)             AS avg_latency_ms,
              AVG(edit_distance) FILTER (WHERE edit_distance IS NOT NULL) AS avg_edit_distance
         FROM model_ab_events
        WHERE created_at >= now() - make_interval(days => ?)
        GROUP BY model, arm
        ORDER BY arm, model`,
    )
    .bind(days)
    .all<{
      model: string
      arm: AbArm
      requests: number
      errors: number
      accepted: number
      edited: number
      rejected: number
      avg_latency_ms: number | string | null
      avg_edit_distance: number | string | null
    }>()

  return (results ?? []).map((r) => ({
    model: r.model,
    arm: r.arm,
    requests: r.requests,
    errors: r.errors,
    accepted: r.accepted,
    edited: r.edited,
    rejected: r.rejected,
    avgLatencyMs: r.avg_latency_ms == null ? null : Math.round(Number(r.avg_latency_ms)),
    avgEditDistance: r.avg_edit_distance == null ? null : Number(r.avg_edit_distance),
  }))
}
