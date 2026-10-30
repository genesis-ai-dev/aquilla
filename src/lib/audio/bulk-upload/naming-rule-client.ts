// AQU-2302: the browser's side of /api/v1/import/recording-names. Only names
// and the outline go up; the answer is re-checked here with parseNamingRule
// before anything uses it.
import { AUTH_BASE } from "@/lib/frontier/auth"
import { parseNamingRule, type NamingRule, type RuleFailure } from "./naming-rule"

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
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${opts.identityToken}` },
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
  const rule = parseNamingRule(body?.rule)
  if (!rule) throw new NamingRuleError("unusable", "The assistant's rule wasn't usable")
  return rule
}

/** The team's saved rules by names' shape. Never throws: no saved rules is fine. */
export async function loadSavedNamingRules(opts: Call): Promise<Map<string, NamingRule>> {
  try {
    const response = await (opts.fetchImpl ?? fetch)(`${NAMING_RULE_URL}/saved?projectId=${encodeURIComponent(opts.projectId)}`, {
      headers: { Authorization: `Bearer ${opts.identityToken}` },
      signal: opts.signal,
    })
    if (!response.ok) return new Map()
    const body = await response.json() as { rules?: Record<string, unknown> }
    const out = new Map<string, NamingRule>()
    for (const [shape, value] of Object.entries(body.rules ?? {})) {
      const rule = parseNamingRule(value)
      if (rule) out.set(shape, rule)
    }
    return out
  } catch {
    return new Map()
  }
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

function withoutVersion(rule: NamingRule): Omit<NamingRule, "version"> {
  const { version: _version, ...rest } = rule
  return rest
}
