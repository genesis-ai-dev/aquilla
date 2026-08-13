// AI budget + allowlist guard — AQU-265
//
// Enforces two controls on the OpenRouter chat-completion proxy:
//
//   1. Model allowlist — reject any model not in the configured set.
//      Default: GPT-5.6 Luna plus explicitly retained fallback models.
//      Override via env var AI_ALLOWED_MODELS (comma-separated).
//
//   2. Per-user daily budget + global daily ceiling.
//      Storage: ai_usage_daily table in Postgres (lightest available datastore;
//      same AQUILLA_PG used everywhere else).
//      Counters are UTC-day keyed (YYYY-MM-DD). Rolling window is not needed —
//      a simple "today's count" is correct for a daily cap.
//
//      In LOG-ONLY mode (AI_BUDGET_ENFORCE !== "true"):
//        - over-budget requests are logged but allowed through.
//      In ENFORCE mode (AI_BUDGET_ENFORCE=true):
//        - per-user → 429 with friendly copy.
//        - global ceiling → 429 with kill-switch copy.
//
// Default thresholds (intentionally large while sizing; tighten before enforcing):
//   AI_USER_DAILY_REQUEST_LIMIT = 500   requests per user per day
//   AI_GLOBAL_DAILY_REQUEST_LIMIT = 5000  requests across all users per day

// AquillaDb is a global type (declared in ../aquilla-db.d.ts).
import type { Env } from "../types"
import { getPlatformSettingsCached, type PlatformSettings } from "./platform-settings"
import { DEFAULT_LLM_MODEL_ID } from "./model-defaults"

// ── Allowlist ──────────────────────────────────────────────────────────────────

/**
 * The models the Codex app actually offers to users. Sourced from:
 *   - Product default: openai/gpt-5.6-luna
 *   - completion-service.ts: model="" / "default" → DEFAULT_LLM_MODEL
 *   - ProjectSettings.tsx placeholder: anthropic/claude-3.5-sonnet
 *   - Historical / fallback: claude-3.5-sonnet, claude-haiku variants
 *
 * Non-allowlisted models cost real money on the platform key and the user
 * has no UI to select them; a request for one signals abuse or misconfiguration.
 */
const DEFAULT_ALLOWED_MODELS = [
  DEFAULT_LLM_MODEL_ID,
  "anthropic/claude-sonnet-4.5",
  "anthropic/claude-sonnet-4-5",
  "anthropic/claude-haiku-4-5",
  "anthropic/claude-sonnet-4",
  "anthropic/claude-3.5-sonnet",
  "anthropic/claude-3.5-haiku",
  "anthropic/claude-3-haiku",
  // "default" and "free-tier" are resolved to DEFAULT_LLM_MODEL before this
  // check, so they never reach here. Listed anyway as a safety net.
  "default",
  "free-tier",
]

/**
 * Effective allowlist: admin-set platform_settings.allowedModels wins, then the
 * AI_ALLOWED_MODELS env var, then the hardcoded default. `settings` is passed in
 * (already loaded) so this stays sync + DB-free for testing.
 */
export function getAllowedModels(env: Env, settings?: PlatformSettings): Set<string> {
  if (settings?.allowedModels && settings.allowedModels.length > 0) {
    return new Set(settings.allowedModels)
  }
  const raw = env.AI_ALLOWED_MODELS?.trim()
  if (!raw) return new Set(DEFAULT_ALLOWED_MODELS)
  return new Set(raw.split(",").map((m) => m.trim()).filter(Boolean))
}

export function checkModelAllowed(
  model: string,
  allowedModels: Set<string>,
): { allowed: true } | { allowed: false; message: string } {
  if (allowedModels.has(model)) return { allowed: true }
  return {
    allowed: false,
    message: `Model "${model}" is not available on this platform. Use one of: ${[...allowedModels].filter(m => m !== "default" && m !== "free-tier").join(", ")}.`,
  }
}

// ── Budget counters ────────────────────────────────────────────────────────────

function utcDateKey(): string {
  return new Date().toISOString().slice(0, 10) // "YYYY-MM-DD"
}

/** Increment the per-user and global counters for today; return updated counts. */
export async function recordAndCheckBudget(
  db: AquillaDb,
  userId: number,
  env: Env,
  settings?: PlatformSettings,
): Promise<BudgetResult> {
  const today = utcDateKey()
  // admin-set platform_settings wins over the env var, which wins over the default.
  const userLimit = settings?.aiUserDailyLimit ?? Number(env.AI_USER_DAILY_REQUEST_LIMIT ?? 500)
  const globalLimit = settings?.aiGlobalDailyLimit ?? Number(env.AI_GLOBAL_DAILY_REQUEST_LIMIT ?? 5000)

  // Upsert user counter.
  const userRow = await db
    .prepare(
      `INSERT INTO ai_usage_daily (user_id, date_utc, request_count)
       VALUES (?, ?, 1)
       ON CONFLICT (user_id, date_utc)
       DO UPDATE SET request_count = ai_usage_daily.request_count + 1
       RETURNING request_count`,
    )
    .bind(userId, today)
    .first<{ request_count: number }>()

  const userCount = userRow?.request_count ?? 1

  // Upsert global counter (user_id=0 is the sentinel for "global").
  const globalRow = await db
    .prepare(
      `INSERT INTO ai_usage_daily (user_id, date_utc, request_count)
       VALUES (0, ?, 1)
       ON CONFLICT (user_id, date_utc)
       DO UPDATE SET request_count = ai_usage_daily.request_count + 1
       RETURNING request_count`,
    )
    .bind(today)
    .first<{ request_count: number }>()

  const globalCount = globalRow?.request_count ?? 1

  const userOver = userCount > userLimit
  const globalOver = globalCount > globalLimit

  return { userCount, globalCount, userLimit, globalLimit, userOver, globalOver }
}

export interface BudgetResult {
  userCount: number
  globalCount: number
  userLimit: number
  globalLimit: number
  /** True if this request would exceed the per-user daily limit. */
  userOver: boolean
  /** True if this request would exceed the global daily ceiling. */
  globalOver: boolean
}

// ── Guard (call from route handler) ──────────────────────────────────────────

export type GuardOutcome =
  | { ok: true }
  | { ok: false; status: 400 | 429; body: { error: string; message: string } }

/**
 * Run allowlist + budget checks.
 *
 * In LOG-ONLY mode (AI_BUDGET_ENFORCE !== "true") budget over-runs are logged
 * but the function still returns { ok: true } so the request passes through.
 *
 * Returns { ok: false } only when:
 *   - The model is not allowlisted (always enforced, regardless of mode).
 *   - Budget is over AND enforcement is enabled.
 */
export async function runAiGuard(
  model: string,
  userId: number,
  db: AquillaDb,
  env: Env,
): Promise<GuardOutcome> {
  // Load global overrides once; the cache keeps this off the per-request DB path.
  const settings = await getPlatformSettingsCached(env)

  // 1. Allowlist (always enforced).
  const allowedModels = getAllowedModels(env, settings)
  const modelCheck = checkModelAllowed(model, allowedModels)
  if (!modelCheck.allowed) {
    return {
      ok: false,
      status: 400,
      body: { error: "model_not_allowed", message: modelCheck.message },
    }
  }

  // 2. Budget counters.
  let budget: BudgetResult
  try {
    budget = await recordAndCheckBudget(db, userId, env, settings)
  } catch (err) {
    // Never block a request due to a counter failure — degrade gracefully.
    console.error("[ai-budget] counter error (allowing through):", err)
    return { ok: true }
  }

  const enforce = settings.aiBudgetEnforce ?? (env.AI_BUDGET_ENFORCE === "true")

  if (budget.globalOver) {
    console.warn(
      `[ai-budget] global ceiling hit: ${budget.globalCount}/${budget.globalLimit} on ${utcDateKey()}`,
      enforce ? "(enforcing)" : "(log-only)",
    )
    if (enforce) {
      return {
        ok: false,
        status: 429,
        body: {
          error: "global_budget_exceeded",
          message: "Platform AI capacity for today has been reached. Please try again tomorrow.",
        },
      }
    }
  }

  if (budget.userOver) {
    console.warn(
      `[ai-budget] user ${userId} over budget: ${budget.userCount}/${budget.userLimit} on ${utcDateKey()}`,
      enforce ? "(enforcing)" : "(log-only)",
    )
    if (enforce) {
      return {
        ok: false,
        status: 429,
        body: {
          error: "daily_budget_exceeded",
          message: "Daily AI limit reached — resets at midnight UTC.",
        },
      }
    }
  }

  return { ok: true }
}
