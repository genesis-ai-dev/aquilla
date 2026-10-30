// AQU-2302: the browser's side of /api/v1/import/recording-names. Only names
// and the outline go up; the answer is re-checked here with parseNamingRule
// before anything uses it.
import { AUTH_BASE } from "@/lib/frontier/auth"
import { isSavableRule, parseNamingRule, type NamingRule, type ProjectBooks, type RuleFailure } from "./naming-rule"

export const NAMING_RULE_URL = `${AUTH_BASE}/api/v1/import/recording-names`

/** Why the assistant gave no rule, for the sentence the preview shows. */
export type NamingRuleProblem = "limit" | "unavailable" | "unusable" | "failed"

export class NamingRuleError extends Error {
  readonly problem: NamingRuleProblem
  constructor(problem: NamingRuleProblem, message: string) {
    super(message)
    this.problem = problem
  }
}

interface Call {
  projectId: string
  identityToken: string
  fetchImpl?: typeof fetch
  signal?: AbortSignal
}

export async function askForNamingRule(opts: Call & {
  names: readonly string[]
  outline: string
  previous?: NamingRule
  failures?: readonly RuleFailure[]
}): Promise<NamingRule> {
  let response: Response
  try {
    response = await (opts.fetchImpl ?? fetch)(NAMING_RULE_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${opts.identityToken}`,
        // One key per ask: the server's paid-call guard runs a request it has
        // already answered only once (review, Oct 30).
        "Idempotency-Key": crypto.randomUUID(),
      },
      body: JSON.stringify({
        projectId: opts.projectId,
        names: opts.names,
        outline: opts.outline,
        ...(opts.previous && opts.failures?.length ? { previous: withoutVersion(opts.previous), failures: opts.failures.slice(0, 40) } : {}),
      }),
      signal: opts.signal,
    })
  } catch (e) {
    throw new NamingRuleError("failed", e instanceof Error ? e.message : String(e))
  }
  if (!response.ok) {
    const problem: NamingRuleProblem = response.status === 402 || response.status === 429 ? "limit" : response.status === 503 ? "unavailable" : "failed"
    throw new NamingRuleError(problem, `Naming rule request failed (${response.status})`)
  }
  const body = await response.json().catch(() => null) as { rule?: unknown } | null
  // Anything that goes wrong reading the answer is an unusable answer, never a
  // crash of the preview.
  let rule: NamingRule | null
  try {
    rule = parseNamingRule(body?.rule)
  } catch {
    rule = null
  }
  if (!rule) throw new NamingRuleError("unusable", "The assistant's rule wasn't usable")
  return rule
}

/**
 * The team's saved rules by names' shape. Never throws: no saved rules is fine.
 * Each entry is read on its own, so one bad entry is dropped and the rest still
 * work; a rule that leans on a constant, or on a book word that names no book
 * (read with the project's Bible files, as the server read them), is never
 * applied, even if an older version of the app saved one.
 */
export async function loadSavedNamingRules(opts: Call & { projectBooks?: ProjectBooks }): Promise<Map<string, NamingRule>> {
  let rules: unknown
  try {
    const response = await (opts.fetchImpl ?? fetch)(`${NAMING_RULE_URL}/saved?projectId=${encodeURIComponent(opts.projectId)}`, {
      headers: { Authorization: `Bearer ${opts.identityToken}` },
      signal: opts.signal,
    })
    if (!response.ok) return new Map()
    rules = ((await response.json()) as { rules?: unknown } | null)?.rules
  } catch {
    return new Map()
  }
  const out = new Map<string, NamingRule>()
  if (!rules || typeof rules !== "object" || Array.isArray(rules)) return out
  for (const [shape, value] of Object.entries(rules as Record<string, unknown>)) {
    try {
      const rule = parseNamingRule(value)
      if (rule && isSavableRule(rule, { projectBooks: opts.projectBooks })) out.set(shape, rule)
    } catch {
      // dropped; the others still apply
    }
  }
  return out
}

/** Keep a rule the person confirmed an upload with. Never throws. */
export async function saveNamingRule(opts: Call & { shapes: readonly string[]; rule: NamingRule }): Promise<boolean> {
  try {
    const response = await (opts.fetchImpl ?? fetch)(`${NAMING_RULE_URL}/saved`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${opts.identityToken}` },
      body: JSON.stringify({ projectId: opts.projectId, shapes: opts.shapes.slice(0, 5), rule: withoutVersion(opts.rule) }),
    })
    return response.ok
  } catch {
    return false
  }
}

/** Forget the team's saved rule kept under these shapes, under every shape it
 *  is kept under ("Forget this naming for the team"). Never throws; false
 *  when it wasn't forgotten. */
export async function forgetSavedNamingRule(opts: Call & { shapes: readonly string[] }): Promise<boolean> {
  try {
    const response = await (opts.fetchImpl ?? fetch)(`${NAMING_RULE_URL}/saved`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${opts.identityToken}` },
      body: JSON.stringify({ projectId: opts.projectId, shapes: opts.shapes.slice(0, 5) }),
    })
    return response.ok
  } catch {
    return false
  }
}

function withoutVersion(rule: NamingRule): Omit<NamingRule, "version"> {
  const { version: _version, ...rest } = rule
  return rest
}
