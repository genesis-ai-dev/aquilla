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
}

/**
 * Default env-level credit config values (platform defaults).
 * Mirror the spec's § Config section.
 */
const DEFAULTS: Required<CreditConfig> = {
  markup: 4.0,
  agentMarkup: 5.0,
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
