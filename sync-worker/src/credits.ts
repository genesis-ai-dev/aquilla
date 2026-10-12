// Org credit cost model for the sync-worker (TTS rail).
//
// Spec: docs/superpowers/specs/2026-06-13-org-credits-cost-model.md
// § WS-SYNC-CREDITS + "Shared formula"
//
// The formula is intentionally duplicated across workers (auth-worker and
// sync-worker) and the frontend — the spec is the single source of truth,
// and each copy is a small pure function with no cross-package import.
//
// Raw cost is stored; credits (markup applied) are derived on read. This
// means markup/caps can change retroactively without re-writing the ledger.
//
// Graceful degrade: recordCredit NEVER throws. A counter failure must not
// surface to a user who already received valid audio (mirrors tts-budget.ts).

/**
 * Config subset that creditsFor and recordCredit need from the env or a
 * resolved org config. All fields optional — defaults defined here.
 */
export interface CreditConfig {
  /** Default 4.0× — cost-plus SaaS norm */
  markup?: number
  /** Default 5.0× — agent is the expensive rail */
  agentMarkup?: number
  /** Default 1000 credits ($10/day) — all rails, today */
  dailyCap?: number
  /** Default 5000 credits ($50/wk) — all rails, rolling 7 days */
  weeklyCap?: number
  /** Default false — log-only, mirroring auth-worker's CREDIT_ENFORCE */
  enforce?: boolean
}

/** Every field resolved: env defaults ⊕ org_settings.credits overrides. */
export type ResolvedCreditConfig = Required<CreditConfig>

/**
 * Default env-level credit config values (platform defaults).
 * Mirror the spec's § Config section.
 */
const DEFAULTS: ResolvedCreditConfig = {
  markup: 4.0,
  agentMarkup: 5.0,
  dailyCap: 1000,
  weeklyCap: 5000,
  enforce: false,
}

/**
 * creditsFor — compute the credits (customer-facing cost, in whole cents)
 * for a given raw provider cost.
 *
 * WHY Math.ceil: credits are the customer-facing price; always round up so
 * the platform never gives away fractional cents.
 *
 * Formula (spec § "Shared formula"):
 *   credits = ceil(rawCents × markup(rail))
 */
export function creditsFor(
  rawCents: number,
  rail: "llm" | "agent" | "tts",
  cfg: CreditConfig = {},
): number {
  const markup = rail === "agent"
    ? (cfg.agentMarkup ?? DEFAULTS.agentMarkup)
    : (cfg.markup ?? DEFAULTS.markup)
  return Math.ceil(rawCents * markup)
}

/**
 * recordCredit — upsert one ledger row into org_credit_usage_daily.
 *
 * Primary key: (org_id, user_id, date_utc, rail)
 * Increments:  raw_cost_cents += rawCostCents, units += units
 *
 * Graceful degrade: logs the error and returns without throwing so a
 * metering failure never blocks a user who already received valid output.
 *
 * Guard: if the org_credit_usage_daily table is absent (no migration yet)
 * the INSERT will throw; we catch it as a no-op (log-only).
 */
export async function recordCredit(
  db: AquillaDb,
  orgId: number,
  userId: number,
  rail: "llm" | "agent" | "tts",
  rawCostCents: number,
  units: number,
): Promise<void> {
  const today = new Date().toISOString().slice(0, 10) // "YYYY-MM-DD"

  const upsertSql = `
    INSERT INTO org_credit_usage_daily (org_id, user_id, date_utc, rail, raw_cost_cents, units)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT (org_id, user_id, date_utc, rail)
    DO UPDATE SET
      raw_cost_cents = org_credit_usage_daily.raw_cost_cents + EXCLUDED.raw_cost_cents,
      units          = org_credit_usage_daily.units + EXCLUDED.units`

  try {
    await db
      .prepare(upsertSql)
      .bind(orgId, userId, today, rail, rawCostCents, units)
      .run()
  } catch (err) {
    // Missing table (pre-migration) or transient DB error — degrade gracefully.
    console.error("[credits] recordCredit failed (degrading gracefully):", err)
  }
}

// ── Org credit pre-check (AQU-1872) ──────────────────────────────────────────
//
// The spec left the TTS pre-check optional ("low priority — TTS is the cheap
// rail"), so synthesis called the provider no matter how much the org had
// already spent: the only ceiling was a per-user request window, which a batch
// narration split across several users in one org walks straight past. This is
// the same formula auth-worker's creditGuard runs for the llm/agent rails,
// duplicated here per the header note (no cross-package import).

/** Env subset the credit guard reads. All optional — defaults above apply. */
export interface CreditEnv {
  CREDIT_MARKUP?: string
  CREDIT_AGENT_MARKUP?: string
  CREDIT_DAILY_CAP?: string
  CREDIT_WEEKLY_CAP?: string
  CREDIT_ENFORCE?: string
}

function utcDateKey(): string {
  return new Date().toISOString().slice(0, 10)
}

function nDaysAgoUtc(n: number): string {
  const d = new Date()
  d.setUTCDate(d.getUTCDate() - n)
  return d.toISOString().slice(0, 10)
}

function isMissingTableError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return msg.includes("does not exist") || msg.includes("undefined_table")
}

/**
 * Merge platform env defaults with the org's `org_settings.credits` overrides.
 * Never throws — an unreadable org_settings row falls back to env defaults.
 */
export async function resolveCreditConfig(
  env: CreditEnv,
  db: AquillaDb,
  orgId: number,
): Promise<ResolvedCreditConfig> {
  const envDefaults: ResolvedCreditConfig = {
    markup:      parseFloat(env.CREDIT_MARKUP ?? "") || DEFAULTS.markup,
    agentMarkup: parseFloat(env.CREDIT_AGENT_MARKUP ?? "") || DEFAULTS.agentMarkup,
    dailyCap:    parseFloat(env.CREDIT_DAILY_CAP ?? "") || DEFAULTS.dailyCap,
    weeklyCap:   parseFloat(env.CREDIT_WEEKLY_CAP ?? "") || DEFAULTS.weeklyCap,
    enforce:     env.CREDIT_ENFORCE === "true",
  }

  if (orgId === 0) return envDefaults

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
      markup:      typeof c.markup === "number"      ? c.markup      : envDefaults.markup,
      agentMarkup: typeof c.agentMarkup === "number" ? c.agentMarkup : envDefaults.agentMarkup,
      dailyCap:    typeof c.dailyCap === "number"    ? c.dailyCap    : envDefaults.dailyCap,
      weeklyCap:   typeof c.weeklyCap === "number"   ? c.weeklyCap   : envDefaults.weeklyCap,
      enforce:     typeof c.enforce === "boolean"    ? c.enforce     : envDefaults.enforce,
    }
  } catch {
    return envDefaults
  }
}

export interface OrgSpend {
  /** Total credits (markup applied), all rails, today. */
  dayCredits: number
  /** Total credits (markup applied), all rails, rolling 7 days. */
  weekCredits: number
}

/**
 * Read the org's day + rolling-7-day spend from org_credit_usage_daily,
 * converted to credits with the org's markup.
 *
 * Returns zeros when the table is absent (pre-migration) or the query fails —
 * an unreadable ledger must not block a user, only stop enforcing.
 */
export async function readOrgSpend(
  db: AquillaDb,
  orgId: number,
  cfg: ResolvedCreditConfig,
): Promise<OrgSpend> {
  const today = utcDateKey()
  const weekStart = nDaysAgoUtc(6) // today − 6 = 7 days inclusive
  const zero: OrgSpend = { dayCredits: 0, weekCredits: 0 }

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
    if (!isMissingTableError(err)) {
      console.error("[credits] readOrgSpend query error (degrading to zero):", err)
    }
    return zero
  }

  const spend = { ...zero }
  for (const row of rows) {
    const credits = creditsFor(row.raw_cost_cents, row.rail as "llm" | "agent" | "tts", cfg)
    spend.weekCredits += credits
    if (row.date_utc === today) spend.dayCredits += credits
  }
  return spend
}

export type CreditCapReason = "daily" | "weekly"

/**
 * Evaluate spend against the caps, returning the first failing reason.
 * Identical to auth-worker's checkCredits for the non-agent rails (the TTS
 * rail has no agent sub-caps).
 */
export function checkCredits(
  spend: OrgSpend,
  cfg: ResolvedCreditConfig,
): { ok: boolean; reason?: CreditCapReason } {
  if (spend.dayCredits >= cfg.dailyCap) return { ok: false, reason: "daily" }
  if (spend.weekCredits >= cfg.weeklyCap) return { ok: false, reason: "weekly" }
  return { ok: true }
}

export type CreditGuardOutcome =
  | { ok: true }
  | { ok: false; status: 429; body: { error: string; message: string; reason: CreditCapReason } }

/**
 * Pre-flight org credit check, to be run BEFORE any paid provider call.
 *
 * Log-only unless the resolved config enforces (env `CREDIT_ENFORCE=true` or
 * `org_settings.credits.enforce`), mirroring auth-worker's creditGuard and
 * tts-budget's runTtsGuard: an org over cap is logged but let through while
 * limits are being sized. Never throws — any failure degrades to { ok: true }
 * so a ledger problem cannot take TTS down.
 */
export async function runOrgCreditGuard(
  db: AquillaDb,
  env: CreditEnv,
  orgId: number,
  rail: "llm" | "agent" | "tts",
): Promise<CreditGuardOutcome> {
  let cfg: ResolvedCreditConfig
  let spend: OrgSpend
  try {
    cfg = await resolveCreditConfig(env, db, orgId)
    spend = await readOrgSpend(db, orgId, cfg)
  } catch (err) {
    console.error("[credits] pre-check error (allowing through):", err)
    return { ok: true }
  }

  const check = checkCredits(spend, cfg)
  if (!check.ok && check.reason) {
    console.warn(
      `[credits] org ${orgId} over ${check.reason} cap on rail=${rail}`,
      cfg.enforce ? "(enforcing)" : "(log-only)",
      { dayCredits: spend.dayCredits, weekCredits: spend.weekCredits },
    )
    if (cfg.enforce) {
      const window = check.reason === "daily" ? "daily" : "weekly"
      return {
        ok: false,
        status: 429,
        body: {
          error: "credit_cap_exceeded",
          message: `This organization has used its ${window} credit allowance. No audio was generated — ask an org admin to raise the cap or wait for it to reset.`,
          reason: check.reason,
        },
      }
    }
  }

  return { ok: true }
}
