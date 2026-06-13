// Org credit accounting — WS-AUTH-CREDITS.
//
// Spec: docs/superpowers/specs/2026-06-13-org-credits-cost-model.md.
//
// Three rails: 'llm' (OpenRouter chat), 'agent' (translation agent), 'tts'
// (sync-worker, recorded there). This file handles llm + agent.
//
// Design:
//   - Store raw provider cost (raw_cost_cents). Credits = ceil(raw × markup)
//     applied at read/cap-check time so markup changes retroactively.
//   - Enforcement off by default (CREDIT_ENFORCE !== "true"). Log-only mode
//     mirrors ai-budget.ts: never block when not enforcing.
//   - Graceful-degrade: missing table → zeros (degrade like tts in usage.ts).
//
// Table: org_credit_usage_daily (may not yet exist in this env — owned by
//   WS-SCHEMA migration 0042). Guard all queries with isMissingTableError.

import type { Env } from "../types"

export type CreditRail = "llm" | "agent" | "tts"

// ── Config ────────────────────────────────────────────────────────────────────

export interface CreditConfig {
  markup: number           // default 4
  agentMarkup: number      // default 5
  dailyCap: number         // default 1000 credits
  weeklyCap: number        // default 5000 credits
  agentDailyCap: number    // default 600 credits
  agentWeeklyCap: number   // default 3000 credits
  enforce: boolean         // default false
  showToOrg: boolean       // default false
}

const ENV_DEFAULTS: CreditConfig = {
  markup: 4,
  agentMarkup: 5,
  dailyCap: 1000,
  weeklyCap: 5000,
  agentDailyCap: 600,
  agentWeeklyCap: 3000,
  enforce: false,
  showToOrg: false,
}

/**
 * Merge env-var platform defaults with per-org org_settings.credits overrides.
 * Any field missing from org_settings falls back to the env default.
 * Never throws — returns env defaults if org_settings lookup fails.
 */
export async function resolveCreditConfig(
  env: Env,
  db: AquillaDb,
  orgId: number,
): Promise<CreditConfig> {
  // Build env-layer defaults (all optional).
  const envDefaults: CreditConfig = {
    markup:          parseFloat(env.CREDIT_MARKUP ?? "") || ENV_DEFAULTS.markup,
    agentMarkup:     parseFloat(env.CREDIT_AGENT_MARKUP ?? "") || ENV_DEFAULTS.agentMarkup,
    dailyCap:        parseFloat(env.CREDIT_DAILY_CAP ?? "") || ENV_DEFAULTS.dailyCap,
    weeklyCap:       parseFloat(env.CREDIT_WEEKLY_CAP ?? "") || ENV_DEFAULTS.weeklyCap,
    agentDailyCap:   parseFloat(env.CREDIT_AGENT_DAILY_CAP ?? "") || ENV_DEFAULTS.agentDailyCap,
    agentWeeklyCap:  parseFloat(env.CREDIT_AGENT_WEEKLY_CAP ?? "") || ENV_DEFAULTS.agentWeeklyCap,
    enforce:         env.CREDIT_ENFORCE === "true",
    showToOrg:       false,
  }

  if (orgId === 0) return envDefaults

  // Fetch per-org overrides from org_settings JSON key "credits".
  try {
    const row = await db
      .prepare(`SELECT settings FROM org_settings WHERE org_id = ?`)
      .bind(orgId)
      .first<{ settings: string }>()
    if (!row?.settings) return envDefaults

    const parsed = JSON.parse(row.settings) as Record<string, unknown>
    const credits = parsed.credits
    if (!credits || typeof credits !== "object" || Array.isArray(credits)) return envDefaults

    const c = credits as Record<string, unknown>
    return {
      markup:         typeof c.markup === "number"         ? c.markup         : envDefaults.markup,
      agentMarkup:    typeof c.agentMarkup === "number"    ? c.agentMarkup    : envDefaults.agentMarkup,
      dailyCap:       typeof c.dailyCap === "number"       ? c.dailyCap       : envDefaults.dailyCap,
      weeklyCap:      typeof c.weeklyCap === "number"      ? c.weeklyCap      : envDefaults.weeklyCap,
      agentDailyCap:  typeof c.agentDailyCap === "number"  ? c.agentDailyCap  : envDefaults.agentDailyCap,
      agentWeeklyCap: typeof c.agentWeeklyCap === "number" ? c.agentWeeklyCap : envDefaults.agentWeeklyCap,
      enforce:        typeof c.enforce === "boolean"       ? c.enforce        : envDefaults.enforce,
      showToOrg:      typeof c.showToOrg === "boolean"     ? c.showToOrg      : false,
    }
  } catch {
    return envDefaults
  }
}

// ── Formula (spec §"Shared formula") ─────────────────────────────────────────

/**
 * Convert raw provider cost (cents) → customer-facing credits.
 *
 * credits = ceil(rawCents × (rail === 'agent' ? agentMarkup : markup))
 *
 * Intent: agent rail uses a higher markup (5×) because it compounds fastest;
 * all other rails use the base markup (4×).
 */
export function creditsFor(
  rawCents: number,
  rail: CreditRail,
  cfg: CreditConfig,
): number {
  const multiplier = rail === "agent" ? cfg.agentMarkup : cfg.markup
  return Math.ceil(rawCents * multiplier)
}

// ── Spend shape ───────────────────────────────────────────────────────────────

export interface OrgSpend {
  dayCredits: number       // total credits, all rails, today
  weekCredits: number      // total credits, all rails, rolling 7 days
  agentDayCredits: number  // agent-only credits, today
  agentWeekCredits: number // agent-only credits, rolling 7 days
  /** CREDITS (markup already applied) by rail, today — for byRail breakdown. */
  byRailDay: Record<string, number>
  /** CREDITS (markup already applied) by rail, rolling 7d — for byRail breakdown. */
  byRailWeek: Record<string, number>
}

// ── Check function (spec §"Shared formula") ───────────────────────────────────

export type CheckReason = "daily" | "weekly" | "agent_daily" | "agent_weekly"

export interface CheckResult {
  ok: boolean
  reason?: CheckReason
}

/**
 * Evaluate spend against caps. Returns the FIRST failing reason (in precedence
 * order: daily → weekly → agent_daily → agent_weekly).
 *
 * Intent: each cap is independent — daily lets you burst one day while the
 * weekly cap reins in sustained overuse. Agent sub-caps apply only when
 * rail === 'agent'.
 */
export function checkCredits(
  spend: OrgSpend,
  rail: CreditRail,
  cfg: CreditConfig,
): CheckResult {
  if (spend.dayCredits >= cfg.dailyCap)       return { ok: false, reason: "daily" }
  if (spend.weekCredits >= cfg.weeklyCap)     return { ok: false, reason: "weekly" }
  if (rail === "agent") {
    if (spend.agentDayCredits >= cfg.agentDailyCap)   return { ok: false, reason: "agent_daily" }
    if (spend.agentWeekCredits >= cfg.agentWeeklyCap) return { ok: false, reason: "agent_weekly" }
  }
  return { ok: true }
}

// ── Table helpers ─────────────────────────────────────────────────────────────

function isMissingTableError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return msg.includes("does not exist") || msg.includes("undefined_table")
}

function utcDateKey(): string {
  return new Date().toISOString().slice(0, 10)
}

function nDaysAgoUtc(n: number): string {
  const d = new Date()
  d.setUTCDate(d.getUTCDate() - n)
  return d.toISOString().slice(0, 10)
}

// ── recordCredit ──────────────────────────────────────────────────────────────

/**
 * Upsert one usage record into org_credit_usage_daily.
 *
 * Graceful-degrade: any DB error is logged but never re-thrown so it can never
 * crash a route handler. Missing table is silently ignored.
 */
export async function recordCredit(
  db: AquillaDb,
  orgId: number,
  userId: number,
  rail: CreditRail,
  rawCostCents: number,
  units: number,
): Promise<void> {
  const today = utcDateKey()
  try {
    await db
      .prepare(
        `INSERT INTO org_credit_usage_daily
           (org_id, user_id, date_utc, rail, raw_cost_cents, units)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (org_id, user_id, date_utc, rail)
         DO UPDATE SET
           raw_cost_cents = org_credit_usage_daily.raw_cost_cents + EXCLUDED.raw_cost_cents,
           units          = org_credit_usage_daily.units          + EXCLUDED.units`,
      )
      .bind(orgId, userId, today, rail, rawCostCents, units)
      .run()
  } catch (err) {
    if (isMissingTableError(err)) return // table not yet migrated — silent degrade
    console.error("[credits] recordCredit error (ignoring):", err)
  }
}

// ── readSpend ─────────────────────────────────────────────────────────────────

/**
 * Read the org's day + week (rolling 7d) spend, returned as CREDITS (markup
 * applied). Also returns agent-only sub-totals and a byRail breakdown.
 *
 * Returns zeros on missing table (graceful degrade).
 */
export async function readSpend(
  db: AquillaDb,
  orgId: number,
  cfg: CreditConfig,
): Promise<OrgSpend> {
  const today = utcDateKey()
  const weekStart = nDaysAgoUtc(6) // today − 6 = 7 days inclusive

  const zero: OrgSpend = {
    dayCredits: 0,
    weekCredits: 0,
    agentDayCredits: 0,
    agentWeekCredits: 0,
    byRailDay: { llm: 0, agent: 0, tts: 0 },
    byRailWeek: { llm: 0, agent: 0, tts: 0 },
  }

  let rows: Array<{ date_utc: string; rail: string; raw_cost_cents: number }>
  try {
    const res = await db
      .prepare(
        `SELECT date_utc::text AS date_utc, rail,
                COALESCE(SUM(raw_cost_cents), 0) AS raw_cost_cents
           FROM org_credit_usage_daily
          WHERE org_id = ? AND date_utc >= ?
          GROUP BY date_utc, rail`,
      )
      .bind(orgId, weekStart)
      .all<{ date_utc: string; rail: string; raw_cost_cents: number }>()
    rows = res.results ?? []
  } catch (err) {
    if (isMissingTableError(err)) return zero
    console.error("[credits] readSpend query error:", err)
    return zero
  }

  const spend: OrgSpend = {
    ...zero,
    byRailDay: { llm: 0, agent: 0, tts: 0 },
    byRailWeek: { llm: 0, agent: 0, tts: 0 },
  }

  for (const row of rows) {
    const rail = row.rail as CreditRail
    const credits = creditsFor(row.raw_cost_cents, rail, cfg)
    const isToday = row.date_utc === today
    const isAgent = rail === "agent"

    // Week totals.
    spend.weekCredits += credits
    spend.byRailWeek[rail] = (spend.byRailWeek[rail] ?? 0) + credits
    if (isAgent) spend.agentWeekCredits += credits

    // Day totals.
    if (isToday) {
      spend.dayCredits += credits
      spend.byRailDay[rail] = (spend.byRailDay[rail] ?? 0) + credits
      if (isAgent) spend.agentDayCredits += credits
    }
  }

  return spend
}

// ── creditGuard ───────────────────────────────────────────────────────────────

export interface GuardResult {
  ok: boolean
  status?: 429
  reason?: CheckReason
}

/**
 * Pre-flight cap check. Reads current spend, applies checkCredits.
 *
 * When cfg.enforce is false (the default), always returns { ok: true } even
 * when caps are exceeded — mirrors ai-budget.ts log-only mode. Logs a warning
 * so the operator sees the overage.
 *
 * Never throws — degrade to { ok: true } if readSpend fails.
 */
export async function creditGuard(
  db: AquillaDb,
  env: Env,
  orgId: number,
  rail: CreditRail,
): Promise<GuardResult> {
  let cfg: CreditConfig
  try {
    cfg = await resolveCreditConfig(env, db, orgId)
  } catch {
    return { ok: true }
  }

  let spend: OrgSpend
  try {
    spend = await readSpend(db, orgId, cfg)
  } catch {
    return { ok: true }
  }

  const check = checkCredits(spend, rail, cfg)
  if (!check.ok) {
    console.warn(
      `[credits] org ${orgId} over ${check.reason} cap on rail=${rail}`,
      cfg.enforce ? "(enforcing)" : "(log-only)",
      {
        dayCredits: spend.dayCredits,
        weekCredits: spend.weekCredits,
        agentDayCredits: spend.agentDayCredits,
        agentWeekCredits: spend.agentWeekCredits,
      },
    )
    if (cfg.enforce) {
      return { ok: false, status: 429, reason: check.reason }
    }
  }

  return { ok: true }
}
