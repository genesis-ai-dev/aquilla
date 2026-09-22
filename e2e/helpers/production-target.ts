/**
 * Configuration for the opt-in production timing probe (AQU-1024).
 *
 * Every other E2E entrypoint drives a local `wrangler dev` stack that
 * `/__test__/reset` wipes between tests. This probe deliberately does not: it
 * signs in to a deployed environment with real credentials and commits a real
 * event, because the timing regressions it exists to catch (cold Worker start,
 * Hyperdrive/Neon saturation, a slow projection write) are invisible against a
 * local stack.
 *
 * That makes it configuration-gated rather than default-on. Nothing here has a
 * credential or a project id baked in, and `resolveProductionTimingTarget`
 * refuses to run until an operator has named both.
 */

export interface ProductionTimingTarget {
  /** Origin serving the SPA, e.g. `https://aquilla.app`. */
  appOrigin: string
  /** auth-worker mount, e.g. `https://api.aquilla.app/identity`. */
  authBase: string
  username: string
  password: string
  /** Project the probe opens and writes into. Must be reserved for the probe. */
  projectId: string
  /** Budget for navigation → first rendered cell. */
  loadBudgetMs: number
  /** Budget for the committing blur → the server's `/events` acknowledgement. */
  writeBudgetMs: number
}

/** Environment variable names, exported so the runner and docs cannot drift. */
export const PRODUCTION_TIMING_ENV = {
  appOrigin: "AQUILLA_PROD_APP_ORIGIN",
  authBase: "AQUILLA_PROD_AUTH_BASE",
  username: "AQUILLA_PROD_USERNAME",
  password: "AQUILLA_PROD_PASSWORD",
  projectId: "AQUILLA_PROD_PROJECT_ID",
  loadBudgetMs: "AQUILLA_PROD_LOAD_BUDGET_MS",
  writeBudgetMs: "AQUILLA_PROD_WRITE_BUDGET_MS",
} as const

export const DEFAULT_APP_ORIGIN = "https://aquilla.app"
export const DEFAULT_AUTH_BASE = "https://api.aquilla.app/identity"

// The SPA aborts an in-flight request at 15s, so a workspace that has not
// rendered its first cell by then has already failed for a real user. This is
// a ceiling, not a target: tighten it per environment once the team has a
// recorded baseline (the probe prints every measurement it takes).
export const DEFAULT_LOAD_BUDGET_MS = 15_000

// Both workers log any request at or beyond 5s as a `[slow-request]` defect
// (AGENTS.md → "Slow-request logs"). A commit that crosses that line is
// exactly the regression this probe exists to fail on.
export const DEFAULT_WRITE_BUDGET_MS = 5_000

type Env = Record<string, string | undefined>

function trimmed(env: Env, key: string): string {
  return (env[key] ?? "").trim()
}

function readOrigin(env: Env, key: string, fallback: string, problems: string[]): string {
  const raw = trimmed(env, key) || fallback
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    problems.push(`${key} must be an absolute URL (got ${JSON.stringify(raw)})`)
    return raw
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    problems.push(`${key} must be an http(s) URL (got ${JSON.stringify(raw)})`)
  }
  return raw.replace(/\/+$/, "")
}

function readRequired(env: Env, key: string, purpose: string, problems: string[]): string {
  const value = trimmed(env, key)
  if (!value) problems.push(`${key} is required — ${purpose}`)
  return value
}

function readBudget(env: Env, key: string, fallback: number, problems: string[]): number {
  const raw = trimmed(env, key)
  if (!raw) return fallback
  // A typo'd budget must never silently fall back to the default: a probe that
  // quietly measures against 15s when the operator asked for 1.5s would hide
  // the regression it was tightened to catch.
  if (!/^\d+$/.test(raw)) {
    problems.push(`${key} must be a positive whole number of milliseconds (got ${JSON.stringify(raw)})`)
    return fallback
  }
  const parsed = Number.parseInt(raw, 10)
  if (parsed <= 0) {
    problems.push(`${key} must be greater than zero (got ${JSON.stringify(raw)})`)
    return fallback
  }
  return parsed
}

/**
 * Read the probe's target from the environment, or throw one error naming
 * every problem at once — an operator wiring this up for the first time should
 * not have to discover the missing variables one run at a time.
 */
export function resolveProductionTimingTarget(env: Env): ProductionTimingTarget {
  const problems: string[] = []

  const target: ProductionTimingTarget = {
    appOrigin: readOrigin(env, PRODUCTION_TIMING_ENV.appOrigin, DEFAULT_APP_ORIGIN, problems),
    authBase: readOrigin(env, PRODUCTION_TIMING_ENV.authBase, DEFAULT_AUTH_BASE, problems),
    username: readRequired(
      env,
      PRODUCTION_TIMING_ENV.username,
      "the account the probe signs in as",
      problems,
    ),
    password: readRequired(
      env,
      PRODUCTION_TIMING_ENV.password,
      "that account's password (supply it as a secret, never in a committed file)",
      problems,
    ),
    projectId: readRequired(
      env,
      PRODUCTION_TIMING_ENV.projectId,
      "the project the probe opens and writes into",
      problems,
    ),
    loadBudgetMs: readBudget(
      env,
      PRODUCTION_TIMING_ENV.loadBudgetMs,
      DEFAULT_LOAD_BUDGET_MS,
      problems,
    ),
    writeBudgetMs: readBudget(
      env,
      PRODUCTION_TIMING_ENV.writeBudgetMs,
      DEFAULT_WRITE_BUDGET_MS,
      problems,
    ),
  }

  if (problems.length > 0) {
    throw new Error(
      [
        "The production timing probe is not configured:",
        ...problems.map((problem) => `  - ${problem}`),
        "",
        `Point ${PRODUCTION_TIMING_ENV.projectId} at a project that exists only for this`,
        "probe: the write measurement commits a timestamped marker into the first",
        "target cell of the open file. Never aim it at customer data.",
      ].join("\n"),
    )
  }

  return target
}

/** One-line summary for run logs. Never includes the password. */
export function describeProductionTimingTarget(target: ProductionTimingTarget): string {
  return [
    target.appOrigin,
    `project ${target.projectId}`,
    `as ${target.username}`,
    `budgets: load ${target.loadBudgetMs}ms, write ${target.writeBudgetMs}ms`,
  ].join(" · ")
}
